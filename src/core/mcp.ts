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
import { Agent } from "undici";
import { matchesToolsAllowlist } from "./frontmatter.ts";
import type { Tool } from "./llm.ts";
import type { ToolResult } from "./tools.ts";

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

export interface McpConnection {
	serverName: string;
	toolCount: number;
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
): Promise<McpSetupResult> {
	const toolIndex = new Map<string, McpToolHandle>();
	const toolDefinitions: Tool[] = [];
	const connections: McpConnection[] = [];
	const diagnostics: string[] = [];
	// Built before the connects so a server's disconnect handler can hand the
	// live result to the reconnect scheduler — it swaps that server's tools in
	// place, which every holder of this object then picks up.
	const setupResult: McpSetupResult = {
		toolIndex,
		toolDefinitions,
		connections,
		diagnostics,
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
				diagnostics.push(
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
				const tools = await listMcpTools(client, connectTimeoutMs);

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
					const clash = toolIndex.get(name);
					if (clash) {
						const owner = MCP_DESCRIPTION_SERVER_RE.exec(clash.definition.function.description ?? "")?.[1];
						diagnostics.push(
							`mcp tool name collision: "${serverName}"/"${t.name}" maps to "${name}", already provided by ${
								owner ? `"${owner}"` : "another server"
							} — keeping the first; the second is unavailable.`,
						);
						continue;
					}
					toolDefinitions.push(definition);
					toolIndex.set(name, {
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
								const result = await client.callTool({ name: t.name, arguments: args }, undefined, { signal });
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

								return {
									content: result.isError
										? `MCP server "${serverName}", tool "${t.name}" reported an error:\n${fragments.join("\n") || "(no details provided)"}`
										: fragments.join("\n") || "(no output)",
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

				const connection: McpConnection = {
					serverName,
					toolCount: tools.length,
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
					console.error(`[cast] mcp server "${serverName}" disconnected: ${reason} — retrying.`);
					scheduleMcpReconnect(setupResult, connection);
				};
				client.onclose = () => markDead("the connection closed");
				client.onerror = (error: unknown) =>
					markDead(error instanceof Error ? error.message : String(error) || "transport error");
				connectionRef.value = connection;
				connections.push(connection);
			} catch (error) {
				diagnostics.push(`mcp server "${serverName}": ${error instanceof Error ? error.message : String(error)}`);
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
	for (const c of servers) {
		lines.push(`  <server name="${escapeXml(c.serverName)}" tools="${c.toolCount}">`);
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
/** 1s, 2s, 4s, 8s, 16s. Backing off matters because a server that crashes on
 *  startup would otherwise be respawned in a tight loop. */
const MCP_RECONNECT_BASE_MS = 1000;

/**
 * Rebuilds one dropped server's connection in place, leaving every other
 * server alone.
 *
 * The existing `/mcp reconnect` closes and re-resolves *all* servers, which is
 * fine as a user-initiated action but far too blunt for an automatic retry:
 * one flaky server would take the rest down with it on every attempt.
 *
 * Returns true when the server is connected again. The result object is
 * mutated in place — its tool index, definitions and connection entry are all
 * swapped over — so every holder of it (the system prompt builder, the tool
 * dispatcher) sees the new tools without being re-plumbed.
 */
export async function reconnectMcpServer(result: McpSetupResult, serverName: string): Promise<boolean> {
	const index = result.connections.findIndex((c) => c.serverName === serverName);
	const previous = result.connections[index];
	if (!previous) return false;
	previous.closing = true;
	if (previous.retry?.timer) clearTimeout(previous.retry.timer);
	await closeClient(previous.client);

	const fresh = await connectMcpServers({ [serverName]: previous.config });
	const connection = fresh.connections[0];
	if (!connection) {
		// Keep the dead entry so the failure stays visible in /mcp rather than
		// the server quietly vanishing from the list.
		previous.closing = false;
		result.diagnostics.push(...fresh.diagnostics);
		return false;
	}

	// Swap this server's tools; leave the others untouched.
	const prefix = `[${serverName}]`;
	for (const [name, handle] of [...result.toolIndex]) {
		if (handle.definition.function.description?.startsWith(prefix)) result.toolIndex.delete(name);
	}
	result.toolDefinitions = result.toolDefinitions.filter((t) => !t.function.description?.startsWith(prefix));
	for (const [name, handle] of fresh.toolIndex) result.toolIndex.set(name, handle);
	result.toolDefinitions.push(...fresh.toolDefinitions);
	result.connections[index] = connection;
	return true;
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
