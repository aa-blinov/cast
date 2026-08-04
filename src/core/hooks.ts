/**
 * Hooks — shell commands, HTTP callbacks, MCP tool calls, or one-shot model
 * prompts that fire at agent lifecycle events. Config shape matches Claude
 * Code's official protocol (code.claude.com/docs/en/hooks) closely enough
 * that a real-world `hooks.json` — including ones shipped inside installed
 * Claude Code plugins — loads and runs unmodified.
 *
 * ## Scope — what's implemented
 *
 * Events (see `HookEvent`): full Claude Code set — PreToolUse, PostToolUse,
 * PostToolUseFailure, Notification, UserPromptSubmit, SessionStart,
 * SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop, PreCompact,
 * PostCompact, PermissionRequest, PermissionDenied, Setup, TeammateIdle,
 * TaskCreated, TaskCompleted, Elicitation, ElicitationResult, ConfigChange,
 * WorktreeCreate, WorktreeRemove, InstructionsLoaded, CwdChanged,
 * FileChanged. Plus cast-specific: UserPromptExpansion, PostToolBatch.
 *
 * Hook types (`HookCommand.type`): `command` (shell), `http` (POST),
 * `mcp_tool` (call an already-connected MCP server's tool), `prompt`
 * (one-shot model completion with structured `{"ok":true/false}` output).
 *
 * Response contract (exit code + stdout JSON), matching the official spec:
 *   - exit 2, or `{"decision":"block","reason":"..."}` on stdout — blocks.
 *   - PreToolUse only: `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"...","updatedInput":{...}}}`
 *     — `deny` blocks (same as `decision:"block"`); `updatedInput` replaces
 *     the tool call's arguments before it runs (works alongside `allow`).
 *     `ask`/`defer` are accepted but treated as `allow` — cast has no
 *     interactive escalation path to actually prompt the user mid-hook.
 *   - PostToolUse only: `{"hookSpecificOutput":{"updatedToolOutput":"..."}}`
 *     replaces the tool's result content outright (`additionalContext`
 *     appends instead, same as elsewhere).
 *   - `{"hookSpecificOutput":{"additionalContext":"..."}}` — appends context
 *     for the model but does NOT block the hook's event from proceeding.
 *     Aggregated across all hooks that set it and returned via
 *     `HookRunResult.additionalContext`.
 *   - `{"continue":false,"stopReason":"..."}` (Stop/SubagentStop only) —
 *     force the turn/subagent to end right now, overriding any block from
 *     another hook in the same run.
 *   - Any other non-zero exit is a non-blocking failure: recorded, but the
 *     run continues as if the hook had allowed it (fail-open — a broken
 *     hook must not be able to wedge or silently corrupt a session).
 *
 * ## Not implemented (and why)
 *
 *   - The `agent` hook type (spawn a subagent to verify) — `task.ts` (the
 *     subagent executor) already imports this module for `HooksFile`;
 *     importing it back here for the `agent` type would create a circular
 *     module dependency. Use `prompt` (a one-shot completion) or
 *     `mcp_tool` instead.
 *   - `PermissionRequest`'s `ask`/`defer` decisions, and `PreToolUse`'s
 *     `ask`/`defer` — both accepted as input but always resolved as `allow`
 *     (with a warning), since cast has no mid-turn interactive prompt a
 *     hook can suspend the run for.
 *   - PowerShell shell targeting (`shell: "powershell"`) — cast always
 *     uses bash. PowerShell hooks are rare and the added complexity
 *     (dual spawn paths, cygpath vs native paths, env-var syntax
 *     differences) doesn't pull its weight for a single-binary Linux-first
 *     tool.
 *   - Sandbox/SSRF guard for HTTP hooks — cast doesn't run inside a
 *     sandboxed environment. The `fetch()` call trusts the local network.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import { createClient, streamAndCollect } from "./llm.ts";
import type { McpToolHandle } from "./mcp.ts";
import { mcpToolName } from "./mcp.ts";
import { getBashResolution } from "./tools/bash.ts";

const PIPE_MATCHER_RE = /^[a-zA-Z0-9_|]+$/;

export type HookEvent =
	| "SessionStart"
	| "SessionEnd"
	| "UserPromptSubmit"
	| "UserPromptExpansion"
	| "PreToolUse"
	| "PermissionRequest"
	| "PermissionDenied"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "PostToolBatch"
	| "SubagentStart"
	| "SubagentStop"
	| "TaskCreated"
	| "TaskCompleted"
	| "PreCompact"
	| "PostCompact"
	| "InstructionsLoaded"
	| "CwdChanged"
	| "Stop"
	| "StopFailure"
	| "Notification"
	| "Setup"
	| "TeammateIdle"
	| "Elicitation"
	| "ElicitationResult"
	| "ConfigChange"
	| "WorktreeCreate"
	| "WorktreeRemove"
	| "FileChanged";

export const HOOK_EVENTS: readonly HookEvent[] = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"UserPromptExpansion",
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	"PreCompact",
	"PostCompact",
	"InstructionsLoaded",
	"CwdChanged",
	"Stop",
	"StopFailure",
	"Notification",
	"Setup",
	"TeammateIdle",
	"Elicitation",
	"ElicitationResult",
	"ConfigChange",
	"WorktreeCreate",
	"WorktreeRemove",
	"FileChanged",
];

export interface HookCommand {
	type?: "command" | "http" | "mcp_tool" | "prompt";
	command?: string;
	url?: string;
	server?: string;
	tool?: string;
	input?: Record<string, unknown>;
	prompt?: string;
	model?: string;
	timeout?: number;
	env?: Record<string, string>;
	if?: string;
	/** When true, the hook process is backgrounded — the first stdout line `{"async":true}` triggers an immediate return (non-blocking) while the process keeps running. */
	async?: boolean;
	/** Custom HTTP headers for `type: "http"` hooks. Header values support `$VAR_NAME` and `${VAR_NAME}` interpolation from process.env if the variable is listed in `allowedEnvVars`. */
	headers?: Record<string, string>;
	/** Allowlist of env var names that may be interpolated into header values. Values are sanitized to strip CR/LF/NUL. */
	allowedEnvVars?: string[];
}

export interface HookMatcherGroup {
	matcher?: string;
	hooks: HookCommand[];
	_source?: "global" | "project" | "plugin";
	_pluginRoot?: string;
	/** Plugin marketplace id (`name@marketplace`) when `_source === "plugin"`. */
	_pluginId?: string;
}

export type HooksFile = Partial<Record<HookEvent, HookMatcherGroup[]>>;

function readHooksFile(
	path: string,
	source: HookMatcherGroup["_source"],
	pluginRoot?: string,
	pluginId?: string,
): HooksFile {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as { hooks?: HooksFile } & HooksFile;
		const file = parsed.hooks ?? parsed;
		const tagged: HooksFile = {};
		for (const [event, groups] of Object.entries(file) as [HookEvent, HookMatcherGroup[] | undefined][]) {
			if (!HOOK_EVENTS.includes(event) || !groups?.length) continue;
			tagged[event] = groups.map((g) => ({ ...g, _source: source, _pluginRoot: pluginRoot, _pluginId: pluginId }));
		}
		return tagged;
	} catch {
		return {};
	}
}

function mergeHooks(...files: HooksFile[]): HooksFile {
	const out: HooksFile = {};
	for (const file of files) {
		for (const [event, groups] of Object.entries(file) as [HookEvent, HookMatcherGroup[] | undefined][]) {
			if (!groups?.length) continue;
			out[event] = [...(out[event] ?? []), ...groups];
		}
	}
	return out;
}

export function globalHooksPath(): string {
	return join(homedir(), ".cast", "hooks.json");
}

export function projectHooksPath(cwd: string): string {
	return join(cwd, ".cast", "hooks.json");
}

export interface HookDiagnostic {
	message: string;
	path: string;
}

function checkHooksFileSyntax(path: string): HookDiagnostic | undefined {
	if (!existsSync(path)) return undefined;
	try {
		JSON.parse(readFileSync(path, "utf-8"));
		return undefined;
	} catch (error) {
		return { path, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Surfaces malformed hooks.json files instead of the silent empty-config
 * fallback `readHooksFile` uses everywhere else. Deliberately a separate,
 * standalone check (not threaded into `mergeHooksFiles`/`readHooksFile`
 * themselves) — those get called fresh on every single hook firing via
 * `resolveHooksForCwd`, and logging there would spam the console once per
 * tool call for as long as the file stayed broken. This is only meant to be
 * called from the Settings-triggered `/hooks` listing, a user-initiated,
 * infrequent action.
 */
export function hooksFileDiagnostics(
	cwd: string,
	trusted: boolean,
	pluginHookFilePaths: Array<{ path: string; pluginRoot: string; pluginId: string }> = [],
): HookDiagnostic[] {
	const out: HookDiagnostic[] = [];
	const global = checkHooksFileSyntax(globalHooksPath());
	if (global) out.push(global);
	const projectPath = projectHooksPath(cwd);
	if (trusted && projectPath !== globalHooksPath()) {
		const project = checkHooksFileSyntax(projectPath);
		if (project) out.push(project);
	}
	for (const p of pluginHookFilePaths) {
		const diag = checkHooksFileSyntax(p.path);
		if (diag) out.push(diag);
	}
	return out;
}

/**
 * Content-addressed so re-resolving unchanged config yields the same id
 * across reloads (see the "stable across repeated resolves" test) — but
 * includes the source (global/project/which plugin) precisely so two
 * byte-identical hook groups from *different* sources don't collide onto
 * the same id, which would make disabling one from Settings silently
 * disable the other too.
 */
export function hookGroupId(event: HookEvent, group: HookMatcherGroup): string {
	const sourceKey = `${group._source ?? "global"}|${group._pluginId ?? group._pluginRoot ?? ""}`;
	const key = `${event}|${sourceKey}|${group.matcher ?? ""}|${JSON.stringify(group.hooks)}`;
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
	}
	return `${event.toLowerCase()}-${(hash >>> 0).toString(36)}`;
}

export interface ResolvedHookEntry {
	id: string;
	event: HookEvent;
	matcher?: string;
	commands: HookCommand[];
	source: "global" | "project" | "plugin";
	/** Plugin marketplace id (`name@marketplace`) when `source === "plugin"`. */
	pluginId?: string;
	enabled: boolean;
}

export function listHooksForCwd(
	cwd: string,
	trusted: boolean,
	pluginHookFilePaths: Array<{ path: string; pluginRoot: string; pluginId: string }> = [],
	disabledIds: ReadonlySet<string> = new Set(),
): ResolvedHookEntry[] {
	const merged = mergeHooksFiles(cwd, trusted, pluginHookFilePaths);
	const out: ResolvedHookEntry[] = [];
	for (const [event, groups] of Object.entries(merged) as [HookEvent, HookMatcherGroup[] | undefined][]) {
		for (const group of groups ?? []) {
			const id = hookGroupId(event, group);
			out.push({
				id,
				event,
				matcher: group.matcher,
				commands: group.hooks,
				source: group._source ?? "global",
				pluginId: group._pluginId,
				enabled: !disabledIds.has(id),
			});
		}
	}
	return out;
}

function mergeHooksFiles(
	cwd: string,
	trusted: boolean,
	pluginHookFilePaths: Array<{ path: string; pluginRoot: string; pluginId: string }>,
): HooksFile {
	const global = readHooksFile(globalHooksPath(), "global");
	const projectPath = projectHooksPath(cwd);
	const project = trusted && projectPath !== globalHooksPath() ? readHooksFile(projectPath, "project") : {};
	const plugins = pluginHookFilePaths.map((p) => readHooksFile(p.path, "plugin", p.pluginRoot, p.pluginId));
	return mergeHooks(global, ...plugins, project);
}

export function loadHooksForCwd(
	cwd: string,
	trusted: boolean,
	pluginHookFilePaths: Array<{ path: string; pluginRoot: string; pluginId: string }> = [],
	disabledIds: ReadonlySet<string> = new Set(),
): HooksFile {
	const merged = mergeHooksFiles(cwd, trusted, pluginHookFilePaths);
	if (disabledIds.size === 0) return merged;
	const out: HooksFile = {};
	for (const [event, groups] of Object.entries(merged) as [HookEvent, HookMatcherGroup[] | undefined][]) {
		const kept = (groups ?? []).filter((g) => !disabledIds.has(hookGroupId(event, g)));
		if (kept.length) out[event] = kept;
	}
	return out;
}

export function hasHooks(hooks: HooksFile): boolean {
	return Object.values(hooks).some((groups) => groups && groups.length > 0);
}

export interface HookRunResult {
	blocked: boolean;
	reason?: string;
	forceStop?: boolean;
	updatedInput?: Record<string, unknown>;
	updatedToolOutput?: string;
	permissionDecision?: "allow" | "deny" | "ask" | "defer";
	additionalContext?: string;
	/** PermissionRequest: the structured decision from hookSpecificOutput.decision. */
	permissionRequestResult?:
		| { behavior: "allow"; updatedInput?: Record<string, unknown> }
		| { behavior: "deny"; message?: string };
	/** PermissionDenied: hook-specific retry flag. */
	retry?: boolean;
	stdout: string;
	exitCode: number | null;
}

const DEFAULT_HOOK_TIMEOUT = 30;
const STOP_HOOK_TIMEOUT = 600;

function defaultTimeoutFor(event: HookEvent): number {
	return event === "Stop" || event === "SubagentStop" ? STOP_HOOK_TIMEOUT : DEFAULT_HOOK_TIMEOUT;
}

function killProcessGroup(proc: ChildProcess): void {
	try {
		process.kill(process.platform === "win32" ? proc.pid! : -proc.pid!, "SIGKILL");
	} catch {
		// already dead
	}
}

interface ParsedHookOutput {
	decision?: string;
	reason?: string;
	continue?: boolean;
	stopReason?: string;
	hookSpecificOutput?: {
		additionalContext?: string;
		permissionDecision?: string;
		permissionDecisionReason?: string;
		updatedInput?: Record<string, unknown>;
		updatedToolOutput?: string;
		decision?: { behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; message?: string };
		retry?: boolean;
	};
}

function tryParseJson(text: string): ParsedHookOutput | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

const RESERVED_ENV_KEYS = new Set([
	"CAST_HOOK_EVENT",
	"CAST_SESSION_ID",
	"CAST_WORKSPACE_ROOT",
	"CAST_PLUGIN_ROOT",
	"CAST_PLUGIN_DATA",
	"CLAUDE_PLUGIN_ROOT",
	"CLAUDE_PLUGIN_DATA",
]);

function buildHookEnv(
	event: HookEvent,
	cwd: string,
	sessionId: string | undefined,
	pluginRoot: string | undefined,
	userEnv: Record<string, string> | undefined,
): Record<string, string> {
	const env: Record<string, string> = { ...process.env } as Record<string, string>;
	if (userEnv) {
		for (const [k, v] of Object.entries(userEnv)) {
			if (!RESERVED_ENV_KEYS.has(k)) env[k] = v;
		}
	}
	env.CAST_HOOK_EVENT = event;
	if (sessionId) env.CAST_SESSION_ID = sessionId;
	env.CAST_WORKSPACE_ROOT = cwd;
	if (pluginRoot) {
		env.CAST_PLUGIN_ROOT = pluginRoot;
		const dataDir = join(homedir(), ".cast", "plugins", "data", pluginRoot.replace(/[^a-zA-Z0-9]/g, "_"));
		env.CAST_PLUGIN_DATA = dataDir;
		env.CLAUDE_PLUGIN_ROOT = pluginRoot;
		env.CLAUDE_PLUGIN_DATA = dataDir;
	}
	return env;
}

// ─── matcher / match-target ───

function pickMatchTarget(event: HookEvent, payload: Record<string, unknown>): string | undefined {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PermissionRequest":
		case "PermissionDenied":
			return typeof payload.tool_name === "string" ? payload.tool_name : undefined;
		case "SessionStart":
			return typeof payload.source === "string" ? payload.source : undefined;
		case "Setup":
			return typeof payload.trigger === "string" ? payload.trigger : undefined;
		case "PreCompact":
		case "PostCompact":
			return typeof payload.trigger === "string" ? payload.trigger : undefined;
		case "Notification":
			return typeof payload.notification_type === "string" ? payload.notification_type : undefined;
		case "SessionEnd":
			return typeof payload.reason === "string" ? payload.reason : undefined;
		case "StopFailure":
			return typeof payload.error === "string" ? payload.error : undefined;
		case "SubagentStart":
		case "SubagentStop":
			return typeof payload.agent_type === "string" ? payload.agent_type : undefined;
		case "Elicitation":
		case "ElicitationResult":
			return typeof payload.mcp_server_name === "string" ? payload.mcp_server_name : undefined;
		case "ConfigChange":
			return typeof payload.source === "string" ? payload.source : undefined;
		case "InstructionsLoaded":
			return typeof payload.load_reason === "string" ? payload.load_reason : undefined;
		default:
			return undefined;
	}
}

function matchesMatcher(matchTarget: string | undefined, matcher: string): boolean {
	if (!matcher || matcher === "*") return true;
	if (matchTarget === undefined) return true;
	if (PIPE_MATCHER_RE.test(matcher)) {
		const lower = matchTarget.toLowerCase();
		if (matcher.includes("|")) return matcher.split("|").some((p) => p.trim().toLowerCase() === lower);
		return matcher.toLowerCase() === lower;
	}
	try {
		return new RegExp(matcher, "i").test(matchTarget);
	} catch {
		return matcher.toLowerCase() === matchTarget.toLowerCase();
	}
}

function matchesIfCondition(ifCondition: string, payload: Record<string, unknown>): boolean {
	const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
	const m = ifCondition.match(/^(\w+)(?:\((.*)\))?$/);
	if (!m) return false;
	if (m[1].toLowerCase() !== toolName.toLowerCase()) return false;
	if (!m[2]) return true;
	const pattern = m[2].trim();
	const toolInput = payload.tool_input;
	if (typeof toolInput !== "object" || toolInput === null) return false;
	const relevant = String(
		(toolInput as Record<string, unknown>).command ??
			(toolInput as Record<string, unknown>).file_path ??
			JSON.stringify(toolInput),
	);
	try {
		return new RegExp(`^${pattern.replace(/\*/g, ".*")}$`).test(relevant);
	} catch {
		return relevant === pattern;
	}
}

function filterByIfCondition(hooks: HookCommand[], event: HookEvent, payload: Record<string, unknown>): HookCommand[] {
	const isToolEvent =
		event === "PreToolUse" ||
		event === "PostToolUse" ||
		event === "PostToolUseFailure" ||
		event === "PermissionRequest";
	return hooks.filter((cmd) => {
		if (!cmd.if) return true;
		if (!isToolEvent) return false;
		return matchesIfCondition(cmd.if, payload);
	});
}

// ─── dedup ───

function hookDedupKey(cmd: HookCommand, contextKey: string): string {
	const type = cmd.type ?? "command";
	const ifKey = cmd.if ?? "";
	if (type === "command") return `${contextKey}\0cmd\0${ifKey}\0${cmd.command ?? ""}`;
	if (type === "http") return `${contextKey}\0http\0${ifKey}\0${cmd.url ?? ""}`;
	if (type === "mcp_tool") return `${contextKey}\0mcp\0${ifKey}\0${cmd.server ?? ""}/${cmd.tool ?? ""}`;
	if (type === "prompt") return `${contextKey}\0prompt\0${ifKey}\0${cmd.prompt ?? ""}`;
	return `${contextKey}\0${ifKey}\0${type}`;
}

function deduplicateHooks(groups: HookMatcherGroup[]): HookMatcherGroup[] {
	return groups
		.map((group) => {
			const seen = new Set<string>();
			const unique: HookCommand[] = [];
			for (const cmd of group.hooks) {
				const key = hookDedupKey(cmd, group._pluginRoot ?? "");
				if (!seen.has(key)) {
					seen.add(key);
					unique.push(cmd);
				}
			}
			return { ...group, hooks: unique };
		})
		.filter((g) => g.hooks.length > 0);
}

// ─── exec helpers ───

function substitutePluginVars(command: string, pluginRoot: string | undefined): string {
	if (!pluginRoot) return command;
	const dataDir = join(homedir(), ".cast", "plugins", "data", pluginRoot.replace(/[^a-zA-Z0-9]/g, "_"));
	return command
		.replace(/\$\{CAST_PLUGIN_ROOT\}/g, pluginRoot)
		.replace(/\$\{CAST_PLUGIN_DATA\}/g, dataDir)
		.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
		.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, dataDir);
}

function runCommandHook(
	command: string,
	timeoutSeconds: number,
	cwd: string,
	env: Record<string, string>,
	payload: unknown,
	signal?: AbortSignal,
): Promise<HookRunResult> {
	const bash = getBashResolution();
	return new Promise((resolve) => {
		const proc = spawn(bash.path, ["-c", command], {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let initialResponseChecked = false;
		let asyncResolve: ((r: HookRunResult) => void) | null = null;
		const asyncPromise = new Promise<HookRunResult>((r) => {
			asyncResolve = r;
		});

		const timer = setTimeout(() => killProcessGroup(proc), timeoutSeconds * 1000);
		const onAbort = () => killProcessGroup(proc);
		signal?.addEventListener("abort", onAbort, { once: true });

		const stdoutEndPromise = new Promise<void>((r) => proc.stdout.on("end", r));
		const stderrEndPromise = new Promise<void>((r) => proc.stderr.on("end", r));

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(interpretHookOutput(stdout, stderr, exitCode));
		};

		proc.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf-8");
			if (!initialResponseChecked) {
				const firstLine = stdout.split("\n")[0]?.trim() ?? "";
				if (firstLine.includes("}")) {
					initialResponseChecked = true;
					try {
						const parsed = JSON.parse(firstLine);
						if (parsed.async === true) {
							// Background: detach the process and return immediately.
							// The hook keeps running but we don't wait for it.
							proc.stdout.removeAllListeners("data");
							proc.stderr.removeAllListeners("data");
							proc.removeAllListeners("close");
							proc.removeAllListeners("error");
							clearTimeout(timer);
							signal?.removeEventListener("abort", onAbort);
							proc.unref();
							asyncResolve?.({
								blocked: false,
								stdout: firstLine,
								exitCode: 0,
							});
						}
					} catch {
						// Not valid JSON — keep waiting.
					}
				}
			}
		});
		proc.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf-8");
		});
		proc.on("error", () => finish(null));
		proc.on("close", async (code) => {
			// Wait for both streams to end before resolving to avoid
			// the close-vs-data race (matching Claude Code's behavior).
			await Promise.all([stdoutEndPromise, stderrEndPromise]);
			finish(code);
		});
		proc.stdin.on("error", () => {});
		try {
			proc.stdin.write(JSON.stringify(payload));
		} catch {
			// hook doesn't read stdin — fine, it still runs
		}
		proc.stdin.end();

		void Promise.race([asyncPromise]).then((r) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			}
		});
	});
}

function sanitizeHeaderValue(value: string): string {
	return value.replace(/\r|\n|\0/g, "");
}

function interpolateEnvVars(value: string, allowedEnvVars: ReadonlySet<string>): string {
	return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced, unbraced) => {
		const varName = braced ?? unbraced;
		if (!allowedEnvVars.has(varName)) return "";
		return process.env[varName] ?? "";
	});
}

async function runHttpHook(
	url: string,
	timeoutSeconds: number,
	payload: unknown,
	signal?: AbortSignal,
	headers?: Record<string, string>,
	allowedEnvVars?: string[],
): Promise<HookRunResult> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
	try {
		const effectiveHeaders: Record<string, string> = { "content-type": "application/json" };
		if (headers) {
			const allowed = new Set(allowedEnvVars ?? []);
			for (const [name, value] of Object.entries(headers)) {
				effectiveHeaders[name] = sanitizeHeaderValue(interpolateEnvVars(value, allowed));
			}
		}
		const res = await fetch(url, {
			method: "POST",
			headers: effectiveHeaders,
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		const text = await res.text().catch(() => "");
		if (!res.ok) return { blocked: false, stdout: text, exitCode: res.status };
		return interpretHookOutput(text, "", 0);
	} catch {
		return { blocked: false, stdout: "", exitCode: null };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function interpolate(template: string, payload: Record<string, unknown>): string {
	return template.replace(/\$\{([a-zA-Z0-9_.]+)\}/g, (whole, path: string) => {
		const parts = path.split(".");
		let value: unknown = payload;
		for (const part of parts) {
			if (value === null || typeof value !== "object") return whole;
			value = (value as Record<string, unknown>)[part];
		}
		if (value === undefined) return whole;
		return typeof value === "string" ? value : JSON.stringify(value);
	});
}

function interpolateDeep(value: unknown, payload: Record<string, unknown>): unknown {
	if (typeof value === "string") return interpolate(value, payload);
	if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, payload));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolateDeep(v, payload);
		return out;
	}
	return value;
}

async function runMcpToolHook(
	cmd: HookCommand,
	payload: Record<string, unknown>,
	mcpToolIndex: Map<string, McpToolHandle> | undefined,
	signal?: AbortSignal,
): Promise<HookRunResult> {
	if (!cmd.server || !cmd.tool || !mcpToolIndex) {
		return { blocked: false, stdout: "", exitCode: null };
	}
	const handle = mcpToolIndex.get(mcpToolName(cmd.server, cmd.tool));
	if (!handle) return { blocked: false, stdout: "", exitCode: null };
	const args = (interpolateDeep(cmd.input ?? {}, payload) as Record<string, unknown>) ?? {};
	try {
		const result = await handle.call(args, signal);
		return interpretHookOutput(result.content, "", result.isError ? 1 : 0);
	} catch {
		return { blocked: false, stdout: "", exitCode: null };
	}
}

async function runPromptHook(
	cmd: HookCommand,
	payload: Record<string, unknown>,
	config: AppConfig | undefined,
	fallbackModel: string | undefined,
	signal?: AbortSignal,
): Promise<HookRunResult> {
	if (!cmd.prompt || !config) return { blocked: false, stdout: "", exitCode: null };
	const text = interpolate(cmd.prompt, payload);
	const model = cmd.model ?? fallbackModel;
	if (!model) return { blocked: false, stdout: "", exitCode: null };
	try {
		const client = createClient(config);
		const completion = await streamAndCollect(
			client,
			model,
			[
				{
					role: "system",
					content:
						'You are evaluating a hook in cast. Your response must be a JSON object: {"ok": true} if the condition is met, or {"ok": false, "reason": "..."} if not. Only return JSON.',
				},
				{ role: "user", content: text },
			],
			[],
			500,
			signal,
		);
		const response = (completion.content ?? "").trim();
		try {
			const parsed = JSON.parse(response);
			if (parsed.ok === false) {
				return { blocked: true, reason: parsed.reason ?? response, stdout: response, exitCode: 0 };
			}
			if (parsed.ok === true) {
				return { blocked: false, stdout: response, exitCode: 0 };
			}
		} catch {
			// JSON parse failed — fall through to non-blocking
		}
		return { blocked: false, stdout: response, exitCode: 0 };
	} catch {
		return { blocked: false, stdout: "", exitCode: null };
	}
}

function interpretHookOutput(stdout: string, stderr: string, exitCode: number | null): HookRunResult {
	const parsed = tryParseJson(stdout);
	const forceStop = parsed?.continue === false;
	const blockedByExit = exitCode === 2;
	const softContext = parsed?.hookSpecificOutput?.additionalContext;
	const permissionDecisionRaw = parsed?.hookSpecificOutput?.permissionDecision;
	const permissionDecision =
		permissionDecisionRaw === "allow" ||
		permissionDecisionRaw === "deny" ||
		permissionDecisionRaw === "ask" ||
		permissionDecisionRaw === "defer"
			? permissionDecisionRaw
			: undefined;

	// Top-level decision: "block" blocks, "approve" allows (matching Claude Code).
	const isBlocked = parsed?.decision === "block";
	const isApproved = parsed?.decision === "approve";

	// PermissionRequest: hookSpecificOutput.decision is an object {behavior, updatedInput?, message?}
	let permissionRequestResult: HookRunResult["permissionRequestResult"];
	let updatedInputFromPermission: Record<string, unknown> | undefined;
	const hsoDecision = parsed?.hookSpecificOutput?.decision;
	if (hsoDecision && typeof hsoDecision === "object" && "behavior" in hsoDecision) {
		if (hsoDecision.behavior === "deny") {
			permissionRequestResult = { behavior: "deny", message: hsoDecision.message };
		} else {
			permissionRequestResult = { behavior: "allow", updatedInput: hsoDecision.updatedInput };
			updatedInputFromPermission = hsoDecision.updatedInput;
		}
	}

	// PermissionDenied: hookSpecificOutput.retry tells the model it may retry.
	const retry = parsed?.hookSpecificOutput?.retry === true;

	const blocked =
		isBlocked || blockedByExit || permissionDecision === "deny" || permissionRequestResult?.behavior === "deny";
	const reason =
		parsed?.stopReason ??
		(permissionRequestResult?.behavior === "deny" ? permissionRequestResult.message : undefined) ??
		parsed?.hookSpecificOutput?.permissionDecisionReason ??
		parsed?.reason ??
		(blockedByExit ? stderr.trim() || stdout.trim() || undefined : undefined);
	return {
		blocked,
		reason,
		forceStop,
		updatedInput: updatedInputFromPermission ?? parsed?.hookSpecificOutput?.updatedInput,
		updatedToolOutput: parsed?.hookSpecificOutput?.updatedToolOutput,
		permissionDecision: isApproved && !permissionDecision ? "allow" : permissionDecision,
		additionalContext: softContext,
		permissionRequestResult,
		retry,
		stdout,
		exitCode,
	};
}

export interface RunHooksOptions {
	event: HookEvent;
	matchTarget?: string;
	cwd: string;
	sessionId?: string;
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	mcpToolIndex?: Map<string, McpToolHandle>;
	config?: AppConfig;
	model?: string;
	permissionMode?: string;
}

/**
 * Run every hook registered for `event` whose matcher accepts the match
 * target — across every source (global, every plugin, project), in
 * parallel (matching Claude Code's behavior). A `forceStop` result
 * short-circuits immediately; all other hooks still run even after one
 * blocks — only the *first* blocking result is returned, except
 * `updatedInput`/`updatedToolOutput` which carry over from whichever hook
 * set them last.
 */
export async function runHooksForEvent(hooks: HooksFile, opts: RunHooksOptions): Promise<HookRunResult> {
	const groups = hooks[opts.event];
	if (!groups?.length) return { blocked: false, stdout: "", exitCode: null };

	const matchTarget = opts.matchTarget ?? pickMatchTarget(opts.event, opts.payload);

	const filteredGroups = groups
		.map((group) => ({
			...group,
			hooks: filterByIfCondition(group.hooks, opts.event, opts.payload),
		}))
		.filter((g) => g.hooks.length > 0);

	const matchedGroups =
		matchTarget !== undefined
			? filteredGroups.filter((g) => matchesMatcher(matchTarget, g.matcher ?? ""))
			: filteredGroups;

	const deduped = deduplicateHooks(matchedGroups);

	const promises = deduped.flatMap((group) =>
		group.hooks.map(async (cmd): Promise<HookRunResult> => {
			const timeoutSeconds = cmd.timeout ?? defaultTimeoutFor(opts.event);
			const payload = {
				hook_event_name: opts.event,
				cwd: opts.cwd,
				session_id: opts.sessionId,
				permission_mode: opts.permissionMode,
				...opts.payload,
			};
			if (cmd.type === "http" && cmd.url) {
				return runHttpHook(cmd.url, timeoutSeconds, payload, opts.signal, cmd.headers, cmd.allowedEnvVars);
			}
			if (cmd.type === "mcp_tool") {
				return runMcpToolHook(cmd, payload, opts.mcpToolIndex, opts.signal);
			}
			if (cmd.type === "prompt") {
				return runPromptHook(cmd, payload, opts.config, opts.model, opts.signal);
			}
			return runCommandHook(
				substitutePluginVars(cmd.command ?? "", group._pluginRoot),
				timeoutSeconds,
				opts.cwd,
				buildHookEnv(opts.event, opts.cwd, opts.sessionId, group._pluginRoot, cmd.env),
				payload,
				opts.signal,
			);
		}),
	);

	if (promises.length === 0) return { blocked: false, stdout: "", exitCode: null };

	const results = await Promise.all(promises);

	let firstBlock: HookRunResult | undefined;
	let firstForceStop: HookRunResult | undefined;
	let updatedInput: Record<string, unknown> | undefined;
	let updatedToolOutput: string | undefined;
	let permissionDecision: HookRunResult["permissionDecision"];
	let permissionRequestResult: HookRunResult["permissionRequestResult"];
	let retry: boolean | undefined;
	const additionalContexts: string[] = [];
	const allStdout: string[] = [];
	let lastExitCode: number | null = null;

	// `results` is already fully resolved (Promise.all above already awaited
	// every hook), so returning early here on the first forceStop wouldn't
	// save any actual wait — it would only truncate the merge below, silently
	// dropping updatedInput/additionalContext/etc. from sibling hooks in this
	// same batch depending on array order. Collect firstForceStop like
	// firstBlock instead, and merge before returning either.
	for (const result of results) {
		if (result.forceStop && !firstForceStop) firstForceStop = result;
		if (result.updatedInput) updatedInput = result.updatedInput;
		if (result.updatedToolOutput !== undefined) updatedToolOutput = result.updatedToolOutput;
		if (result.permissionDecision) permissionDecision = result.permissionDecision;
		if (result.permissionRequestResult) permissionRequestResult = result.permissionRequestResult;
		if (result.retry) retry = result.retry;
		if (result.additionalContext) additionalContexts.push(result.additionalContext);
		if (result.stdout) allStdout.push(result.stdout);
		lastExitCode = result.exitCode;
		if (result.blocked && !firstBlock) firstBlock = result;
	}

	const combinedContext = additionalContexts.length > 0 ? additionalContexts.join("\n") : undefined;
	const combinedStdout = allStdout.join("\n");
	// forceStop wins over a block from another hook in the same run (see
	// the doc comment above) — checked first, same merge shape as firstBlock.
	if (firstForceStop)
		return {
			...firstForceStop,
			updatedInput,
			updatedToolOutput,
			permissionDecision,
			additionalContext: combinedContext,
			permissionRequestResult,
			retry,
		};
	if (firstBlock)
		return {
			...firstBlock,
			updatedInput,
			updatedToolOutput,
			permissionDecision,
			additionalContext: combinedContext,
			permissionRequestResult,
			retry,
		};
	return {
		blocked: false,
		stdout: combinedStdout,
		exitCode: lastExitCode,
		updatedInput,
		updatedToolOutput,
		permissionDecision,
		additionalContext: combinedContext,
		permissionRequestResult,
		retry,
	};
}
