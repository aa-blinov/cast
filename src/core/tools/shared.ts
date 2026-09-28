/**
 * Shared types and small helpers used across every tool implementation
 * (bash, files, search, task) and the dispatcher in ../tools.ts. Kept in one
 * place so the individual tool modules don't have to import each other just to
 * reach a common path/size helper or the ToolResult shape.
 */

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Usage } from "../llm.ts";

export interface ToolResult {
	content: string;
	isError?: boolean;
	/** Stable error details for UIs, protocol clients, and retry policy. */
	error?: ToolError;
	/**
	 * Set by `read` when the file is an image. A `role: "tool"` message can't
	 * carry image content per the OpenAI-compatible chat API, so the loop
	 * follows it up with a separate `role: "user"` image message instead.
	 */
	imageDataUrl?: string;
	/**
	 * Tools the invoked skill removes from the model's pool for the rest of
	 * the turn (`disallowed-tools`). Set by the `skill` tool only; the loop
	 * applies it and clears it on the next user message, per the spec's
	 * "the restriction clears when you send your next message".
	 */
	skillDisallowedTools?: string[];
	/**
	 * Hooks the invoked skill registers (`hooks:` frontmatter). Set by the
	 * `skill` tool only; the loop merges them into the active set for the rest
	 * of the run, and drops a `once: true` hook after its first success.
	 */
	skillHooks?: unknown;
	/** Usage from subagent execution (task tool only). */
	subagentUsage?: Usage;
}

export type ToolErrorCode =
	| "ABORTED"
	| "CONFLICT"
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "PERMISSION_DENIED"
	| "TIMEOUT"
	| "UNAVAILABLE"
	| "EXTERNAL_ERROR"
	| "INTERNAL_ERROR";

export interface ToolError {
	code: ToolErrorCode;
	retryable: boolean;
	suggestedFix: string;
}

/** Create an error result without making callers duplicate its protocol fields. */
export function toolError(content: string, error: ToolError): ToolResult {
	return { content, isError: true, error };
}

function enrichToolResultError(result: ToolResult, error: ToolError): ToolResult {
	return { ...result, error };
}

/**
 * Backward-compatible error enrichment at the tool boundary. Existing tools
 * retain their useful textual diagnostics while every error becomes safe for
 * clients to classify without parsing a provider- or tool-specific message.
 */
export function normalizeToolResultError(result: ToolResult): ToolResult {
	if (!result.isError || result.error) return result;
	const content = result.content.toLowerCase();
	if (content.includes("[aborted]") || content.includes("cancelled") || content.includes("interrupted")) {
		return enrichToolResultError(result, {
			code: "ABORTED",
			retryable: false,
			suggestedFix: "Only restart the operation if the user still wants it to run.",
		});
	}
	if (content.includes("timeout") || content.includes("timed out")) {
		return enrichToolResultError(result, {
			code: "TIMEOUT",
			retryable: true,
			suggestedFix: "Narrow the request or increase the operation timeout before retrying.",
		});
	}
	if (content.includes("permission denied") || content.includes("not permitted") || content.includes("blocked by")) {
		return enrichToolResultError(result, {
			code: "PERMISSION_DENIED",
			retryable: false,
			suggestedFix: "Request the required permission or choose an allowed operation.",
		});
	}
	if (content.includes("not found") || content.includes("no background task")) {
		return enrichToolResultError(result, {
			code: "NOT_FOUND",
			retryable: false,
			suggestedFix: "Check the referenced name or path, then retry with an existing target.",
		});
	}
	if (
		content.includes("required") ||
		content.includes("invalid") ||
		content.includes("must be") ||
		content.includes("unknown tool")
	) {
		return enrichToolResultError(result, {
			code: "INVALID_ARGUMENT",
			retryable: false,
			suggestedFix: "Correct the tool name or arguments using the error details, then retry.",
		});
	}
	if (content.includes("not available") || content.includes("not configured")) {
		return enrichToolResultError(result, {
			code: "UNAVAILABLE",
			retryable: false,
			suggestedFix: "Enable or configure the required tool or integration before retrying.",
		});
	}
	if (content.includes("conflict") || content.includes("already exists")) {
		return enrichToolResultError(result, {
			code: "CONFLICT",
			retryable: false,
			suggestedFix: "Refresh the target state and choose a non-conflicting operation.",
		});
	}
	if (content.includes("fetch error") || content.includes("search error") || content.includes("mcp")) {
		return enrichToolResultError(result, {
			code: "EXTERNAL_ERROR",
			retryable: true,
			suggestedFix: "Retry once; if it persists, verify the external service and its configuration.",
		});
	}
	return enrichToolResultError(result, {
		code: "INTERNAL_ERROR",
		retryable: false,
		suggestedFix: "Inspect the error details and report it if the same call keeps failing.",
	});
}

/** One lifecycle vocabulary shared by the loop, TUI, SSE bridge, and history
 * reconstruction. A tool has one in-flight state and two terminal states. */
export type ToolCallStatus = "running" | "ok" | "error";
export type CompletedToolCallStatus = Exclude<ToolCallStatus, "running">;

/** Convert the executor's canonical outcome flag into the terminal UI state. */
export function completedToolCallStatus(isError?: boolean): CompletedToolCallStatus {
	return isError ? "error" : "ok";
}

export type ToolExecutor = (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
	toolCallId?: string,
) => Promise<ToolResult>;

/** Asked before running a bash command that matches a known-dangerous pattern. Return false to block it. */
/** `rule` is what an "always allow" answer saves to settings (see permissions.ts). */
export type ConfirmBash = (command: string, reason: string, rule?: string, signal?: AbortSignal) => Promise<boolean>;

/** Asked before running a destructive file operation (write/edit/patch, plus MCP
 * tools whose name starts with `mcp_`). Return false to block it. */
export type ConfirmWrite = (tool: string, path: string, reason: string) => Promise<boolean>;

/** Resolve a possibly-relative tool path argument against the agent's cwd. */
export function resolvePath(path: string, cwd: string): string {
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	if (path === "~") return homedir();
	if (isAbsolute(path)) return path;
	return resolve(cwd, path);
}

/** Shorten an absolute path to a cwd-relative one — but only when it really
 * is inside cwd.
 *
 * A bare `path.startsWith(cwd)` is true for a *sibling* whose name merely
 * begins with cwd's ("/w/proj" vs "/w/proj-extra"), and slicing
 * `cwd.length + 1` off that produced a mangled path with the directory's name
 * chopped mid-word — `/w/proj-extra/a.ts` came back as `extra/a.ts`, which
 * resolves to nothing, so the model was handed a file path it could not read.
 * Paths outside cwd are left absolute, which is what a caller can actually use.
 */
export function relativeToCwd(path: string, cwd: string): string {
	if (path === cwd) return ".";
	const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/** Append child-process output without exceeding the tool-result byte budget. */
/**
 * Accumulates a subprocess's output as text, bounded by a byte budget.
 *
 * Stateful because decoding has to be: a pipe chunk can end mid-character, and
 * decoding each chunk on its own (`chunk.toString("utf-8")`, which this
 * replaces) turned every multibyte character straddling a 64KB boundary into
 * U+FFFD. Measured on `cat` of a file with an emoji astride each boundary:
 * all five destroyed, 15 replacement characters in the output the model then
 * reads. Any non-ASCII text in a large command output — Cyrillic, CJK, emoji,
 * a compiler's box-drawing — was corrupted this way.
 */
/**
 * Full output of a command whose result was cut to fit the model's context.
 * Truncating used to drop the rest, and the note told the model to run the
 * command again with a redirect: a slow test suite ran twice, and a command
 * with side effects did them twice. The file lets it read or grep what it
 * missed instead.
 */
const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Past this a runaway command stops filling the disk; the file says so. */
const TOOL_OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
let prunedToolOutput = false;

export function toolOutputDir(): string {
	return join(homedir(), ".cast", "tool-output");
}

/** A new file for one command's full output. Old ones are cleared once per
 *  process, so the directory can't grow without bound. */
function newToolOutputPath(): string {
	const dir = toolOutputDir();
	mkdirSync(dir, { recursive: true });
	if (!prunedToolOutput) {
		prunedToolOutput = true;
		const cutoff = Date.now() - TOOL_OUTPUT_RETENTION_MS;
		for (const name of readdirSync(dir)) {
			try {
				if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name));
			} catch {
				// Gone already, or not ours to remove: either way nothing to do.
			}
		}
	}
	return join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}.txt`);
}

/** Saves text already held in memory (a result cut by line count). */
export function saveToolOutput(text: string): string | undefined {
	try {
		const path = newToolOutputPath();
		writeFileSync(path, text.length > TOOL_OUTPUT_MAX_BYTES ? text.slice(0, TOOL_OUTPUT_MAX_BYTES) : text);
		return path;
	} catch {
		return undefined;
	}
}

export class BoundedOutput {
	private readonly decoder = new StringDecoder("utf-8");
	private text = "";
	private bytes = 0;
	private flushed = false;
	private spillBytes = 0;
	/** Raw bytes kept so far, so the file starts byte-exact even when the
	 *  cut split a character the decoder is still holding. */
	private head: Buffer[] = [];
	truncated = false;
	/** Where the whole stream went once it outgrew maxBytes (spill mode only). */
	spillPath: string | undefined;

	constructor(
		private readonly maxBytes: number,
		/** Keep what doesn't fit in a file instead of dropping it. */
		private readonly spill = false,
	) {}

	/** Everything past the budget goes to the spill file, starting with what
	 *  was already kept, so the file holds the full output. */
	private spillWrite(buffer: Buffer): void {
		if (!this.spill || this.spillBytes >= TOOL_OUTPUT_MAX_BYTES) return;
		try {
			// Appends rather than a held fd: a pty reports exit before its last
			// data, so there is no reliable moment to close one.
			if (this.spillPath === undefined) {
				const head = Buffer.concat(this.head);
				this.head = [];
				this.spillPath = newToolOutputPath();
				writeFileSync(this.spillPath, head);
				this.spillBytes += head.byteLength;
			}
			const room = TOOL_OUTPUT_MAX_BYTES - this.spillBytes;
			const part = buffer.byteLength > room ? buffer.subarray(0, room) : buffer;
			appendFileSync(this.spillPath, part);
			this.spillBytes += part.byteLength;
			if (this.spillBytes >= TOOL_OUTPUT_MAX_BYTES) {
				appendFileSync(this.spillPath, "\n[cast stopped saving here: output passed 64MB]\n");
			}
		} catch {
			// A full disk or a read-only home: the result is still truncated
			// as before, just without the file.
			this.spillPath = undefined;
			this.spillBytes = TOOL_OUTPUT_MAX_BYTES;
		}
	}

	append(chunk: Buffer | string): void {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
		const remaining = this.maxBytes - this.bytes;
		if (remaining <= 0) {
			this.truncated = true;
			this.spillWrite(buffer);
			return;
		}
		if (buffer.byteLength <= remaining) {
			if (this.spill) this.head.push(buffer);
			this.bytes += buffer.byteLength;
			this.text += this.decoder.write(buffer);
			return;
		}
		// Cut on the budget, then let the decoder hold whatever partial
		// character the cut left: `end()` renders it once, instead of a stray
		// U+FFFD landing in the middle of the text.
		this.bytes += remaining;
		if (this.spill) this.head.push(buffer.subarray(0, remaining));
		this.text += this.decoder.write(buffer.subarray(0, remaining));
		this.truncated = true;
		this.spillWrite(buffer.subarray(remaining));
	}

	/**
	 * The text decoded so far. Non-destructive: a partial character the decoder
	 * is still holding stays held, so this is safe to read between chunks — the
	 * live view of a background task calls it on every chunk, and flushing
	 * there would drop a U+FFFD into the middle of the text.
	 */
	snapshot(): string {
		return this.text;
	}

	/**
	 * The final text, flushing whatever partial character is left. Call once,
	 * when the process has finished: a stream that ends on an incomplete
	 * sequence would otherwise drop those bytes entirely.
	 */
	final(): string {
		if (!this.flushed) {
			this.flushed = true;
			this.text += this.decoder.end();
		}
		return this.text;
	}
}
