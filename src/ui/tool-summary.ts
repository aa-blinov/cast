import { DEFAULT_BASH_TIMEOUT_MS } from "../core/config.ts";
import { readBashTimeout } from "../core/tools/bash.ts";
import { formatTaskToolSummary } from "./task-tool-summary.ts";

// What a tool row says about its call, with no drawing in it: shared by the Ink
// transcript and the pi-tui one so the two read the same.

export type ToolSummaryModel =
	| { kind: "edit"; path: string; added: number; removed: number }
	/** `timeout` is the one that will actually apply: the call's own, or the
	 *  foreground default. Undefined means nothing will stop it — a background
	 *  task that asked for no timer. */
	| { kind: "bash"; command: string; timeoutMs?: number }
	| { kind: "read"; path: string; range: string }
	| { kind: "write"; path: string; lines: number }
	| { kind: "task"; text: string }
	| { kind: "generic"; text: string };

/**
 * Data half of the tool-call summary. edit/write get a readable file + change
 * summary instead of a truncated JSON blob; every other tool keeps the generic
 * `key=value` args. Args stream in as partial JSON, so anything that fails to
 * parse (or doesn't match the expected shape) falls back to the raw/generic
 * form — the rich view only kicks in once the call is complete.
 */
/** Exported for unit tests. */
export function parseToolSummary(name: string, args: string): ToolSummaryModel {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(args) as Record<string, unknown>;
	} catch {
		parsed = null;
	}

	if (
		parsed &&
		name === "edit" &&
		typeof parsed.filePath === "string" &&
		typeof parsed.oldString === "string" &&
		typeof parsed.newString === "string"
	) {
		const removed = parsed.oldString.length === 0 ? 0 : parsed.oldString.split("\n").length;
		const added = parsed.newString.length === 0 ? 0 : parsed.newString.split("\n").length;
		return { kind: "edit", path: parsed.filePath, added, removed };
	}

	if (parsed && name === "read" && typeof parsed.path === "string") {
		// `offset` is 1-indexed (same contract as the read tool). Omitted/0 → line 1.
		const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
		const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
		const start = offset > 0 ? offset : 1;
		const range = limit ? `${start}-${start + limit - 1}` : "all";
		return { kind: "read", path: parsed.path, range };
	}

	if (parsed && name === "write" && typeof parsed.path === "string") {
		const lines = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
		return { kind: "write", path: parsed.path, lines };
	}

	// `findReferences src/a.ts:12:5`, `workspaceSymbol "parseArgs"`.
	if (parsed && name === "lsp" && typeof parsed.operation === "string") {
		const at =
			typeof parsed.line === "number"
				? `:${parsed.line}${typeof parsed.character === "number" ? `:${parsed.character}` : ""}`
				: "";
		const target =
			parsed.operation === "workspaceSymbol" && typeof parsed.query === "string"
				? JSON.stringify(parsed.query)
				: `${typeof parsed.file_path === "string" ? parsed.file_path : ""}${at}`;
		return { kind: "generic", text: `${parsed.operation} ${target}` };
	}

	// `question` carries the whole form as JSON; a row says how many and what the first asks.
	if (parsed && name === "question" && Array.isArray(parsed.questions)) {
		const asked = parsed.questions as Array<{ question?: unknown }>;
		const first = typeof asked[0]?.question === "string" ? `: ${asked[0].question}` : "";
		return { kind: "generic", text: `${asked.length} question${asked.length === 1 ? "" : "s"}${first}` };
	}

	if (name === "task") {
		const taskText = formatTaskToolSummary(args);
		if (taskText) return { kind: "task", text: taskText };
	}

	// The raw args are the full todo list as one unindented JSON blob — fine
	// for the model (it's what gets echoed back to keep it grounded), but
	// unreadable as a terminal one-liner. "N/M done — current item" instead.
	if (parsed && name === "todo_write" && Array.isArray(parsed.todos)) {
		const todos = parsed.todos as Array<{ content?: unknown; status?: unknown }>;
		const done = todos.filter((t) => t.status === "completed").length;
		const active = todos.find((t) => t.status === "in_progress");
		const activeText = typeof active?.content === "string" ? active.content : "";
		const suffix = activeText ? ` — ${activeText.slice(0, 60)}` : "";
		return { kind: "generic", text: `${done}/${todos.length} done${suffix}` };
	}

	// A bash row carries its deadline: the reason a command is about to be cut
	// off is worth seeing before it happens, not in the [TIMED OUT] afterwards.
	// Same rules the tool applies — an explicit `timeout` wins; 0 or negative
	// counts as not asking, so the foreground default still applies; and a
	// background task that asked for nothing runs open-ended.
	if (parsed && name === "bash" && typeof parsed.command === "string") {
		const requested = typeof parsed.timeout === "number" && parsed.timeout > 0 ? parsed.timeout : undefined;
		// Read the same way the tool reads it — milliseconds converted, cap
		// applied — so the row shows the deadline that will actually fire
		// rather than the number that was asked for.
		const explicitMs = readBashTimeout(requested)?.ms;
		const background = parsed.run_in_background === true;
		return {
			kind: "bash",
			command: parsed.command,
			timeoutMs: explicitMs ?? (background ? undefined : DEFAULT_BASH_TIMEOUT_MS),
		};
	}

	// `command="ls -la /tmp"` spent a third of the row on the key and the
	// quotes. A command, a pattern or a path is self-describing: print the
	// value. Several arguments still get the `k=v` list, which is the only
	// case where the keys carry information.
	const entries = parsed ? Object.entries(parsed) : [];
	const primary =
		name === "bash" && typeof parsed?.command === "string"
			? parsed.command
			: entries.length === 1 && typeof entries[0]![1] === "string"
				? (entries[0]![1] as string)
				: undefined;
	const generic =
		primary !== undefined
			? primary
			: parsed
				? entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")
				: args.slice(0, 200);
	return { kind: "generic", text: generic };
}

/**
 * Collapse a summary to one physical line for the live region.
 *
 * Ink's `wrap="truncate"` truncates the string, but it does not remove
 * newlines: a value that already fits the terminal width comes back
 * unchanged, so a multi-line `task` assignment ("Do X\nThen Y\nReport
 * back") rendered three rows while clampStreamingBlocks had charged the tool
 * block exactly one — and a live region taller than the viewport is what
 * makes Ink stack duplicate frames into scrollback. Streaming args arrive as
 * raw text too, so a model that emits pretty-printed JSON hits this on every
 * tool call, not just `task`.
 */
const NEWLINE_RUN_RE = /\s*\n\s*/g;
/** @internal exported for unit tests */
export function oneLineSummary(text: string): string {
	return text.replace(NEWLINE_RUN_RE, " ");
}

/** Milliseconds as the shortest thing that still reads as a duration: 90s, 3m, 1h. */
export function formatTimeout(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
	if (seconds < 3600) {
		const minutes = seconds / 60;
		return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m`;
	}
	const hours = seconds / 3600;
	return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

// MCP tools are exposed to the model as "mcp_<server>_<tool>" (see
// core/mcp.ts's mcpToolName) — same prefix-strip-and-loosen treatment the
// web UI already applies (app.js's isMcpTool/mcpToolLabel), so the TUI
// doesn't show the raw underscored wire name where the web UI shows a
// readable "server – tool" label.
export function isMcpTool(name: string): boolean {
	return name.startsWith("mcp_");
}
export function mcpToolLabel(name: string): string {
	return name.slice(4).replace(/_/g, " – ");
}
