import { spawn } from "node:child_process";
import type { Tool } from "./llm.ts";
import { mcpServerNameFromDescription, sanitizeToolNamePart } from "./mcp.ts";
import { sandboxEnvironment } from "./sandbox.ts";
import type { ToolResult } from "./tools/shared.ts";

/** Name of the one tool that stands in for every MCP tool when code mode is on. No `mcp_` prefix: that prefix makes the
 *  loop ask for a write confirmation, and here each inner call is confirmed on its own. */
export const MCP_CODE_TOOL = "codemode";

const DEFAULT_TIMEOUT_MS = 120_000;
/** About 6000 tokens, the cap Cloudflare puts on a Code Mode answer. */
const MAX_OUTPUT_CHARS = 22_000;
const FIRST_SENTENCE_RE = /\n|\. /;
const SERVER_PREFIX_RE = /^\[[^\]]*\]\s*/;
const NON_WORD_RE = /\W/g;
const MAX_PARAM_NOTE_CHARS = 100;
/** A script that fires 50 calls at once would flood the MCP server (the bench saw request timeouts); the rest wait. */
const MAX_PARALLEL_CALLS = 8;

/** Built-in tools a script may call beside the MCP ones: they only read, so a script cannot change anything through
 *  them that a plain call could not. Everything that touches loop state (todo, plan, task, skill, ...) stays out. */
const SCRIPT_BUILTINS: Record<string, string> = {
	read: "fs",
	grep: "fs",
	glob: "fs",
	ls: "fs",
	web_fetch: "web",
	web_search: "web",
};

interface Schema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, Schema>;
	additionalProperties?: Schema | boolean;
	required?: string[];
	items?: Schema;
	enum?: unknown[];
	anyOf?: Schema[];
	oneOf?: Schema[];
}

function firstSentence(text: string | undefined, max: number): string {
	return (text ?? "").replace(SERVER_PREFIX_RE, "").split(FIRST_SENTENCE_RE)[0]?.trim().slice(0, max) ?? "";
}

function schemaToTs(s: Schema | undefined): string {
	if (!s) return "unknown";
	if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join("|");
	const alternatives = s.anyOf ?? s.oneOf;
	if (alternatives) return alternatives.map(schemaToTs).join("|");
	const type = Array.isArray(s.type) ? s.type[0] : s.type;
	if (type === "array") return `${schemaToTs(s.items)}[]`;
	if (type === "object" || s.properties) {
		const required = new Set(s.required ?? []);
		const members = Object.entries(s.properties ?? {}).map(([key, value]) => {
			const note = firstSentence(value.description, MAX_PARAM_NOTE_CHARS);
			return `${note ? `/** ${note} */ ` : ""}${key}${required.has(key) ? "" : "?"}:${schemaToTs(value)}`;
		});
		// A free-form map (`order: {id: "asc"}`): without this the model is told `{}` and guesses the values.
		if (s.additionalProperties && s.additionalProperties !== true) {
			members.push(`[key:string]:${schemaToTs(s.additionalProperties)}`);
		} else if (s.additionalProperties === true && members.length === 0) {
			members.push("[key:string]:unknown");
		}
		return `{${members.join(",")}}`;
	}
	return type === "integer" ? "number" : (type ?? "unknown");
}

/** A tool as the script sees it: `codemode.<ns>.<name>`. `tool` keeps the real name the loop dispatches on. */
export interface ScriptTool {
	ns: string;
	name: string;
	tool: Tool;
}

function identifier(text: string): string {
	return text.replace(NON_WORD_RE, "_");
}

/** MCP tools group under their server, the read-only built-ins under `fs` and `web`. */
export function scriptTools(mcps: Tool[], builtins: Tool[]): ScriptTool[] {
	const fromMcp = mcps.map((tool): ScriptTool => {
		const server = mcpServerNameFromDescription(tool.function.description);
		const marker = server ? `mcp_${sanitizeToolNamePart(server)}_` : "";
		const bare =
			marker && tool.function.name.startsWith(marker) ? tool.function.name.slice(marker.length) : tool.function.name;
		return { ns: identifier(server ?? "mcp"), name: identifier(bare), tool };
	});
	const fromBuiltins = builtins.flatMap((tool) => {
		const ns = SCRIPT_BUILTINS[tool.function.name];
		return ns ? [{ ns, name: tool.function.name, tool }] : [];
	});
	return [...fromMcp, ...fromBuiltins];
}

/** One TS signature per tool, grouped by namespace: the model reads these instead of the full JSON schemas. */
export function mcpCodeDeclarations(tools: ScriptTool[]): string {
	const byNs = new Map<string, string[]>();
	for (const { ns, name, tool } of tools) {
		const lines = byNs.get(ns) ?? [];
		lines.push(
			`  /** ${firstSentence(tool.function.description, 200)} */ ${name}(args: ${schemaToTs(tool.function.parameters as Schema)}): Promise<unknown>;`,
		);
		byNs.set(ns, lines);
	}
	const groups = [...byNs].map(([ns, lines]) => `${ns}: {\n${lines.join("\n")}\n};`);
	return `declare const codemode: {\n${groups.join("\n")}\n};`;
}

export function mcpCodeToolDefinition(tools: ScriptTool[]): Tool {
	return {
		type: "function",
		function: {
			name: MCP_CODE_TOOL,
			description: [
				"Run JavaScript that calls the connected tools and returns only what you need.",
				"The code is the body of an async function with one argument, `codemode`; `return` the value you want back.",
				"Chain calls, loop, filter and aggregate inside the code instead of one tool call per step; only the returned value (and console.log output) reaches you.",
				"The sandbox has no file system, no shell and no imports. A failed tool call throws; a result is parsed JSON when the tool returned JSON, else text.",
				"Run independent calls together with Promise.all, not one after another (up to 8 run at a time, the rest queue): a script is stopped after two minutes.",
				"Result shapes are not declared: before relying on a field of a tool you have not used yet, return a small sample (`JSON.stringify(r).slice(0, 500)`) instead of guessing.",
				"Call a tool as `await codemode.<namespace>.<tool>(args)`, always through `codemode`:",
				mcpCodeDeclarations(tools),
			].join("\n"),
			parameters: {
				type: "object",
				properties: { code: { type: "string", description: "Async function body; use `return` for the result." } },
				required: ["code"],
			},
		},
	};
}

// Runs in the child. Node's permission model (`--permission`) takes away the file system, child processes, workers
// and native addons; the network stays open, because Node 22 has no flag for it.
const RUNNER = `
const pending = new Map();
const logs = [];
let seq = 0;
const text = (x) => (typeof x === "string" ? x : JSON.stringify(x));
console.log = (...a) => { logs.push(a.map(text).join(" ")); };
const call = (name, args) => new Promise((resolve, reject) => {
	const id = ++seq;
	pending.set(id, { resolve, reject });
	process.send({ t: "call", id, name, args: args ?? {} });
});
const codemode = new Proxy({}, {
	get: (_, ns) => new Proxy({}, { get: (_, name) => (args) => call(String(ns) + "." + String(name), args) }),
});
process.on("message", async (m) => {
	if (m.t === "result") {
		const p = pending.get(m.id);
		pending.delete(m.id);
		if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
		return;
	}
	let out;
	try {
		const AsyncFunction = (async () => {}).constructor;
		const value = await new AsyncFunction("codemode", m.code)(codemode);
		out = { t: "done", value: value === undefined ? null : value, logs };
	} catch (e) {
		out = { t: "fail", error: String((e && e.stack) || e), logs };
	}
	process.send(out, () => process.exit(0));
});
`;

type ChildMessage =
	| { t: "call"; id: number; name: string; args: Record<string, unknown> }
	| { t: "done"; value: unknown; logs: string[] }
	| { t: "fail"; error: string; logs: string[] };

interface RunOptions {
	code: string;
	/** The tools the script may call; anything else is refused before it reaches `call`. */
	tools: ScriptTool[];
	/** One tool call made by the script, by the tool's real name, with the loop's permission and hook gates in front of it. */
	call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

function clip(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? `${text.slice(0, MAX_OUTPUT_CHARS)}\n--- TRUNCATED --- (calls already made were not undone; return less)`
		: text;
}

function toolValue(result: ToolResult): unknown {
	if (result.isError) throw new Error(result.content);
	try {
		return JSON.parse(result.content);
	} catch {
		return result.content;
	}
}

export function runMcpScript(opts: RunOptions): Promise<ToolResult> {
	const { code, tools, call, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
	const callable = new Map(tools.map((t) => [`${t.ns}.${t.name}`, t.tool.function.name]));
	const namespaces = [...new Set(tools.map((t) => t.ns))].join(", ");
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--permission", "-e", RUNNER], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
			env: sandboxEnvironment(process.env),
		});
		const calls: string[] = [];
		let running = 0;
		const waiting: (() => void)[] = [];
		const acquire = async (): Promise<void> => {
			if (running < MAX_PARALLEL_CALLS) running++;
			else await new Promise<void>((resolve) => waiting.push(resolve));
		};
		// The slot passes straight to the next waiter, so `running` never dips below the real number in flight.
		const release = (): void => {
			const next = waiting.shift();
			if (next) next();
			else running--;
		};
		let settled = false;
		const finish = (result: ToolResult, logs: string[] = []): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			child.kill("SIGKILL");
			const parts = [result.content];
			if (logs.length > 0) parts.push(`[console]\n${logs.join("\n")}`);
			if (calls.length > 0) parts.push(`[calls: ${calls.join(", ")}]`);
			resolve({ ...result, content: clip(parts.join("\n\n")) });
		};
		const onAbort = (): void => finish({ content: "Script cancelled.", isError: true });
		const timer = setTimeout(
			() =>
				finish({
					content: `Script timed out after ${Math.round(timeoutMs / 1000)}s having started ${calls.length} tool calls. If they ran one after another, start independent calls together with Promise.all (at most 8 run at a time) and return partial results.`,
					isError: true,
				}),
			timeoutMs,
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		child.on("error", (e) => finish({ content: `Could not start the script sandbox: ${e.message}`, isError: true }));
		child.on("exit", () => finish({ content: "Script exited without a result.", isError: true }));
		child.on("message", async (raw) => {
			const m = raw as ChildMessage;
			if (m.t === "done") {
				finish({ content: typeof m.value === "string" ? m.value : JSON.stringify(m.value, null, 2) }, m.logs);
			} else if (m.t === "fail") {
				finish({ content: m.error, isError: true }, m.logs);
			} else if (m.t === "call") {
				calls.push(m.name);
				let reply: { ok: true; value: unknown } | { ok: false; error: string };
				try {
					const real = callable.get(m.name);
					if (!real)
						throw new Error(
							`Unknown tool "${m.name}". Call codemode.<namespace>.<tool>; namespaces: ${namespaces}.`,
						);
					await acquire();
					try {
						reply = { ok: true, value: toolValue(await call(real, m.args)) };
					} finally {
						release();
					}
				} catch (e) {
					reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
				}
				if (!settled) child.send({ t: "result", id: m.id, ...reply });
			}
		});
		child.send({ t: "code", code });
	});
}
