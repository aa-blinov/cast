/**
 * Shared types and small helpers used across every tool implementation
 * (bash, files, search, task) and the dispatcher in ../tools.ts. Kept in one
 * place so the individual tool modules don't have to import each other just to
 * reach a common path/size helper or the ToolResult shape.
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
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
export type ConfirmBash = (command: string, reason: string) => Promise<boolean>;

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
export function appendBoundedOutput(
	current: string,
	chunk: Buffer,
	maxBytes: number,
): { output: string; truncated: boolean } {
	const remaining = maxBytes - Buffer.byteLength(current, "utf-8");
	if (remaining <= 0) return { output: current, truncated: true };
	if (chunk.byteLength <= remaining) return { output: current + chunk.toString("utf-8"), truncated: false };
	return { output: current + chunk.subarray(0, remaining).toString("utf-8"), truncated: true };
}
