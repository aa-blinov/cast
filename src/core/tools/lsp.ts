/**
 * The `lsp` tool (navigation and diagnostics from the project's language
 * servers) and the diagnostics appended to `edit`/`write` results.
 *
 * Positions are 1-based in and out, the way editors and the `read` tool show
 * them; LSP itself is 0-based. Results are text, not JSON: `path:line:col`
 * plus the line of code there, grouped by file, bounded.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LspClient, LspDiagnostic } from "../lsp/client.ts";
import {
	allDiagnostics,
	clientsFor,
	diagnosticsFor,
	fileUri,
	lspEnabled,
	lspStatus,
	openClientsFor,
	touchFile,
} from "../lsp/index.ts";
import { BUILTIN_SERVERS, handlesFile } from "../lsp/servers.ts";
import type { ToolResult } from "./shared.ts";

export const LSP_OPERATIONS = [
	"goToDefinition",
	"goToTypeDefinition",
	"goToImplementation",
	"findReferences",
	"hover",
	"documentSymbol",
	"workspaceSymbol",
	"prepareCallHierarchy",
	"incomingCalls",
	"outgoingCalls",
	"diagnostics",
] as const;
type Operation = (typeof LSP_OPERATIONS)[number];

const MAX_LOCATIONS = 100;
const MAX_RESULT_CHARS = 16_000;
const MAX_SYMBOLS = 50;
const MAX_ERRORS_PER_FILE = 20;
const MAX_OTHER_FILES = 5;
const TOOL_TIMEOUT_MS = 60_000;

interface Position {
	line: number;
	character: number;
}
interface Range {
	start: Position;
	end: Position;
}
interface Location {
	uri: string;
	range: Range;
}

const SYMBOL_KINDS = [
	"",
	"File",
	"Module",
	"Namespace",
	"Package",
	"Class",
	"Method",
	"Property",
	"Field",
	"Constructor",
	"Enum",
	"Interface",
	"Function",
	"Variable",
	"Constant",
	"String",
	"Number",
	"Boolean",
	"Array",
	"Object",
	"Key",
	"Null",
	"EnumMember",
	"Struct",
	"Event",
	"Operator",
	"TypeParameter",
];
const NEWLINES_RE = /\s*\n\s*/g;
const SEVERITY = ["", "ERROR", "WARN", "INFO", "HINT"];

function displayPath(uri: string, cwd: string): string {
	if (!uri.startsWith("file:")) return uri;
	const path = fileURLToPath(uri);
	const rel = relative(cwd, path);
	return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

const lineCache = new Map<string, string[]>();
function codeLine(uri: string, line: number): string {
	if (!uri.startsWith("file:")) return "";
	const path = fileURLToPath(uri);
	let lines = lineCache.get(path);
	if (!lines) {
		try {
			lines = readFileSync(path, "utf-8").split("\n");
		} catch {
			lines = [];
		}
		lineCache.set(path, lines);
	}
	const text = (lines[line] ?? "").trim();
	return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** Location, Location[], LocationLink[] or null, as a flat list. */
function toLocations(result: unknown): Location[] {
	if (!result) return [];
	const items = Array.isArray(result) ? result : [result];
	const out: Location[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const o = item as Record<string, unknown>;
		if (typeof o.targetUri === "string") {
			out.push({ uri: o.targetUri, range: (o.targetSelectionRange ?? o.targetRange) as Range });
		} else if (typeof o.uri === "string" && o.range) out.push({ uri: o.uri, range: o.range as Range });
	}
	return out;
}

function renderLocations(locations: Location[], cwd: string): string {
	const seen = new Set<string>();
	const unique = locations.filter((l) => {
		const key = `${l.uri}:${l.range.start.line}:${l.range.start.character}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (unique.length === 0) return "No results.";
	// Grouped by file, files in the order the server first named them.
	const order = [...new Set(unique.map((l) => l.uri))];
	unique.sort((a, b) => order.indexOf(a.uri) - order.indexOf(b.uri) || a.range.start.line - b.range.start.line);
	const shown = unique.slice(0, MAX_LOCATIONS);
	const lines = shown.map((l) => {
		const at = `${displayPath(l.uri, cwd)}:${l.range.start.line + 1}:${l.range.start.character + 1}`;
		const code = codeLine(l.uri, l.range.start.line);
		return code ? `${at}  ${code}` : at;
	});
	const omitted = unique.length - shown.length;
	if (omitted > 0)
		lines.push(`… ${omitted} more location${omitted === 1 ? "" : "s"} omitted (limit ${MAX_LOCATIONS}).`);
	return lines.join("\n");
}

function renderHover(result: unknown): string | undefined {
	if (!result || typeof result !== "object") return undefined;
	const contents = (result as { contents?: unknown }).contents;
	const one = (c: unknown): string => {
		if (typeof c === "string") return c;
		if (c && typeof c === "object") {
			const o = c as { value?: string; language?: string; kind?: string };
			if (o.language) return `\`\`\`${o.language}\n${o.value ?? ""}\n\`\`\``;
			return o.value ?? "";
		}
		return "";
	};
	const text = (Array.isArray(contents) ? contents.map(one).join("\n\n") : one(contents)).trim();
	return text || undefined;
}

interface DocumentSymbol {
	name: string;
	kind: number;
	range: Range;
	selectionRange?: Range;
	children?: DocumentSymbol[];
	location?: Location;
	containerName?: string;
}

function renderDocumentSymbols(symbols: DocumentSymbol[], out: string[], depth = 0): void {
	for (const s of symbols) {
		const range = s.range ?? s.location?.range;
		const lines = range ? `${range.start.line + 1}-${range.end.line + 1}` : "";
		out.push(`${"  ".repeat(depth)}${SYMBOL_KINDS[s.kind] ?? "Symbol"} ${s.name}${lines ? ` (lines ${lines})` : ""}`);
		if (s.children?.length) renderDocumentSymbols(s.children, out, depth + 1);
	}
}

export function formatDiagnostic(d: LspDiagnostic): string {
	const sev = SEVERITY[d.severity ?? 1] ?? "ERROR";
	const tag = [d.source, d.code].filter((part) => part !== undefined && part !== "").join(" ");
	const code = tag ? ` (${tag})` : "";
	return `${sev} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message.replace(NEWLINES_RE, " ")}${code}`;
}

function cap(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	const note = `\n… truncated (limit ${MAX_RESULT_CHARS} characters).`;
	return text.slice(0, MAX_RESULT_CHARS - note.length) + note;
}

/** Why a file has no server: nothing handles it, or the ones that do won't start. */
function noServerMessage(path: string): string {
	const ext = path.slice(path.lastIndexOf("."));
	const candidates = BUILTIN_SERVERS.filter((d) => handlesFile(d, path)).map((d) => d.id);
	if (candidates.length === 0) return `No language server handles ${ext} files. Use grep/read instead.`;
	const reasons = lspStatus()
		.unavailable.filter((u) => candidates.includes(u.id))
		.map((u) => `${u.id}: ${u.reason}`);
	return `No language server is available for ${ext} files (${reasons.length ? reasons.join("; ") : candidates.join(", ")}). Use grep/read instead.`;
}

function positionArg(args: Record<string, unknown>, name: "line" | "character"): number | string {
	const v = args[name];
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
		return `Error: "${name}" must be a positive integer (1-based).`;
	return v - 1;
}

async function firstNonEmpty<T>(
	clients: LspClient[],
	run: (c: LspClient) => Promise<T>,
	empty: (v: T) => boolean,
): Promise<T[]> {
	const results = await Promise.all(clients.map((c) => run(c).catch(() => undefined)));
	return results.filter((r): r is Awaited<T> => r !== undefined && !empty(r as T)) as T[];
}

/** Runs the query; a server that died under it is restarted and asked once more. */
export async function execLsp(args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	const used: LspClient[] = [];
	const first = await queryLsp(args, cwd, signal, used);
	if (!used.some((c) => !c.alive) || signal?.aborted) return first;
	return queryLsp(args, cwd, signal, []);
}

async function queryLsp(
	args: Record<string, unknown>,
	cwd: string,
	signal: AbortSignal | undefined,
	used: LspClient[],
): Promise<ToolResult> {
	if (!lspEnabled()) return { content: "Language servers are turned off (the `lsp` setting).", isError: true };
	const operation = args.operation as Operation;
	if (!LSP_OPERATIONS.includes(operation)) {
		return { content: `Error: "operation" must be one of ${LSP_OPERATIONS.join(", ")}.`, isError: true };
	}
	const filePath = typeof args.file_path === "string" ? args.file_path : "";
	if (!filePath.trim()) return { content: 'Error: "file_path" is required.', isError: true };
	const path = resolve(cwd, filePath);
	if (!existsSync(path)) return { content: `File not found: ${filePath}`, isError: true };
	lineCache.clear();

	const deadline = AbortSignal.timeout(TOOL_TIMEOUT_MS);
	const sig = signal ? AbortSignal.any([signal, deadline]) : deadline;
	// A file the server hasn't seen yet needs its project loaded before a
	// query means anything; waiting for its diagnostics is that signal.
	const firstLook = openClientsFor(path).length === 0;
	const clients = await touchFile(path, cwd, firstLook || operation === "diagnostics");
	if (clients.length === 0) return { content: noServerMessage(path), isError: true };
	used.push(...clients);
	const uri = fileUri(path);

	if (operation === "diagnostics") {
		const found = diagnosticsFor(path, clients);
		if (found.length === 0) return { content: `No diagnostics in ${displayPath(uri, cwd)}.` };
		const sorted = [...found].sort(
			(a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line,
		);
		return { content: cap(`${displayPath(uri, cwd)}:\n${sorted.map(formatDiagnostic).join("\n")}`) };
	}

	if (operation === "workspaceSymbol") {
		const query = typeof args.query === "string" ? args.query : "";
		const results = await firstNonEmpty(
			clients,
			(c) =>
				c.request<Array<{ name: string; kind: number; location: Location; containerName?: string }>>(
					"workspace/symbol",
					{ query },
					undefined,
					sig,
				),
			(r) => !r?.length,
		);
		const all = results.flat();
		if (all.length === 0) return { content: "No results." };
		const lines = all.slice(0, MAX_SYMBOLS).map((s) => {
			const loc = toLocations(s.location)[0];
			const at = loc
				? `${displayPath(loc.uri, cwd)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`
				: "";
			return `${SYMBOL_KINDS[s.kind] ?? "Symbol"} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ""}  ${at}`;
		});
		if (all.length > MAX_SYMBOLS)
			lines.push(`… ${all.length - MAX_SYMBOLS} more omitted (limit ${MAX_SYMBOLS}); narrow the query.`);
		return { content: cap(lines.join("\n")) };
	}

	if (operation === "documentSymbol") {
		const results = await firstNonEmpty(
			clients,
			(c) => c.request<DocumentSymbol[]>("textDocument/documentSymbol", { textDocument: { uri } }, undefined, sig),
			(r) => !r?.length,
		);
		if (!results[0]) return { content: "No symbols." };
		const out: string[] = [];
		renderDocumentSymbols(results[0], out);
		return { content: cap(out.join("\n")) };
	}

	const line = positionArg(args, "line");
	if (typeof line === "string") return { content: line, isError: true };
	const character = positionArg(args, "character");
	if (typeof character === "string") return { content: character, isError: true };
	const position = { line, character };
	const at = { textDocument: { uri }, position };

	if (operation === "hover") {
		const results = await firstNonEmpty(
			clients,
			(c) => c.request("textDocument/hover", at, undefined, sig),
			(r) => !renderHover(r),
		);
		const text = results.map(renderHover).filter(Boolean).join("\n\n---\n\n");
		return { content: text ? cap(text) : "No hover information." };
	}

	const locationMethods: Partial<Record<Operation, [string, Record<string, unknown>]>> = {
		goToDefinition: ["textDocument/definition", at],
		goToTypeDefinition: ["textDocument/typeDefinition", at],
		goToImplementation: ["textDocument/implementation", at],
		findReferences: ["textDocument/references", { ...at, context: { includeDeclaration: true } }],
	};
	const method = locationMethods[operation];
	if (method) {
		const results = await Promise.all(
			clients.map((c) => c.request(method[0], method[1], undefined, sig).catch(() => null)),
		);
		return { content: cap(renderLocations(results.flatMap(toLocations), cwd)) };
	}

	// Call hierarchy: the item at the cursor, then who calls it / what it calls.
	type Item = { name: string; kind: number; uri: string; range: Range; selectionRange: Range; detail?: string };
	for (const client of clients) {
		// biome-ignore lint/performance/noAwaitInLoops: the first server with an item answers; the rest aren't asked
		const items = await client
			.request<Item[] | null>("textDocument/prepareCallHierarchy", at, undefined, sig)
			.catch(() => null);
		if (!items?.length) continue;
		const item = items[0]!;
		const where = (i: Item) =>
			`${displayPath(i.uri, cwd)}:${i.selectionRange.start.line + 1}:${i.selectionRange.start.character + 1}`;
		if (operation === "prepareCallHierarchy") {
			return {
				content: items
					.map(
						(i) =>
							`${SYMBOL_KINDS[i.kind] ?? "Symbol"} ${i.name}${i.detail ? ` — ${i.detail}` : ""}  ${where(i)}`,
					)
					.join("\n"),
			};
		}
		const incoming = operation === "incomingCalls";
		const calls = await client
			.request<Array<{ from?: Item; to?: Item; fromRanges: Range[] }> | null>(
				incoming ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls",
				{ item },
				undefined,
				sig,
			)
			.catch(() => null);
		if (!calls?.length) return { content: incoming ? `Nothing calls ${item.name}.` : `${item.name} calls nothing.` };
		const lines = calls.slice(0, MAX_LOCATIONS).map((call) => {
			const other = (incoming ? call.from : call.to)!;
			// Call sites are in the caller's file (incoming) or this one (outgoing).
			const siteUri = incoming ? other.uri : item.uri;
			const sites = call.fromRanges
				.slice(0, 5)
				.map((r) => `${r.start.line + 1}:${r.start.character + 1}`)
				.join(", ");
			const name = isAbsolute(other.name) ? displayPath(fileUri(other.name), cwd) : other.name;
			return `${SYMBOL_KINDS[other.kind] ?? "Symbol"} ${name}  ${where(other)}${sites ? `  (calls at ${displayPath(siteUri, cwd)} ${sites})` : ""}`;
		});
		return { content: cap(`${incoming ? "Called by" : "Calls"} (${item.name}):\n${lines.join("\n")}`) };
	}
	return { content: "No call hierarchy item at this position." };
}

// ============================================================================
// Diagnostics after edit/write
// ============================================================================

const isError = (d: LspDiagnostic) => (d.severity ?? 1) === 1;
const identity = (d: LspDiagnostic) => `${d.source ?? ""}\u0000${d.code ?? ""}\u0000${d.message}`;

/** What the servers already knew about a file before a change: its errors then. */
export interface DiagnosticsBefore {
	known: boolean;
	errors: Map<string, LspDiagnostic[]>;
}

/**
 * Errors per file before a change: the servers get the file as it is now and
 * report on it, so "after" can be told apart from what was already broken
 * (old errors, or the noise of a file no tsconfig covers). A file that
 * doesn't exist yet had no errors.
 */
export async function diagnosticsBefore(path: string, cwd: string): Promise<DiagnosticsBefore> {
	const errors = new Map<string, LspDiagnostic[]>();
	if (!lspEnabled()) return { known: false, errors };
	let list: LspClient[];
	try {
		list = existsSync(path) ? await touchFile(path, cwd, true) : await clientsFor(path, cwd);
	} catch {
		return { known: false, errors };
	}
	for (const [uri, items] of allDiagnostics(list)) errors.set(uri, items.filter(isError));
	const known = list.length > 0 && (!existsSync(path) || list.some((c) => c.diagnosticsFor(path) !== undefined));
	return { known, errors };
}

/** Errors in `after` that weren't in `before`: matched by message, so a shifted line still counts as old. */
function newErrors(after: LspDiagnostic[], before: LspDiagnostic[] | undefined): LspDiagnostic[] {
	if (!before) return after;
	const pool = new Map<string, number>();
	for (const d of before) pool.set(identity(d), (pool.get(identity(d)) ?? 0) + 1);
	return after.filter((d) => {
		const left = pool.get(identity(d)) ?? 0;
		if (left > 0) {
			pool.set(identity(d), left - 1);
			return false;
		}
		return true;
	});
}

function block(label: string, errors: LspDiagnostic[]): string {
	const shown = errors.slice(0, MAX_ERRORS_PER_FILE).map(formatDiagnostic);
	if (errors.length > MAX_ERRORS_PER_FILE) shown.push(`... and ${errors.length - MAX_ERRORS_PER_FILE} more`);
	return `<diagnostics file="${label}">\n${shown.join("\n")}\n</diagnostics>`;
}

/**
 * The note appended to an edit/write result: the errors the language
 * servers see after the change, new ones first. Errors that were already
 * there before the change are counted, not listed, so the model fixes what it
 * broke; when "before" is unknown every error is listed. Other files are
 * reported only for errors that appeared with this change.
 */
export async function diagnosticsAfterChange(path: string, cwd: string, before: DiagnosticsBefore): Promise<string> {
	if (!lspEnabled()) return "";
	let clients: LspClient[];
	try {
		clients = await touchFile(path, cwd, true);
	} catch {
		return "";
	}
	if (clients.length === 0) return "";
	const uri = fileUri(path);
	const label = displayPath(uri, cwd);
	const here = diagnosticsFor(path, clients).filter(isError);
	const fresh = before.known ? newErrors(here, before.errors.get(uri)) : here;
	const kept = here.length - fresh.length;
	const parts: string[] = [];
	if (fresh.length > 0) {
		parts.push(
			`\n\nLSP errors ${before.known ? "introduced by this change" : "in this file"}, please fix:\n${block(label, fresh)}`,
		);
	}
	if (kept > 0)
		parts.push(`\n(${kept} error${kept === 1 ? " was" : "s were"} already in ${label} before this change.)`);

	if (before.known) {
		const others: string[] = [];
		for (const [otherUri, items] of allDiagnostics(clients)) {
			if (otherUri === uri || others.length >= MAX_OTHER_FILES) continue;
			const added = newErrors(items.filter(isError), before.errors.get(otherUri) ?? []);
			if (added.length > 0) others.push(block(displayPath(otherUri, cwd), added));
		}
		if (others.length > 0) parts.push(`\n\nThis change broke other files:\n${others.join("\n")}`);
	}
	return parts.join("");
}

/** Starts the file's servers in the background, so the first query or edit finds them warm. */
export function warmUpLsp(path: string, cwd: string): void {
	if (!lspEnabled()) return;
	void touchFile(path, cwd, false).catch(() => {});
}
