/**
 * MCP (Model Context Protocol) client support — stdio servers, plus remote
 * (streamable HTTP) servers authenticated with a static header/token, like
 * Context7's published `{ "url": ..., "headers": { "X-API-KEY": ... } }`
 * config. Uses the official @modelcontextprotocol/sdk for the protocol
 * itself (handshake, tools/list, tools/call, both transports); this module
 * is just the thin part specific to cast: config loading, name-spacing
 * tool names per server, and converting MCP's tool/result shapes into the
 * ones tools.ts already uses (Tool for definitions, ToolResult for call
 * outcomes) so the rest of the codebase doesn't need to know MCP tools are
 * any different from the built-in ones.
 *
 * Deliberately not supporting OAuth (browser redirect, token storage/
 * refresh, local callback server) — that's a meaningfully bigger surface
 * than "send this header on every request," and static-header auth already
 * covers a lot of real remote servers (Context7 included). Worth doing if
 * something concrete needs it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Agent } from "undici";
import { matchesToolsAllowlist } from "./frontmatter.ts";
import type { Tool } from "./llm.ts";
import { maxToolOutputBytesSetting, maxToolOutputLinesSetting, mcpToolTimeoutMs } from "./settings.ts";
import type { ToolResult } from "./tools.ts";

/**
 * Bound an MCP tool's text the way bash and ssh output is bounded.
 *
 * Nothing capped it: a server that answers with its whole result set put all
 * of it straight into the context. Measured with a stub server returning 5MB —
 * about 1.3M tokens, from one tool call — where the same bytes out of bash
 * would have been cut at maxToolOutputBytes (128KB by default). The caps are
 * the user's existing tool-output settings, so raising them raises this too.
 */
const TRAILING_REPLACEMENT_CHAR_RE = /\uFFFD$/;

function capMcpText(text: string): string {
	const maxBytes = maxToolOutputBytesSetting();
	const maxLines = maxToolOutputLinesSetting();
	let out = text;
	let byteTruncated = false;
	if (Buffer.byteLength(out, "utf-8") > maxBytes) {
		// Cut on a character boundary: slicing the buffer mid-sequence would
		// leave a U+FFFD at the end of the text the model reads.
		out = Buffer.from(out, "utf-8").subarray(0, maxBytes).toString("utf-8").replace(TRAILING_REPLACEMENT_CHAR_RE, "");
		byteTruncated = true;
	}
	const lines = out.split("\n");
	let lineTruncated = false;
	if (lines.length > maxLines) {
		out = lines.slice(0, maxLines).join("\n");
		lineTruncated = true;
	}
	if (!byteTruncated && !lineTruncated) return out;
	const what = byteTruncated ? formatBytes(maxBytes) : `${maxLines} lines`;
	return `${out}\n\n[MCP output truncated at ${what}. Ask the tool for less — a narrower query, a filter, or pagination.]`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const MCP_SANITIZE_NAME_RE = /[^a-zA-Z0-9_-]/g;
const MCP_BRACKET_NAME_RE = /^\[([^\]]+)\]/;
const MCP_AMP_RE = /&/g;
const MCP_LT_RE = /</g;
const MCP_GT_RE = />/g;
const MCP_QUOTE_RE = /"/g;
const MCP_DIDNT_RESPOND_RE = /didn't respond within/;
const clientTransports = new WeakMap<Client, Transport>();

export interface McpServerConfig {
	// stdio (local process)
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	// remote (streamable HTTP), static-header auth only — no OAuth
	url?: string;
	headers?: Record<string, string>;
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
}

/** Reads a `{ "mcpServers": { "name": { "command": ..., "args": [...] } } }` file — the common MCP client config shape, so existing configs can be copy-pasted. Missing file or malformed JSON both just mean "no servers", not an error. */
export function loadMcpConfig(path: string): Record<string, McpServerConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpConfigFile;
		return parsed.mcpServers ?? {};
	} catch {
		return {};
	}
}

/** Atomically write `{ "mcpServers": … }` (tmp + rename), matching `saveSshConfig`. */
export function saveMcpConfig(path: string, servers: Record<string, McpServerConfig>): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

/** OpenAI function-calling tool names are restricted to [a-zA-Z0-9_-]; server/tool names aren't guaranteed to be. */
/** Pulls the server name back out of a tool definition's "[server] …" description. */
const MCP_DESCRIPTION_SERVER_RE = /^\[([^\]]+)]/;

export function sanitizeToolNamePart(name: string): string {
	return name.replace(MCP_SANITIZE_NAME_RE, "_");
}

export function mcpToolName(serverName: string, toolName: string): string {
	return `mcp_${sanitizeToolNamePart(serverName)}_${sanitizeToolNamePart(toolName)}`;
}

/**
 * Recovers the server name cast stamped onto an MCP tool's description
 * (`[serverName] ...`, set below where the tool definition is built) — the
 * one place a tool can be traced back to its server without re-parsing the
 * sanitized, ambiguous `mcp_<server>_<tool>` name (server/tool names may
 * themselves contain underscores, so splitting the name back apart isn't
 * reliable). Used for persona-level `mcp:` allowlists (loop.ts).
 */
export function mcpServerNameFromDescription(description: string | undefined): string | undefined {
	return description?.match(MCP_BRACKET_NAME_RE)?.[1];
}

export interface McpToolHandle {
	definition: Tool;
	call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

/** A prompt a server offers: a template a person runs as `/mcp:<server>:<name>`, not a tool the model calls. */
export interface McpPromptInfo {
	name: string;
	title?: string;
	description?: string;
	arguments: McpPromptArgument[];
}

export interface McpConnection {
	serverName: string;
	toolCount: number;
	/** The prompts the server offered when it connected (empty when it declares none). */
	prompts?: McpPromptInfo[];
	/** The server declared the `resources` capability: it has list_resources and read_resource tools beside its own. */
	resources?: boolean;
	client: Client;
	/** Cleared when the transport closes or errors — a stdio server that
	 *  crashed, an HTTP one that started refusing. Nothing used to notice:
	 *  the SDK's onerror/onclose were never subscribed, so a dead server's
	 *  tools stayed in the system prompt for the daemon's lifetime and the
	 *  model kept calling them. */
	alive: boolean;
	/** Why it went away, for the error the model sees on the next call. */
	deadReason?: string;
	/** The config this server was connected from, so a dropped connection can
	 *  be rebuilt without re-resolving every other server. */
	config: McpServerConfig;
	/** Set while cast is closing the connection deliberately (shutdown, /mcp
	 *  disable, a reconnect) — the drop is then expected and must not trigger
	 *  the automatic retry below. */
	closing?: boolean;
	/** Automatic reconnect bookkeeping; see scheduleMcpReconnect. */
	retry?: { attempts: number; timer?: NodeJS.Timeout };
}

export interface McpSetupResult {
	toolIndex: Map<string, McpToolHandle>;
	toolDefinitions: Tool[];
	connections: McpConnection[];
	diagnostics: string[];
	/** Every server name from the original config, regardless of connection
	 * success or disabled state — so the /mcp picker can show the full list. */
	allServerNames: string[];
	/** True while the real connect is still pending (deferMcp / skipConnect):
	 *  the servers are known but none of their tools exist yet. A turn started
	 *  in that window runs with no MCP tools at all, which is worth telling the
	 *  user rather than silently answering without them. */
	connectPending?: boolean;
	/** Per-server source: "global" or "project". */
	serverSources: Record<string, "global" | "project">;
}

type McpListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

// The common `npx -y <package>` config style has to resolve the package against
// the npm registry before the server process even starts — confirmed
// empirically: ~2.6s with a warm npx cache, ~12s with a cold one (fresh $HOME,
// no prior npx runs), on ordinary network conditions. 10s cut that off
// mid-resolution; 30s leaves real room without leaving a genuinely hung
// server unnoticed for too long.
const CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 1_000;

/**
 * Full parent environment for stdio MCP servers, with the config's `env`
 * winning on conflicts. The SDK's default is a safe-vars whitelist (PATH,
 * HOME, ...), which silently strips API keys the user exported in their
 * shell — a server that works when launched by hand then fails under cast
 * with no clue why. Inheriting everything adds no exposure here: the bash
 * tool already hands the model the same environment.
 */
export function buildServerEnv(cfgEnv?: Record<string, string>): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") merged[key] = value;
	}
	return { ...merged, ...cfgEnv };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	// Clear the timer once the real promise settles so a fast success doesn't
	// leave a pending timer keeping the event loop (and process exit) alive.
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function closeClient(client: Client): Promise<void> {
	await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "MCP client did not close in time").catch(() => {});
	const transport = clientTransports.get(client);
	if (transport) {
		await withTimeout(transport.close(), CLOSE_TIMEOUT_MS, "MCP transport did not close in time").catch(() => {});
		clientTransports.delete(client);
	}
}

export async function listMcpTools(
	client: Pick<Client, "listTools">,
	requestTimeoutMs: number,
): Promise<McpListedTool[]> {
	const tools: McpListedTool[] = [];
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	do {
		if (cursor && seenCursors.has(cursor)) {
			throw new Error(`tools/list returned the cursor "${cursor}" more than once`);
		}
		if (cursor) seenCursors.add(cursor);
		// biome-ignore lint/performance/noAwaitInLoops: pagination — each page's cursor depends on previous response
		const page = await client.listTools(cursor ? { cursor } : undefined, {
			timeout: requestTimeoutMs,
			maxTotalTimeout: requestTimeoutMs,
		});
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return tools;
}

/** Prompts a server may list before the rest is dropped: a menu, not an index. */
const PROMPT_MAX_LISTED = 200;

async function listMcpPrompts(client: Client, requestTimeoutMs: number): Promise<McpPromptInfo[]> {
	const out: McpPromptInfo[] = [];
	let cursor: string | undefined;
	const seen = new Set<string>();
	for (let page = 0; page < RESOURCE_MAX_PAGES && out.length < PROMPT_MAX_LISTED; page++) {
		// biome-ignore lint/performance/noAwaitInLoops: pagination — each page's cursor depends on the previous response
		const got = await client.listPrompts(cursor ? { cursor } : undefined, {
			timeout: requestTimeoutMs,
			maxTotalTimeout: requestTimeoutMs,
		});
		for (const p of got.prompts) {
			out.push({
				name: p.name,
				title: p.title,
				description: p.description,
				arguments: (p.arguments ?? []).map((a) => ({
					name: a.name,
					description: a.description,
					required: a.required,
				})),
			});
		}
		cursor = got.nextCursor;
		if (!cursor || seen.has(cursor)) break;
		seen.add(cursor);
	}
	return out.slice(0, PROMPT_MAX_LISTED);
}

/** The slash command a prompt runs as. Server and prompt names are cleaned the way tool names are, so it is one token. */
export function mcpPromptCommand(serverName: string, promptName: string): string {
	return `/mcp:${sanitizeToolNamePart(serverName)}:${sanitizeToolNamePart(promptName)}`;
}

/** `<code> [language]`: required arguments in angle brackets, optional in square, in the order the server declares. */
export function mcpPromptArgumentHint(prompt: McpPromptInfo): string | undefined {
	if (prompt.arguments.length === 0) return undefined;
	return prompt.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

export interface McpPromptCommand {
	/** `/mcp:<server>:<prompt>`, the name typed. */
	name: string;
	serverName: string;
	prompt: McpPromptInfo;
	description: string;
	takesArgs: boolean;
	argumentHint?: string;
}

/**
 * The prompts of the servers that are up, as slash commands. Two prompts that clean to the same name keep the
 * first. A server that has gone away offers none, so a command never leads to a dead connection.
 */
export function mcpPromptCommands(result: Pick<McpSetupResult, "connections">): McpPromptCommand[] {
	const out: McpPromptCommand[] = [];
	const seen = new Set<string>();
	for (const c of result.connections) {
		if (c.alive === false) continue;
		for (const prompt of c.prompts ?? []) {
			const name = mcpPromptCommand(c.serverName, prompt.name);
			if (seen.has(name)) continue;
			seen.add(name);
			out.push({
				name,
				serverName: c.serverName,
				prompt,
				description: `[${c.serverName}] ${prompt.title ?? prompt.description ?? prompt.name}`,
				takesArgs: prompt.arguments.length > 0,
				argumentHint: mcpPromptArgumentHint(prompt),
			});
		}
	}
	return out;
}

// A word is unquoted characters and quoted phrases run together, so `code="x = 1"` is one word.
const PROMPT_WORD_RE = /(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g;
const PROMPT_NAMED_RE = /^([A-Za-z_][\w-]*)=([\s\S]*)$/;

/** Drops the quotes around phrases in a word and unescapes what is inside them. */
function unquotePromptWord(raw: string): string {
	let out = "";
	let quote: string | null = null;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (quote) {
			if (ch === "\\" && i + 1 < raw.length) out += raw[++i];
			else if (ch === quote) quote = null;
			else out += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Splits what was typed after the command into words; a phrase in quotes stays one. */
function splitPromptArguments(text: string): string[] {
	return text.match(PROMPT_WORD_RE) ?? [];
}

/**
 * Turns what was typed after `/mcp:<server>:<prompt>` into the prompt's arguments. `name=value` fills that
 * argument (the value may be quoted); what is left fills the rest in the order the server declares them. A prompt
 * with one argument takes the whole remainder as it, so `/mcp:docs:review some free text` needs no quotes.
 */
export function parseMcpPromptArguments(
	prompt: McpPromptInfo,
	text: string,
): { ok: true; arguments: Record<string, string> } | { ok: false; error: string } {
	const usage = `${mcpPromptArgumentHint(prompt) ?? "(no arguments)"}`;
	const declared = new Set(prompt.arguments.map((a) => a.name));
	const given: Record<string, string> = {};
	const free: string[] = [];
	const rest = text.trim();
	if (
		prompt.arguments.length === 1 &&
		!(PROMPT_NAMED_RE.exec(rest.split(/\s/)[0] ?? "")?.[1] === prompt.arguments[0]!.name)
	) {
		if (rest) given[prompt.arguments[0]!.name] = rest;
	} else {
		for (const word of splitPromptArguments(rest)) {
			const named = /^["']/.test(word) ? null : PROMPT_NAMED_RE.exec(word);
			if (named && declared.has(named[1]!)) given[named[1]!] = unquotePromptWord(named[2]!);
			else if (named) return { ok: false, error: `Unknown argument "${named[1]}". Usage: ${usage}` };
			else free.push(unquotePromptWord(word));
		}
		for (const arg of prompt.arguments) {
			if (given[arg.name] === undefined && free.length > 0) given[arg.name] = free.shift()!;
		}
		if (free.length > 0) return { ok: false, error: `Too many arguments. Usage: ${usage}` };
	}
	const missing = prompt.arguments.filter((a) => a.required && !given[a.name]);
	if (missing.length > 0) {
		return { ok: false, error: `Missing ${missing.map((a) => a.name).join(", ")}. Usage: ${usage}` };
	}
	return { ok: true, arguments: given };
}

interface McpPromptMessage {
	role: string;
	content: McpContentPart;
}

/**
 * The text a prompt's messages become when run: the user's turns as they are, an assistant turn marked as one (a prompt
 * can seed a conversation), embedded text resources inline, anything binary or audio only noted.
 */
export function formatMcpPromptMessages(messages: McpPromptMessage[]): string {
	const one = (part: McpContentPart): string => {
		if (part.type === "text") return part.text ?? "";
		if (part.type === "resource" && part.resource) {
			return part.resource.text !== undefined
				? `[resource ${part.resource.uri}]\n${part.resource.text}`
				: `[embedded resource: ${part.resource.uri}${part.resource.mimeType ? ` (${part.resource.mimeType})` : ""}]`;
		}
		if (part.type === "resource_link" && part.uri) return `[resource link: ${part.name ?? part.uri} (${part.uri})]`;
		if (part.type === "image") return `[image omitted${part.mimeType ? `: ${part.mimeType}` : ""}]`;
		if (part.type === "audio") return `[audio omitted${part.mimeType ? `: ${part.mimeType}` : ""}]`;
		return "";
	};
	const mixed = messages.some((m) => m.role !== "user");
	return messages
		.map((m) => (mixed ? `${m.role === "assistant" ? "Assistant" : "User"}:\n${one(m.content)}` : one(m.content)))
		.filter((t) => t.trim() !== "")
		.join("\n\n");
}

/** Asks the server for a prompt with its arguments and returns the text to run, or why it could not. */
export async function getMcpPrompt(
	result: Pick<McpSetupResult, "connections">,
	command: McpPromptCommand,
	args: Record<string, string>,
	signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	const connection = result.connections.find((c) => c.serverName === command.serverName);
	if (!connection || connection.alive === false) {
		return {
			ok: false,
			error: `The MCP server "${command.serverName}" is no longer connected${connection?.deadReason ? ` (${connection.deadReason})` : ""}. Run /mcp reconnect ${command.serverName}.`,
		};
	}
	try {
		const timeout = mcpToolTimeoutMs();
		const got = await connection.client.getPrompt(
			{ name: command.prompt.name, arguments: args },
			{ signal, ...(timeout === undefined ? {} : { timeout }) },
		);
		const text = formatMcpPromptMessages(got.messages as McpPromptMessage[]).trim();
		if (!text)
			return { ok: false, error: `The prompt "${command.prompt.name}" of "${command.serverName}" came back empty.` };
		return { ok: true, text };
	} catch (error) {
		return {
			ok: false,
			error: `MCP server "${command.serverName}" prompt "${command.prompt.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Pages of resources/list or resources/templates/list followed, and entries listed, before the rest is only counted. */
const RESOURCE_MAX_PAGES = 20;
const RESOURCE_MAX_LISTED = 200;

interface ResourceEntry {
	uri: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
}

interface ResourceTemplateEntry {
	uriTemplate: string;
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

async function listAllPages<T>(
	fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<{ items: T[]; more: boolean }> {
	const items: T[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < RESOURCE_MAX_PAGES; page++) {
		// biome-ignore lint/performance/noAwaitInLoops: pagination — each page's cursor depends on the previous response
		const got = await fetchPage(cursor);
		items.push(...got.items);
		cursor = got.nextCursor;
		if (!cursor || seen.has(cursor) || items.length >= RESOURCE_MAX_LISTED) {
			return {
				items: items.slice(0, RESOURCE_MAX_LISTED),
				more: Boolean(cursor) || items.length > RESOURCE_MAX_LISTED,
			};
		}
		seen.add(cursor);
	}
	return { items, more: true };
}

const describeEntry = (entry: {
	name?: string;
	title?: string;
	description?: string;
	mimeType?: string;
	size?: number;
}) => {
	const label = entry.title ?? entry.name;
	const facts = [entry.mimeType, entry.size !== undefined ? formatBytes(entry.size) : undefined]
		.filter(Boolean)
		.join(", ");
	return [label, facts ? `(${facts})` : "", entry.description ? `— ${entry.description}` : ""]
		.filter(Boolean)
		.join(" ");
};

/** The text a model reads for resources/list and resources/templates/list: URIs first, since read_resource takes one. */
export function formatResourceListing(
	serverName: string,
	resources: ResourceEntry[],
	templates: ResourceTemplateEntry[],
	more: boolean,
): string {
	if (resources.length === 0 && templates.length === 0) return `The MCP server "${serverName}" offers no resources.`;
	const lines: string[] = [`Resources of "${serverName}" (read one with read_resource and its URI):`];
	for (const r of resources) lines.push(`- ${r.uri}  ${describeEntry(r)}`.trimEnd());
	if (templates.length > 0) {
		lines.push("", "Resource templates (fill in the {placeholders} to make a URI for read_resource):");
		for (const t of templates) lines.push(`- ${t.uriTemplate}  ${describeEntry(t)}`.trimEnd());
	}
	if (more) lines.push("", `[the server has more than the ${RESOURCE_MAX_LISTED} listed]`);
	return lines.join("\n");
}

interface ResourceContent {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

const TEXTUAL_MIME_RE =
	/^(?:text\/|application\/(?:json|xml|x-yaml|yaml|toml|javascript|x-sh|sql)\b|[^;]+\+(?:json|xml))/i;

/** A blob whose type says it is text (some servers send everything as base64): its text, or undefined when it is not. */
function textOfBlob(blob: string, mimeType: string | undefined): string | undefined {
	if (!mimeType || !TEXTUAL_MIME_RE.test(mimeType)) return undefined;
	const text = Buffer.from(blob, "base64").toString("utf-8");
	return text.includes("\u0000") || text.includes("\uFFFD") ? undefined : text;
}

/** What read_resource returns: text as it is, an image as an image, any other binary as a note of what it was. */
export function formatResourceContents(uri: string, contents: ResourceContent[]): ToolResult {
	const fragments: string[] = [];
	let image: ResourceContent | undefined;
	let extraImages = 0;
	for (const c of contents) {
		const heading = contents.length > 1 ? `[${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}]\n` : "";
		const decoded = c.text === undefined && c.blob !== undefined ? textOfBlob(c.blob, c.mimeType) : undefined;
		if (c.text !== undefined || decoded !== undefined) {
			fragments.push(`${heading}${c.text ?? decoded}`);
		} else if (c.blob !== undefined && c.mimeType?.startsWith("image/")) {
			if (!image) image = c;
			else extraImages++;
		} else if (c.blob !== undefined) {
			fragments.push(
				`${heading}[binary resource omitted: ${c.mimeType ?? "unknown type"}, ${formatBytes(Buffer.byteLength(c.blob, "base64"))}]`,
			);
		}
	}
	if (extraImages > 0) fragments.push(`[${extraImages} additional image(s) omitted]`);
	const text = capMcpText(fragments.join("\n\n"));
	return {
		content: text || (image ? `[image resource ${image.uri}]` : `The resource ${uri} is empty.`),
		imageDataUrl: image ? `data:${image.mimeType};base64,${image.blob}` : undefined,
	};
}

/**
 * Gives a server that offers resources a pair of tools for them (`mcp_<server>_list_resources` and
 * `mcp_<server>_read_resource`), in the same index as its own tools so persona allowlists, reconnects and the prompt
 * treat them like any other. A tool the server already has under one of those names wins: servers that predate
 * resource support often expose a tool of that name for the same purpose.
 */
function addResourceTools(
	result: McpSetupResult,
	serverName: string,
	client: Client,
	connectionRef: { value?: McpConnection },
): void {
	const deadServer = (): ToolResult | undefined =>
		connectionRef.value?.alive
			? undefined
			: {
					content: `The MCP server "${serverName}" is no longer connected${
						connectionRef.value?.deadReason ? ` (${connectionRef.value.deadReason})` : ""
					}. Its resources are unavailable until the user runs /mcp reconnect — do not keep retrying.`,
					isError: true,
				};
	const failed = (what: string, error: unknown): ToolResult => ({
		content: `MCP server "${serverName}" ${what} failed: ${error instanceof Error ? error.message : String(error)}. Check the server connection and the URI, then retry.`,
		isError: true,
	});
	const add = (
		toolName: string,
		description: string,
		parameters: Record<string, unknown>,
		call: McpToolHandle["call"],
	) => {
		const name = mcpToolName(serverName, toolName);
		if (result.toolIndex.has(name)) return;
		const definition: Tool = {
			type: "function",
			function: { name, description: `[${serverName}] ${description}`, parameters },
		};
		result.toolDefinitions.push(definition);
		result.toolIndex.set(name, { definition, call });
	};

	add(
		"list_resources",
		"List what this server can show you besides tools: its resources (documents, files, records) with their URIs, and its resource templates. Read one with read_resource.",
		{ type: "object", properties: {} },
		async (_args, signal): Promise<ToolResult> => {
			const dead = deadServer();
			if (dead) return dead;
			const timeout = mcpToolTimeoutMs();
			const options = { signal, ...(timeout === undefined ? {} : { timeout }) };
			try {
				const resources = await listAllPages<ResourceEntry>(async (cursor) => {
					const page = await client.listResources(cursor ? { cursor } : undefined, options);
					return { items: page.resources as ResourceEntry[], nextCursor: page.nextCursor };
				});
				// Templates are optional even for a server that has resources: a refusal to list them is not a failure.
				const templates = await listAllPages<ResourceTemplateEntry>(async (cursor) => {
					const page = await client.listResourceTemplates(cursor ? { cursor } : undefined, options);
					return { items: page.resourceTemplates as ResourceTemplateEntry[], nextCursor: page.nextCursor };
				}).catch(() => ({ items: [] as ResourceTemplateEntry[], more: false }));
				return {
					content: capMcpText(
						formatResourceListing(serverName, resources.items, templates.items, resources.more || templates.more),
					),
				};
			} catch (error) {
				return failed("resources/list", error);
			}
		},
	);

	add(
		"read_resource",
		"Read one resource by its URI, as given by list_resources (or built from one of its templates). Returns its text; an image is shown, other binary content is only described.",
		{
			type: "object",
			properties: { uri: { type: "string", description: "The resource's URI, exactly as listed" } },
			required: ["uri"],
		},
		async (args, signal): Promise<ToolResult> => {
			const uri = typeof args.uri === "string" ? args.uri.trim() : "";
			if (!uri)
				return {
					content: "Error: uri is required — the URI of a resource, as list_resources gives it.",
					isError: true,
				};
			const dead = deadServer();
			if (dead) return dead;
			try {
				const timeout = mcpToolTimeoutMs();
				const read = await client.readResource({ uri }, { signal, ...(timeout === undefined ? {} : { timeout }) });
				return formatResourceContents(uri, read.contents as ResourceContent[]);
			} catch (error) {
				return failed(`resource "${uri}"`, error);
			}
		},
	);
}

interface McpContentPart {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	description?: string;
	resource?: { uri: string; mimeType?: string; text?: string; blob?: string };
}

/**
 * Custom fetch for Streamable HTTP MCP servers that declines the transport's
 * standalone GET SSE "listening" stream (returns a synthetic 405 for GET).
 *
 * Why: the SDK opens a long-lived GET SSE stream for unsolicited server
 * messages. Node's built-in fetch (undici) serializes work on a kept-alive
 * HTTP/1.1 connection, so while that stream is held open the responses to
 * subsequent POSTs never arrive — every tool call (and the initial tools/list)
 * hangs until the SDK's 60s request timeout fires. Observed with servers that
 * accept the GET stream and keep it open (e.g. https://mcp.bitrix24.tech/mcp/);
 * confirmed that declining the stream makes the same server respond in ~400ms.
 *
 * The GET stream is optional per the MCP spec (the SDK already handles a 405 by
 * skipping it), and every request/response result still arrives on that POST's
 * own SSE body — so tools work fully. The only thing forgone is unsolicited
 * server→client notifications, which cast does not consume (it lists tools once
 * at startup). GET is used solely for this listening stream; POST/DELETE (send,
 * session terminate) pass through to the real fetch untouched.
 */
/**
 * Fetch for the legacy SSE transport: every request gets its own connection
 * (`pipelining: 0` disables keep-alive reuse). The transport holds a
 * long-lived GET /sse stream open on the same origin, and Node's default
 * undici pool serializes the JSON-RPC POSTs behind that busy connection —
 * the initialize POST then hangs forever (confirmed against Cloudflare's
 * docs server: POST times out while the stream is open, returns 202 in
 * ~300ms once it's closed). Same undici behavior mcpHttpFetch works around
 * for Streamable HTTP, different fix because here the GET must stay open.
 */
const sseAgent = new Agent({ pipelining: 0 });
function sseFetch(url: string | URL, init?: RequestInit): Promise<Response> {
	return fetch(
		url as Parameters<typeof fetch>[0],
		{
			...init,
			dispatcher: sseAgent,
		} as RequestInit,
	);
}

export function mcpHttpFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	if ((init?.method ?? "GET") === "GET") {
		return Promise.resolve(new Response(null, { status: 405, statusText: "SSE listening stream declined" }));
	}
	return fetch(url as Parameters<typeof fetch>[0], init);
}

/**
 * Connects to every configured server in parallel — one slow/hung server
 * (bad command, server that never responds) shouldn't block the others, so
 * each gets its own connect timeout and a failure here becomes a diagnostic,
 * not a thrown error that takes the rest down with it.
 */
export async function connectMcpServers(
	servers: Record<string, McpServerConfig>,
	connectTimeoutMs = CONNECT_TIMEOUT_MS,
	/** Connect into this live result instead of a new one: the disconnect handlers then act on the set the caller
	 *  holds. Reconnecting through a separate result left the handlers of the new connection tending that copy, so a
	 *  server that dropped a second time was never brought back in the real one. */
	target?: McpSetupResult,
): Promise<McpSetupResult> {
	// Built before the connects so a server's disconnect handler can hand the
	// live result to the reconnect scheduler — it swaps that server's tools in
	// place, which every holder of this object then picks up.
	const setupResult: McpSetupResult = target ?? {
		toolIndex: new Map<string, McpToolHandle>(),
		toolDefinitions: [],
		connections: [],
		diagnostics: [],
		allServerNames: Object.keys(servers),
		serverSources: {},
	};

	await Promise.all(
		Object.entries(servers).map(async ([serverName, cfg]) => {
			const client = new Client({ name: "cast", version: "1.0.0" });

			let transport: Transport;
			if (cfg.url) {
				// Streamable HTTP first; legacy SSE servers reject it below and
				// get a second connect attempt over SSEClientTransport.
				transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
					requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
					fetch: mcpHttpFetch,
				});
			} else if (cfg.command) {
				transport = new StdioClientTransport({
					command: cfg.command,
					args: cfg.args,
					env: buildServerEnv(cfg.env),
					cwd: cfg.cwd,
				});
			} else {
				setupResult.diagnostics.push(
					`mcp server "${serverName}": needs either "command" (local) or "url" (remote) in its config`,
				);
				return;
			}

			try {
				clientTransports.set(client, transport);
				try {
					await withTimeout(
						client.connect(transport),
						connectTimeoutMs,
						`didn't respond within ${connectTimeoutMs / 1000}s`,
					);
				} catch (error) {
					// Legacy SSE fallback: a server that only speaks the deprecated
					// HTTP+SSE transport
					// answers the Streamable HTTP initialize POST with an HTTP
					// error (DeepWiki's /sse: "Method Not Allowed"). Retry once
					// over SSEClientTransport. Only for url servers, and not for
					// timeouts — a hung endpoint is hung either way.
					const msg = error instanceof Error ? error.message : String(error);
					if (!cfg.url || MCP_DIDNT_RESPOND_RE.test(msg)) throw error;
					transport = new SSEClientTransport(new URL(cfg.url), {
						requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
						// POSTs go through the dedicated agent; the long-lived GET
						// stream stays on the default pool. See sseFetch.
						fetch: sseFetch,
						eventSourceInit: { fetch: (u, i) => fetch(u as Parameters<typeof fetch>[0], i) },
					});
					clientTransports.set(client, transport);
					try {
						await withTimeout(
							client.connect(transport),
							connectTimeoutMs,
							`didn't respond within ${connectTimeoutMs / 1000}s (SSE fallback)`,
						);
					} catch (sseError) {
						// Both transports failed — a genuinely broken endpoint. Show
						// both attempts; "SSE error: 404" alone points users at a
						// transport they never configured.
						const sseMsg = sseError instanceof Error ? sseError.message : String(sseError);
						// SDK errors can embed whole HTML error pages — keep the head.
						const trim = (s: string) => (s.length > 160 ? `${s.slice(0, 160)}…` : s);
						throw new Error(`Streamable HTTP: ${trim(msg)}; SSE fallback: ${trim(sseMsg)}`);
					}
				}
				// A server that offers only resources (a docs or wiki server) or only prompts has no tools/list: it answers
				// "Method not found", and that is not a failed connection.
				const tools = await listMcpTools(client, connectTimeoutMs).catch((error: unknown) => {
					if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return [];
					throw error;
				});

				// Filled in just below, once the connection object exists — the tool
				// handles close over it so a call can see the server has since died.
				const connectionRef: { value?: McpConnection } = {};
				for (const t of tools) {
					const name = mcpToolName(serverName, t.name);
					const definition: Tool = {
						type: "function",
						function: {
							name,
							description: `[${serverName}] ${t.description ?? t.name}`,
							parameters: t.inputSchema as Record<string, unknown>,
						},
					};
					// Two different (server, tool) pairs can sanitize to the same
					// name — `[^a-zA-Z0-9_-]` all becomes `_`, so a server called
					// "github.api" with tool "x" collides with "github" + "api_x".
					// The index was last-wins while the definitions kept both, so
					// the provider received duplicate function names and calls
					// silently routed to whichever server happened to connect
					// last: non-deterministic between runs, with no diagnostic.
					// Keep the first and say what was dropped.
					const clash = setupResult.toolIndex.get(name);
					if (clash) {
						const owner = MCP_DESCRIPTION_SERVER_RE.exec(clash.definition.function.description ?? "")?.[1];
						setupResult.diagnostics.push(
							`mcp tool name collision: "${serverName}"/"${t.name}" maps to "${name}", already provided by ${
								owner ? `"${owner}"` : "another server"
							} — keeping the first; the second is unavailable.`,
						);
						continue;
					}
					setupResult.toolDefinitions.push(definition);
					setupResult.toolIndex.set(name, {
						definition,
						call: async (args, signal): Promise<ToolResult> => {
							if (!connectionRef.value?.alive) {
								return {
									content: `The MCP server "${serverName}" is no longer connected${
										connectionRef.value?.deadReason ? ` (${connectionRef.value.deadReason})` : ""
									}. Its tools are unavailable until the user runs /mcp reconnect — do not keep retrying them.`,
									isError: true,
								};
							}
							try {
								// The SDK caps a call at 60s by default; a slow-but-legitimate
								// tool (a browser step, a heavy query) needs a way past that,
								// and it's read per call so a settings change applies without
								// a reconnect.
								const timeout = mcpToolTimeoutMs();
								const result = await client.callTool({ name: t.name, arguments: args }, undefined, {
									signal,
									...(timeout === undefined ? {} : { timeout }),
								});
								const parts = (result.content ?? []) as McpContentPart[];
								const fragments: string[] = [];
								let image: McpContentPart | undefined;
								let extraImages = 0;

								for (const p of parts) {
									if (p.type === "text" && p.text) {
										fragments.push(p.text);
									} else if (p.type === "image" && p.data && p.mimeType) {
										if (!image) image = p;
										else extraImages++;
									} else if (p.type === "audio" && p.mimeType) {
										fragments.push(`[audio content omitted: ${p.mimeType}]`);
									} else if (p.type === "resource_link" && p.uri) {
										const label = p.name ?? p.uri;
										fragments.push(
											`[resource link: ${label} (${p.uri})${p.description ? ` — ${p.description}` : ""}]`,
										);
									} else if (p.type === "resource" && p.resource) {
										if (p.resource.text !== undefined) {
											fragments.push(p.resource.text);
										} else {
											fragments.push(
												`[embedded resource: ${p.resource.uri}${p.resource.mimeType ? ` (${p.resource.mimeType})` : ""}]`,
											);
										}
									}
								}
								if (extraImages > 0) fragments.push(`[${extraImages} additional image(s) omitted]`);

								const text = capMcpText(fragments.join("\n"));
								return {
									content: result.isError
										? `MCP server "${serverName}", tool "${t.name}" reported an error:\n${text || "(no details provided)"}`
										: text || "(no output)",
									isError: Boolean(result.isError),
									imageDataUrl: image ? `data:${image.mimeType};base64,${image.data}` : undefined,
								};
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								return {
									content: `MCP server "${serverName}", tool "${t.name}" failed: ${message}. Check the server connection and tool arguments, then retry.`,
									isError: true,
								};
							}
						},
					});
				}

				// What the server offers besides tools. One with only tools declares no `resources` capability.
				const offersResources = Boolean(client.getServerCapabilities()?.resources);
				if (offersResources) addResourceTools(setupResult, serverName, client, connectionRef);

				// The prompts are a menu for the person, so a server that cannot list them keeps its tools and resources.
				const prompts = client.getServerCapabilities()?.prompts
					? await listMcpPrompts(client, connectTimeoutMs).catch((error: unknown) => {
							setupResult.diagnostics.push(
								`mcp server "${serverName}": could not list its prompts: ${error instanceof Error ? error.message : String(error)}`,
							);
							return [];
						})
					: [];

				const connection: McpConnection = {
					serverName,
					toolCount: tools.length,
					prompts: prompts.length > 0 ? prompts : undefined,
					resources: offersResources || undefined,
					client,
					alive: true,
					config: cfg,
				};
				// Notice when the server goes away. The SDK's own handlers are
				// no-ops unless assigned, so a crashed stdio server or an HTTP
				// endpoint that started refusing left cast advertising tools that
				// could never work again.
				const markDead = (reason: string) => {
					if (!connection.alive) return;
					connection.alive = false;
					connection.deadReason = reason;
					if (connection.closing) return;
					// The wording has to match what actually happens next —
					// saying "retrying" and then not retrying is worse than
					// either one alone.
					console.error(
						isNonRetryableMcpFailure(reason)
							? `[cast] mcp server "${serverName}" disconnected: ${reason}.`
							: `[cast] mcp server "${serverName}" disconnected: ${reason} — retrying.`,
					);
					scheduleMcpReconnect(setupResult, connection);
				};
				client.onclose = () => markDead("the connection closed");
				client.onerror = (error: unknown) =>
					markDead(error instanceof Error ? error.message : String(error) || "transport error");
				connectionRef.value = connection;
				setupResult.connections.push(connection);
			} catch (error) {
				setupResult.diagnostics.push(
					`mcp server "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
				);
				await closeClient(client);
			}
		}),
	);

	return setupResult;
}

function escapeXml(s: string): string {
	return s
		.replace(MCP_AMP_RE, "&amp;")
		.replace(MCP_LT_RE, "&lt;")
		.replace(MCP_GT_RE, "&gt;")
		.replace(MCP_QUOTE_RE, "&quot;");
}

/** Tool-name blurbs for the `/mcp` picker description line (connected servers only). */
export function mcpServerToolBlurbs(result: McpSetupResult): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of result.connections) {
		const prefix = `[${c.serverName}] `;
		const marker = `mcp_${sanitizeToolNamePart(c.serverName)}_`;
		const names: string[] = [];
		for (const t of result.toolDefinitions) {
			if (!t.function.description?.startsWith(prefix)) continue;
			const fn = t.function.name;
			names.push(fn.startsWith(marker) ? fn.slice(marker.length) : fn);
		}
		if (c.alive === false) continue;
		if (names.length > 0) out[c.serverName] = names.join(", ");
	}
	return out;
}

/** Format connected MCP servers for the system prompt as <available_mcp>.
 * Only currently enabled servers appear — disabled ones are excluded entirely.
 * If a server is configured in mcp.json but missing here, the user has
 * disabled it via /mcp; do not attempt to call its tools.
 *
 * `personaMcpAllowlist` (a persona's `mcp:` frontmatter, when set) drops
 * servers the active persona can't reach — keeps this in sync with what
 * loop.ts actually filters out of the callable tool list.
 */
export function formatMcpForPrompt(result: McpSetupResult, personaMcpAllowlist?: string[]): string {
	// A server that has since disconnected is dropped: keeping it here told the
	// model about tools that can only fail, and it would dutifully keep calling
	// them for the rest of the daemon's life. The prompt is rebuilt every turn
	// (see rebuildSystemPrompt), so this takes effect on the next one.
	const live = result.connections.filter((c) => c.alive !== false);
	const servers =
		personaMcpAllowlist !== undefined
			? live.filter((c) => matchesToolsAllowlist(c.serverName, personaMcpAllowlist))
			: live;
	if (servers.length === 0) return "";
	const lines = ["\n<available_mcp>", "  <!-- Only enabled MCP servers are listed. -->"];
	if (servers.some((c) => c.resources)) {
		lines.push(
			'  <!-- resources="true": the server also offers resources (documents, files, records); list and read them with its list_resources and read_resource tools. -->',
		);
	}
	for (const c of servers) {
		lines.push(
			`  <server name="${escapeXml(c.serverName)}" tools="${c.toolCount}"${c.resources ? ' resources="true"' : ""}>`,
		);
		for (const t of result.toolDefinitions) {
			if (t.function.description?.startsWith(`[${c.serverName}]`)) {
				lines.push(`    <tool>${escapeXml(t.function.name)}</tool>`);
			}
		}
		lines.push("  </server>");
	}
	lines.push("</available_mcp>");
	return lines.join("\n");
}

/** How many times a dropped server is re-tried before cast gives up and waits
 *  for the user. Five attempts with the backoff below spans about half a
 *  minute — long enough to ride out a server restarting itself, short enough
 *  that a genuinely broken one stops making noise. */
const MCP_RECONNECT_ATTEMPTS = 5;
/**
 * Failures no amount of retrying fixes: the endpoint answered, and its answer
 * was "no". Retrying an `Invalid authorization` five times over half a minute
 * changes nothing except the log — one real installation had 115 such lines
 * from a stale token — and hammers a service that has already refused. Same
 * reasoning as the provider retry loop, which excludes quota/billing errors.
 */
const MCP_NON_RETRYABLE_PATTERN =
	/\b(?:401|403)\b|invalid authorization|unauthorized|forbidden|invalid[ _-]?api[ _-]?key/i;

function isNonRetryableMcpFailure(reason: string): boolean {
	return MCP_NON_RETRYABLE_PATTERN.test(reason);
}
/** 1s, 2s, 4s, 8s, 16s. Backing off matters because a server that crashes on
 *  startup would otherwise be respawned in a tight loop. */
const MCP_RECONNECT_BASE_MS = 1000;

/** Take one server out of a live result: close it and forget its tools, its diagnostics and its connection. */
async function dropMcpServer(result: McpSetupResult, serverName: string): Promise<McpConnection | undefined> {
	const previous = result.connections.find((c) => c.serverName === serverName);
	if (previous) {
		previous.closing = true;
		if (previous.retry?.timer) clearTimeout(previous.retry.timer);
		await closeClient(previous.client);
		result.connections.splice(result.connections.indexOf(previous), 1);
	}
	const prefix = `[${serverName}]`;
	for (const [name, handle] of [...result.toolIndex]) {
		if (handle.definition.function.description?.startsWith(prefix)) result.toolIndex.delete(name);
	}
	result.toolDefinitions = result.toolDefinitions.filter((t) => !t.function.description?.startsWith(prefix));
	const diagnosticPrefix = `mcp server "${serverName}": `;
	for (let i = result.diagnostics.length - 1; i >= 0; i--) {
		if (result.diagnostics[i]!.startsWith(diagnosticPrefix)) result.diagnostics.splice(i, 1);
	}
	return previous;
}

/** Whether this server is up in the result right now. */
function isMcpServerUp(result: McpSetupResult, serverName: string): boolean {
	return result.connections.some((c) => c.serverName === serverName && c.alive !== false);
}

/**
 * Bring a live result in line with what the config now says, touching only the servers that differ: a server that
 * is up on the same config is left running (restarting a stateful one, a browser say, because another changed
 * would lose its state), one that is no longer wanted (disabled, removed) is closed, one that is new, changed,
 * down or named in `force` is connected afresh. The result is mutated in place, so everything holding it sees the
 * change.
 *
 * @param desired the servers that should be running: enabled ones, as the config files give them now
 * @param allNames every configured name, disabled ones too, for the list
 */
export async function syncMcpServers(
	result: McpSetupResult,
	desired: Record<string, McpServerConfig>,
	allNames: string[],
	serverSources: Record<string, "global" | "project">,
	force: ReadonlySet<string> = new Set(),
	connectTimeoutMs = CONNECT_TIMEOUT_MS,
): Promise<void> {
	const known = new Set([...result.connections.map((c) => c.serverName), ...Object.keys(desired)]);
	const toDrop: string[] = [];
	const toConnect: Record<string, McpServerConfig> = {};
	for (const name of known) {
		const cfg = desired[name];
		const live = result.connections.find((c) => c.serverName === name);
		if (!cfg) {
			toDrop.push(name);
		} else if (
			!live ||
			live.alive === false ||
			force.has(name) ||
			JSON.stringify(live.config) !== JSON.stringify(cfg)
		) {
			toDrop.push(name);
			toConnect[name] = cfg;
		}
	}
	for (const name of toDrop) {
		// biome-ignore lint/performance/noAwaitInLoops: a handful of servers, closed one after another
		await dropMcpServer(result, name);
	}
	if (Object.keys(toConnect).length > 0) await connectMcpServers(toConnect, connectTimeoutMs, result);
	result.allServerNames = [...allNames].sort((a, b) => a.localeCompare(b));
	result.serverSources = serverSources;
}

/**
 * Reconnect one server in place (a manual `/mcp reconnect` or an automatic retry), on the config it was connected
 * with. The result is mutated in place — its tool index, definitions and connection entry are all swapped over —
 * so every holder of it (the system prompt builder, the tool dispatcher) sees the new tools without being
 * re-plumbed.
 */
export async function reconnectMcpServer(result: McpSetupResult, serverName: string): Promise<boolean> {
	const previous = result.connections.find((c) => c.serverName === serverName);
	if (!previous) return false;
	const index = result.connections.indexOf(previous);
	await dropMcpServer(result, serverName);
	await connectMcpServers({ [serverName]: previous.config }, CONNECT_TIMEOUT_MS, result);
	if (isMcpServerUp(result, serverName)) return true;
	// Keep the dead entry so the failure stays visible in /mcp rather than the server quietly vanishing from the
	// list; its own retry state carries on from here.
	previous.closing = false;
	result.connections.splice(Math.min(index, result.connections.length), 0, previous);
	return false;
}

/**
 * Schedules the automatic retries for a server that dropped on its own.
 *
 * Only unexpected drops get here — a shutdown, `/mcp disable` or a manual
 * reconnect marks the connection `closing` first. Attempts are bounded and
 * backed off; after the last one cast stops and leaves the server visibly
 * disconnected, which is when `/mcp reconnect` is the right answer.
 */
function scheduleMcpReconnect(result: McpSetupResult, connection: McpConnection): void {
	if (connection.deadReason && isNonRetryableMcpFailure(connection.deadReason)) {
		console.error(
			`[cast] mcp server "${connection.serverName}" refused the connection: ${connection.deadReason}. Not retrying — fix the credentials in mcp.json, then run /mcp reconnect ${connection.serverName}.`,
		);
		return;
	}
	connection.retry ??= { attempts: 0 };
	const retry = connection.retry;
	if (retry.attempts >= MCP_RECONNECT_ATTEMPTS) {
		console.error(
			`[cast] mcp server "${connection.serverName}" did not come back after ${MCP_RECONNECT_ATTEMPTS} attempts — run /mcp reconnect ${connection.serverName} when it's ready.`,
		);
		return;
	}
	const delay = MCP_RECONNECT_BASE_MS * 2 ** retry.attempts;
	retry.attempts++;
	retry.timer = setTimeout(() => {
		void reconnectMcpServer(result, connection.serverName)
			.then((ok) => {
				if (ok) {
					console.error(`[cast] mcp server "${connection.serverName}" reconnected.`);
					return;
				}
				const current = result.connections.find((c) => c.serverName === connection.serverName);
				if (current) {
					current.retry = retry;
					scheduleMcpReconnect(result, current);
				}
			})
			.catch(() => {
				scheduleMcpReconnect(result, connection);
			});
	}, delay);
	// Never hold the process open just to retry a background connection.
	retry.timer.unref?.();
}

export async function closeMcpConnections(connections: McpConnection[]): Promise<void> {
	for (const connection of connections) {
		// Mark before closing: the transport's close handler runs during
		// closeClient below, and an expected drop must not schedule a retry.
		connection.closing = true;
		if (connection.retry?.timer) clearTimeout(connection.retry.timer);
	}
	await Promise.all(connections.map((c) => closeClient(c.client)));
}
