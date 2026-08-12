import { setMaxListeners } from "node:events";
import { basename, join } from "node:path";
import {
	formatPostCompactReminder,
	injectPostCompactReminder,
	type PostCompactReminderState,
	reminderStateFromPlan,
} from "./compaction-reminder.ts";
import type { AppConfig } from "./config.ts";
import { type AnnouncedLocalDate, appendDateRolloverReminder } from "./date-rollover-reminder.ts";
import { matchesToolsAllowlist } from "./frontmatter.ts";
import { type HooksFile, runHooksForEvent } from "./hooks.ts";
import { appendInterruptReminder } from "./interrupt-reminder.ts";
import type { Message, Tool, Usage } from "./llm.ts";
import {
	applyCacheControl,
	createClient,
	describeTurnError,
	EMPTY_ASSISTANT_PLACEHOLDER,
	isContextOverflow,
	streamAndCollect,
} from "./llm.ts";
import { type McpToolHandle, mcpServerNameFromDescription } from "./mcp.ts";
import {
	collectOpenWorkSteps,
	defaultOpenWorkGateConfig,
	evaluateOpenWorkGate,
	isOpenWorkGateActive,
	type OpenWorkGateConfig,
} from "./open-work-gate.ts";
import type { Persona } from "./personas.ts";
import { checkReadOnlyCommand, listPlanNames, readActivePlan, TERMINAL_TOOL_NAMES } from "./plan.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";
import {
	compactMessages,
	estimateTokens,
	fileTagsFromCompactionSummary,
	markImageMessagesOutOfContext,
	shouldCompact,
} from "./session.ts";
import type { SshHost } from "./ssh.ts";
import type { SubagentPrompt } from "./subagents.ts";
import { formatTodoList, remainingTodoCount, type TodoItem, validateTodos } from "./todo.ts";
import { type CompletedToolCallStatus, completedToolCallStatus, normalizeToolResultError } from "./tools/shared.ts";
import {
	type BashBackgroundDeps,
	type ConfirmBash,
	type ConfirmWrite,
	createToolExecutor,
	getToolDefinitions,
	type ToolResult,
} from "./tools.ts";
import { clearTurnRunner, markTurnRunner } from "./turn-runner-state.ts";

const IMAGE_VISION_RE = /image|vision/i;

// How many identical consecutive tool calls (same name + same args) before
// we treat it as a doom loop and block execution — the model gets an error
// result and must try something different.
const DOOM_LOOP_THRESHOLD = 3;

// Running cap on embedded image_url data across the whole live context (see
// the `read`-on-image-file handling below) — a per-file cap already exists
// (tools/files.ts's MAX_IMAGE_BYTES) but did nothing to stop several
// individually-small images from piling up into one oversized request.
const MAX_TOTAL_EMBEDDED_IMAGE_BYTES = 6 * 1024 * 1024;

/** Sum of every image_url data: URL's length across `messages` — a rough but
 * cheap proxy for request payload weight (base64 chars, not decoded bytes;
 * close enough for a soft budget, no need to decode to check a cap). */
function sumEmbeddedImageBytes(messages: Message[]): number {
	let total = 0;
	for (const m of messages) {
		if (m.role !== "user" || !Array.isArray(m.content)) continue;
		for (const p of m.content as Array<{ type?: string; image_url?: { url?: string } }>) {
			if (p.type === "image_url" && p.image_url?.url) total += p.image_url.url.length;
		}
	}
	return total;
}

function formatMB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * When the previous LLM call overflowed the context window, the cause is
 * almost always one oversized tool result (a `read`/`grep`/`web_fetch` that
 * returned hundreds of KB and is now anchored in history, repeated on every
 * retry). Replace the largest such in-place with a short placeholder so the
 * next retry has room to breathe, and tell the model via a `<system-reminder>`
 * so it knows to re-fetch with a narrower scope instead of asking for the
 * same content again.
 *
 * The `tool_call_id` is preserved: the original assistant message's
 * `tool_calls[].id` is still pointing at this message, and rewiring the
 * conversation would 400 the provider outright. We only swap the `content`
 * of the existing `role: "tool"` row — which is exactly what `sanitizeMessages`
 * already does for other shortenings (see llm.ts), so the wire shape stays
 * valid.
 *
 * Returns the number of bytes removed, or `0` when nothing was oversized.
 */
function replaceLargestToolResult(messages: Message[]): { bytesRemoved: number; toolCallId: string } | undefined {
	let targetIdx = -1;
	let targetLen = 0;
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (!m || m.role !== "tool") continue;
		const content = m.content;
		if (typeof content !== "string") continue;
		if (content.length > targetLen) {
			targetLen = content.length;
			targetIdx = i;
		}
	}
	if (targetIdx === -1 || targetLen < 16 * 1024) return undefined;
	const m = messages[targetIdx]!;
	if (m.role !== "tool") return undefined;
	const original = m.content;
	if (typeof original !== "string") return undefined;
	const toolCallId = m.tool_call_id;
	const replacement =
		`(previous tool result omitted: ${formatMB(original.length)} did not fit in the model's context window. ` +
		`Re-fetch with a narrower scope — read with offset/limit, grep with a more specific path/glob/pattern, ` +
		`or split the request into smaller calls.)`;
	messages[targetIdx] = { ...m, content: replacement, castIsError: true } as Message;
	return { bytesRemoved: original.length - replacement.length, toolCallId };
}

// bash_output is a pure-read poll — repeated identical polls on the same
// task_id are the expected usage pattern while waiting on a background task,
// not a stuck model. bash_kill is deliberately NOT exempt: repeated identical
// kills is a legitimate doom pattern.
const DOOM_LOOP_EXEMPT = new Set<string>(["bash_output"]);

// Terminal (signal) tools: once one succeeds, the turn ends — the UI opens a
// mode-transition dialog when the run settles. Enforced by the loop, not by
// asking the model to stop: a model that kept calling plan_done with a slightly
// reworded summary used to keep the run alive indefinitely (and slipped past
// the doom-loop detector, which keys on exact args). See plan.ts.
const TERMINAL_TOOLS = new Set<string>(TERMINAL_TOOL_NAMES);

// Common wrong tool names models reach for (trained on other harnesses) mapped
// to cast's real tools — so a hallucinated call gets pointed at the right tool
// instead of a bare "Unknown tool", which some models retry identically until
// the doom-loop guard trips.
const TOOL_ALIASES: Record<string, string> = {
	// Pre-rename cast name — still accepted via normalizeToolName; kept here
	// so a bare unknown-path message can point at `glob` if remapping is skipped.
	find: "glob",
	search: "grep",
	search_files: "grep",
	ripgrep: "grep",
	view: "read",
	cat: "read",
	open: "read",
	list_dir: "ls",
	list_files: "ls",
	str_replace: "edit",
	str_replace_editor: "edit",
	apply_patch: "edit",
	create_file: "write",
	run: "bash",
	shell: "bash",
	run_command: "bash",
	execute: "bash",
};

/** Legacy tool names rewritten to the current advertised name before dispatch. */
const TOOL_RENAMES: Record<string, string> = {
	find: "glob",
};

function normalizeToolName(name: string): string {
	return TOOL_RENAMES[name] ?? name;
}

/** Levenshtein distance, capped small — just enough to catch a typo'd tool name. */
function editDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	let prev = Array.from({ length: n + 1 }, (_, i) => i);
	let curr = new Array<number>(n + 1);
	for (let i = 1; i <= m; i++) {
		curr[0] = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return prev[n]!;
}

/** Error result for a tool name that isn't advertised: name the closest real
 * tool (alias table first, then nearest by edit distance) and list what's
 * available, so the model corrects instead of retrying the fabricated name. */
function unknownToolResult(name: string, available: string[]): ToolResult {
	const aliased = TOOL_ALIASES[name.toLowerCase()];
	const suggestion =
		aliased && available.includes(aliased)
			? aliased
			: available
					.map((t) => ({ t, d: editDistance(name.toLowerCase(), t.toLowerCase()) }))
					.filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)))
					.sort((a, b) => a.d - b.d)[0]?.t;
	const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
	return {
		content: `Unknown tool "${name}".${hint} Available tools: ${available.join(", ")}. Call one of these — do not retry "${name}".`,
		isError: true,
	};
}

/** Tools whose effect is to create, overwrite, or patch a file. MCP tools
 * follow the same rule — anything starting with `mcp_` is treated as
 * potentially destructive because we have no signal otherwise. */
const DESTRUCTIVE_WRITE_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "create_file"]);

/** Pick the path-shaped arg from a tool call. Different tools use different
 * keys (`path`, `file_path`, `target_path`) — try the obvious ones. */
function extractWritePath(name: string, args: Record<string, unknown>): string {
	const a = args as Record<string, unknown>;
	return (
		(typeof a.path === "string" && a.path) ||
		(typeof a.file_path === "string" && a.file_path) ||
		(typeof a.target_path === "string" && a.target_path) ||
		(typeof a.filepath === "string" && a.filepath) ||
		`${name} (no path arg)`
	);
}

/** Gate destructive file operations on a `ConfirmWrite` callback. Returns a
 * denial `ToolResult` when the user says no; `undefined` when the tool is
 * not destructive or the callback is unset / grants. The callback runs in the
 * same pass as tool dispatch, so an editor UI sees every write attempt in
 * real time and can deny/allow per call. */
export async function gateDestructiveWrite(
	name: string,
	args: Record<string, unknown>,
	confirm: ConfirmWrite | undefined,
): Promise<ToolResult | undefined> {
	const isDestructive = DESTRUCTIVE_WRITE_TOOLS.has(name) || name.startsWith("mcp_");
	if (!isDestructive || !confirm) return undefined;
	const path = extractWritePath(name, args);
	const reason = `write to ${path}`;
	const granted = await confirm(name, path, reason);
	if (granted) return undefined;
	return {
		content: `Permission denied: ${name} ${reason}`,
		isError: true,
	};
}

// Prompts for the LLM call that summarizes old messages during compaction —
// content, not code, so they live in prompts/ alongside the persona files
// instead of as inline strings here. Two variants (matching pi): a fresh
// summary when this is the first compaction this session has hit, or an
// update-in-place instruction set when compactMessages found a previous
// summary to fold new messages into.
const COMPACTION_SYSTEM_PROMPT = readRequiredPrompt(promptsDir, "compaction-system.md");
const COMPACTION_PROMPT = readRequiredPrompt(promptsDir, "compaction.md");
const COMPACTION_UPDATE_PROMPT = readRequiredPrompt(promptsDir, "compaction-update.md");
// Mode prompts live under prompts/modes/ — one file per agent mode, so new
// modes slot in beside these. Plan mode: restriction block prepended to the
// system prompt while /plan is active. Build mode: mirror of the plan block,
// injected once plan mode is exited and a plan file exists for the session, so
// the approved plan keeps steering the implementation — and survives
// compaction, which would otherwise drop it from the conversation. {{PLAN}} is
// replaced with the plan file content.
const PLAN_MODE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "plan-mode.md"));
const BUILD_MODE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "build-mode.md"));
// Shown instead of the full mirror once every checklist item is checked — a
// fully executed plan should stop steering (and stop costing tokens); the file
// stays on disk for reference. {{NAME}}/{{PATH}} are replaced.
const BUILD_MODE_DONE_PROMPT = readRequiredPrompt(promptsDir, join("modes", "build-mode-done.md"));
// Appended to the compaction prompt while plan mode is active: exploration
// findings not yet written into the plan file must survive the summary.
// Exported for the manual /compact command, which runs outside the loop.
export const PLAN_COMPACTION_PROMPT = readRequiredPrompt(promptsDir, join("modes", "plan-compaction.md"));
// Build mode only (see doing-tasks.md): the model's own todo_write list,
// re-rendered into the prompt every turn — same "survives compaction, can't
// silently drift out of view" rationale as BUILD_MODE_PROMPT above, just for
// ad-hoc task tracking instead of an approved plan file. {{TODOS}} replaced.
const TODO_LIST_PROMPT = readRequiredPrompt(promptsDir, join("modes", "todo-list.md"));

// One-liner for subagents running under readOnlyBash (plan-mode parent): they
// don't get the full plan-mode block (it references authoring tools they lack),
// but they must know why a mutating bash command bounces.
const READONLY_BASH_NOTE =
	"bash is INSPECTION-ONLY in this session: pipelines of read-only binaries (ls, cat, grep, find, wc, diff, git log/show/diff/status/blame, …) pass; anything that writes or runs other programs is rejected.";

// ============================================================================
// Compaction
// ============================================================================

export interface CompactSessionResult {
	messages: Message[];
	compacted: boolean;
	messagesCompacted: number;
	tokensBefore: number;
	/** Set when summarization threw — messages are returned untouched rather than lossily pruned. */
	error?: string;
}

/**
 * Run one compaction pass over `messages`. Shared by the agent loop's
 * automatic shouldCompact check and the manual /compact command — both need
 * the exact same prompt assembly and previous-summary threading, so this is
 * the one place that owns it.
 */
export async function compactSessionMessages(
	messages: Message[],
	config: AppConfig,
	model: string,
	signal?: AbortSignal,
	onRetry?: (attempt: number, reason: string) => void,
	onUsage?: (usage: Usage) => void,
	/** Extra mode-specific summarization guidance (e.g. plan mode: keep
	 * exploration findings not yet written into the plan file). */
	extraInstructions?: string,
	/** Live session state to preserve in a post-compact `<system-reminder>`. */
	reminderState?: PostCompactReminderState,
	/** Provider credentials override (for per-slot provider selection). */
	providerOverride?: { baseURL: string; apiKey: string },
): Promise<CompactSessionResult> {
	const client = createClient(config, providerOverride);
	try {
		const result = await compactMessages(
			messages,
			async (text, previousSummary) => {
				const basePrompt = previousSummary
					? `<conversation>\n${text}\n</conversation>\n\n<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${COMPACTION_UPDATE_PROMPT}`
					: `<conversation>\n${text}\n</conversation>\n\n${COMPACTION_PROMPT}`;
				const promptText = extraInstructions ? `${basePrompt}\n\n${extraInstructions}` : basePrompt;
				const resp = await streamAndCollect(
					client,
					model,
					[
						{ role: "system", content: COMPACTION_SYSTEM_PROMPT },
						{ role: "user", content: promptText },
					],
					[],
					2000,
					signal,
					undefined,
					undefined,
					{},
					onRetry,
				);
				// The summarization call itself is a real request against the
				// model — it costs real tokens/money and was previously just
				// discarded here, silently under-reporting session usage/cost
				// every time compaction ran (automatic or /compact).
				if (resp.usage) onUsage?.(resp.usage);
				return resp.content;
			},
			config,
		);
		// messagesCompacted === 0 means compactMessages found no safe cut point
		// yet (see session.ts's safeCutIndex) and left messages untouched.
		if (result.summary.messagesCompacted > 0) {
			// Reminder is a separate trailing message, never embedded in the
			// summary. Omit entirely when nothing actionable.
			const fileTags = fileTagsFromCompactionSummary(result.summary.summary);
			injectPostCompactReminder(
				result.messages,
				formatPostCompactReminder({
					...reminderState,
					modifiedFiles: reminderState?.modifiedFiles ?? fileTags.modifiedFiles,
				}),
			);
			return {
				messages: result.messages,
				compacted: true,
				messagesCompacted: result.summary.messagesCompacted,
				tokensBefore: result.summary.tokensBefore,
			};
		}
		return { messages, compacted: false, messagesCompacted: 0, tokensBefore: result.summary.tokensBefore };
	} catch (error) {
		// Summarization failed (network error, provider outage, etc). Falling
		// back to pruning here used to silently and irreversibly discard
		// old messages — the user had no way to tell a real summary from a
		// lossy prune. Leave messages untouched instead: the caller sees
		// compacted:false + error, so the transcript isn't lost, and the next
		// turn just retries compaction (shouldCompact stays true) rather than
		// losing history to a transient failure.
		return {
			messages,
			compacted: false,
			messagesCompacted: 0,
			tokensBefore: estimateTokens(messages),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Run a compaction pass and, on success, splice the result back into
 * `messages` in place and emit the `compaction` event. Centralizes the
 * mutate-and-emit boilerplate shared by every call site (automatic
 * shouldCompact check, mid-turn context guard, context-overflow retry) so
 * they can't drift out of sync on what a successful compaction does to the
 * live messages array. Callers still own failure handling — the overflow
 * retry path wants a different message and to rethrow, so this only ever
 * emits on success.
 */
async function performCompaction(
	messages: Message[],
	config: AppConfig,
	model: string,
	signal: AbortSignal | undefined,
	loopConfig: LoopConfig,
	onEvent: (event: AgentEvent) => void,
): Promise<CompactSessionResult> {
	if (loopConfig.hooks) {
		await runHooksForEvent(loopConfig.hooks, {
			event: "PreCompact",
			cwd: loopConfig.cwd,
			sessionId: loopConfig.sessionId,
			payload: { trigger: "auto" },
			signal,
		});
	}
	const result = await compactSessionMessages(
		messages,
		config,
		model,
		signal,
		(attempt, reason) => onEvent({ type: "retry", attempt, reason }),
		(usage) => onEvent({ type: "usage", usage }),
		loopConfig.planState?.enabled ? PLAN_COMPACTION_PROMPT : undefined,
		reminderStateFromPlan(loopConfig.planState),
		loopConfig.modelProvider,
	);
	if (result.compacted) {
		const fullHistoryBeforeCompaction = [...messages];
		messages.length = 0;
		messages.push(...result.messages);
		loopConfig.onCompaction?.(fullHistoryBeforeCompaction, result.messages);
		onEvent({
			type: "compaction",
			messagesCompacted: result.messagesCompacted,
			tokensBefore: result.tokensBefore,
		});
		if (loopConfig.hooks) {
			await runHooksForEvent(loopConfig.hooks, {
				event: "PostCompact",
				cwd: loopConfig.cwd,
				sessionId: loopConfig.sessionId,
				payload: { trigger: "auto", messagesCompacted: result.messagesCompacted },
				signal,
			});
		}
	}
	return result;
}

// ============================================================================
// Message queue — from pi's PendingMessageQueue
// ============================================================================

/** Drains one queued message at a time — each becomes its own turn. */
export class MessageQueue {
	private messages: Message[] = [];

	enqueue(message: Message): void {
		this.messages.push(message);
	}

	hasItems(): boolean {
		return this.messages.length > 0;
	}

	drain(): Message[] {
		const first = this.messages[0];
		if (!first) return [];
		this.messages = this.messages.slice(1);
		return [first];
	}

	clear(): void {
		this.messages = [];
	}

	get length(): number {
		return this.messages.length;
	}
}

// ============================================================================
// Events — aligned with pi's AgentEvent taxonomy
// ============================================================================

export type AgentEvent =
	| { type: "thinking"; text: string }
	| { type: "token"; text: string }
	| {
			type: "assistant_message";
			content: string;
			thinking: string;
			toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	  }
	| { type: "tool_start"; id: string; name: string; args: string; status: "running" }
	| { type: "tool_end"; id: string; name: string; result: ToolResult; status: CompletedToolCallStatus }
	| { type: "turn_end"; toolResults: Array<{ id: string; name: string; result: ToolResult }> }
	// Carries the actual injected messages (not just a count) so the UI can show
	// them as permanent history entries immediately, the same way it does for
	// a normal submit — otherwise a steering/follow-up message typed mid-run
	// would never appear in the transcript at all.
	| { type: "steering_injected"; messages: Message[] }
	| { type: "followup_injected"; messages: Message[] }
	| { type: "compaction"; messagesCompacted: number; tokensBefore: number }
	| { type: "compaction_failed"; reason: string }
	/** Largest tool result in history was yoked to fit a context-overflow turn;
	 * a `<system-reminder>` was appended telling the model to re-fetch with a
	 * narrower scope. `bytesRemoved` is the size of the original content that
	 * was replaced with a placeholder. */
	| { type: "tool_result_truncated"; toolCallId: string; bytesRemoved: number }
	| { type: "doom_loop"; tool: string; attempts: number }
	/** Turn-end gate forced another sampling round because plan steps remain open. */
	| { type: "open_work_gate"; fires: number; openSteps: number }
	/** Gate hit its per-prompt cap and allowed the turn to end. */
	| { type: "open_work_gate_exhausted"; openSteps: number; maxFires: number }
	/** Prior turn was aborted mid-stream; a `<system-reminder>` was appended for the model. */
	| { type: "interrupt_reminder" }
	/** Build-mode todo_write call landed — carries the full replacement list. */
	| { type: "todos_updated"; todos: TodoItem[] }
	/** Session crossed local midnight; a date-rollover `<system-reminder>` was appended. */
	| { type: "date_rollover"; date: string }
	| { type: "retry"; attempt: number; reason: string }
	// generationMs is only set for the main completion's usage — compaction's
	// own summarization call reports usage too (for cumulative cost tracking)
	// but isn't a user-facing turn, so there's no "last request" TPS to show for it.
	| { type: "usage"; usage: Usage; generationMs?: number; subagent?: boolean }
	| { type: "end"; reason: string }
	| { type: "error"; message: string };

// ============================================================================
// Loop config
// ============================================================================

export interface LoopConfig {
	config: AppConfig;
	model: string;
	cwd: string;
	systemPrompt: string;
	onEvent: (event: AgentEvent) => void;
	/** Non-fatal warning shown to the user (e.g. vision fallback). */
	onWarning?: (message: string) => void;
	signal?: AbortSignal;
	steeringQueue?: MessageQueue;
	followUpQueue?: MessageQueue;
	confirmBash?: ConfirmBash;
	/** Optional permission gate for destructive file tools (write/edit/patch and
	 * MCP tools prefixed `mcp_`). When unset, no extra confirmation fires —
	 * matches TUI behavior, where only bash needs confirmation. */
	confirmWrite?: ConfirmWrite;
	/** Definitions for connected MCP servers' tools, appended to the built-in ones. */
	mcpTools?: Tool[];
	/** Dispatch table for mcpTools — checked before falling back to the built-in executor. */
	mcpToolIndex?: Map<string, McpToolHandle>;
	/** Available personas for the task tool. */
	personas?: Persona[];
	/** Current persona name (inherited by subagents by default). */
	currentPersona?: string;
	/** Subagent prompts for the task tool. */
	subagentPrompts?: SubagentPrompt[];
	/** Model override for subagents (falls back to main model if undefined). */
	subagentModel?: string;
	/** Provider credentials for the main model (if on a different provider than config). */
	modelProvider?: { baseURL: string; apiKey: string };
	/** Provider credentials for the subagent model (if on a different provider). */
	subagentModelProvider?: { baseURL: string; apiKey: string };
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/**
	 * Optional allowlist for *built-in* tools only. Entries are exact names
	 * or `*`-globs (`plan_*`, `web_*`). When set, only matching builtin names
	 * are advertised and executable (after `disabledTools`). Connected MCP
	 * tools are never filtered by this list — they come from the user's
	 * session config, not the persona/subagent role. Used by subagents from
	 * frontmatter `tools:`; for the main agent, derived from the active
	 * persona when omitted.
	 */
	allowedTools?: string[];
	/**
	 * Whether the project cwd is trusted — used when spawning subagents that
	 * opt into AGENTS.md injection (`agentsMd: true`, the default).
	 */
	projectTrusted?: boolean;
	/** Parent `--no-skills` — forwarded so task subagents skip the same discovery. */
	noSkills?: boolean;
	/** Parent `--skill` paths — forwarded into task subagent skill catalogs. */
	cliSkillPaths?: string[];
	/** Plan mode state — when enabled, injects plan system prompt block. */
	planState?: import("./plan.ts").PlanState;
	/** Hooks config (see resolveHooksForCwd in project.ts). */
	hooks?: HooksFile;
	/** Current session id — included in every hook payload/env (CAST_SESSION_ID). */
	sessionId?: string;
	/** Permission mode — included in hook payloads as permission_mode. */
	permissionMode?: string;
	/** Loaded skills — for the skill tool. */
	skills?: import("./skills.ts").Skill[];
	/** Restrict bash to the read-only allowlist without the rest of plan mode.
	 * Used for subagents spawned from a plan-mode parent: they inherit the
	 * inspection-only bash but not the authoring tools or the plan prompt
	 * (their planState arrives with enabled=false). Implied by
	 * planState.enabled for the main agent. */
	readOnlyBash?: boolean;
	/** Build-mode todo list carried over from the session (resume/continue) —
	 * seeds the in-run list so it's advertised, prompted, and editable from
	 * the first turn instead of starting empty every run. */
	initialTodos?: TodoItem[];
	/** promptTokens from the most recent API response — used by shouldCompact
	 * as the authoritative context size instead of character-based estimation. */
	lastPromptTokens?: number;
	/**
	 * Optional per-turn system prompt rebuild. Called before every model
	 * request (each inner tool-call iteration, not just once per turn) with
	 * the current user text and accumulated context files. Rebuilding per
	 * request is what lets a rule auto-attach *within the same turn*: the
	 * model reads a file, contextFiles grows, and the very next request
	 * already carries the matching rule. Returns the system prompt to use.
	 */
	rebuildSystemPrompt?: (context: { userText: string; contextFiles: string[] }) => string;
	/**
	 * Session-scoped list of context files (paths from read/write/edit tool
	 * calls), accumulated in place across successive runAgentLoop calls. Pass
	 * the same array every submit so a file referenced in one message keeps a
	 * glob rule attached for the rest of the session; omitted ⇒ a fresh
	 * per-call array (rules only auto-attach within a single submit).
	 */
	contextFiles?: string[];
	/** Configured SSH hosts — when non-empty, the `ssh` tool is registered. */
	sshHosts?: SshHost[];
	/** Called immediately before a built-in write/edit mutates a file. */
	beforeFileWrite?: (path: string) => void;
	/**
	 * Background bash task support (`run_in_background` or automatic promotion on
	 * `bash`, plus `bash_output`/`bash_kill`) — web/TUI only. Deliberately omitted for
	 * `cast run` (process exits after one turn, nothing left to notify) and
	 * `task` subagent child configs (ephemeral, no later turn either).
	 */
	backgroundBash?: BashBackgroundDeps;
	/**
	 * Parent MCP catalog block for the system prompt. Forwarded into sync
	 * `task` subagents so they see the same `<available_mcp>` list.
	 */
	mcpPromptSuffix?: string;
	/**
	 * Turn-end open-work gate. When omitted, defaults to enabled with
	 * `DEFAULT_OPEN_WORK_GATE_MAX_FIRES`. Still requires build mode + an
	 * active plan on disk (`isOpenWorkGateActive`).
	 */
	openWorkGate?: Partial<OpenWorkGateConfig>;
	/**
	 * Local calendar date last announced to the model (`YYYY-MM-DD`). When
	 * set, the loop injects a one-shot date-rollover reminder if today is
	 * later, and updates `.value` in place. Omit to disable.
	 */
	announcedLocalDate?: AnnouncedLocalDate;
	/**
	 * Called after every mutation to the internal messages array (push, splice,
	 * etc.) so the caller can snapshot intermediate progress for crash recovery.
	 * The array reference is the same one the loop operates on — taking a
	 * shallow copy is enough to capture the current state.
	 */
	onMessagesChanged?: (messages: Message[]) => void;
	/**
	 * Fired synchronously right after a successful compaction builds its
	 * replacement array but before it's spliced into the live `messages`
	 * array — carries the full pre-truncation history and the new shrunk
	 * array so a caller that knows which SessionState this belongs to (this
	 * loop doesn't) can archive the raw messages before they're gone. Not
	 * fired on failed or no-op compactions.
	 */
	onCompaction?: (fullHistoryBeforeCompaction: Message[], compacted: Message[]) => void;
}

/**
 * Wrap an array with a Proxy that fires `onChange` after every structural
 * mutation (push, splice, pop, shift, unshift, sort, reverse, fill).
 * The callback receives the proxy itself so the caller can snapshot it.
 *
 * Indexed assignment (`arr[i] = …`) also triggers the callback — the loop
 * occasionally does this to update a message in place.
 */
function makeObservable<T>(arr: T[], onChange: (arr: T[]) => void): T[] {
	const mutating = new Set(["push", "pop", "splice", "shift", "unshift", "sort", "reverse", "fill"]);
	return new Proxy(arr, {
		get(target, prop, receiver) {
			const val = Reflect.get(target, prop, receiver);
			if (typeof prop === "string" && mutating.has(prop) && typeof val === "function") {
				return (...args: unknown[]) => {
					const result = val.apply(target, args);
					onChange(receiver);
					return result;
				};
			}
			return val;
		},
		set(target, prop, value, receiver) {
			const result = Reflect.set(target, prop, value, receiver);
			if (typeof prop === "string" && !Number.isNaN(Number(prop))) onChange(receiver);
			return result;
		},
	});
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Run the agent loop starting from initialMessages.
 * Returns ALL messages (initial + new).
 */
export async function runAgentLoop(initialMessages: Message[], loopConfig: LoopConfig): Promise<Message[]> {
	const messages = [...initialMessages];
	const tracked = loopConfig.onMessagesChanged ? makeObservable(messages, loopConfig.onMessagesChanged) : messages;
	await runLoop(tracked, loopConfig);
	return tracked;
}

// ============================================================================
// Core loop — outer (follow-up) + inner (tool calls + steering)
// ============================================================================

async function runLoop(messages: Message[], loopConfig: LoopConfig): Promise<void> {
	// Mark this session as actively running so cross-process readers (the web
	// UI's sidebar) see a green dot while we're driving the turn. The marker is
	// removed in the finally below — including the crash path (kill -9, OOM, lost
	// terminal), because the file's pid becomes dead and readers filter it out.
	const runnerSessionId = loopConfig.sessionId;
	if (runnerSessionId) markTurnRunner(runnerSessionId, process.pid);
	try {
		await runLoopInner(messages, loopConfig);
	} finally {
		// clearTurnRunner checks the pid inside the file matches our own before
		// unlinking, so a second TUI racing on the same session won't have its
		// marker clobbered by us.
		if (runnerSessionId) clearTurnRunner(runnerSessionId, process.pid);
	}
}

async function runLoopInner(messages: Message[], loopConfig: LoopConfig): Promise<void> {
	const { config, model: initialModel, cwd, systemPrompt, onEvent, onWarning, signal, mcpToolIndex } = loopConfig;
	// The same signal is reused across every LLM request, compaction call,
	// and tool execution in the loop. Each call may attach an abort listener
	// (OpenAI SDK, child-process kill handlers, etc.). Raise the cap once so
	// Node doesn't warn on long-running agentic sessions.
	if (signal) setMaxListeners(100, signal);
	const currentPersonaObj = loopConfig.personas?.find((p) => p.name === loopConfig.currentPersona);
	const subagentsEnabled = currentPersonaObj?.subagents === true;
	// Persona `subagentTypes:` narrows which subagent roles this persona may
	// spawn via `task`, on top of the `subagents: true/false` gate above.
	// Filtered here (not just in the advertised name list) so the same
	// restricted set is what execTask's own lookup sees below — a persona
	// can't be routed around by asking for a type that was merely hidden
	// from the description.
	const allowedSubagentPrompts =
		currentPersonaObj?.subagentTypes !== undefined
			? loopConfig.subagentPrompts?.filter((p) => matchesToolsAllowlist(p.name, currentPersonaObj.subagentTypes!))
			: loopConfig.subagentPrompts;
	const subagentNames = subagentsEnabled ? allowedSubagentPrompts?.map((p) => p.name) : undefined;
	const sshHostNames = loopConfig.sshHosts?.map((h) => h.name);
	// Persona `skills:` allowlists which skill names this persona (and, so a
	// restriction can't be routed around by delegating, anything it spawns
	// via `task`) may invoke — same glob semantics as `tools:`. Omitted =
	// every discovered skill stays available.
	const allowedSkills =
		currentPersonaObj?.skills !== undefined
			? loopConfig.skills?.filter((s) => matchesToolsAllowlist(s.name, currentPersonaObj.skills!))
			: loopConfig.skills;
	// A plan is authored before build mode; only build mode exposes its live
	// todo projection as execution state.
	const todoModeActive = !loopConfig.planState?.enabled;
	let todos: TodoItem[] = todoModeActive ? (loopConfig.initialTodos ?? []) : [];
	const builtinTools = getToolDefinitions(
		subagentNames,
		initialModel,
		loopConfig.subagentModel,
		sshHostNames,
		Boolean(loopConfig.backgroundBash),
		todoModeActive,
		allowedSkills?.some((skill) => !skill.disableModelInvocation) ?? false,
	);
	const mcpTools = loopConfig.mcpTools ?? [];
	const allTools = [...builtinTools, ...mcpTools];
	// The plan state is authoritative for its terminal control tool. A UI mode
	// toggle can rerender between turns while a caller still holds an older
	// denylist, and a persona allowlist must not make plan mode impossible to
	// finish.
	const disabledTools = new Set(loopConfig.disabledTools);
	if (loopConfig.planState?.enabled) disabledTools.delete("plan_done");
	else if (loopConfig.planState) disabledTools.add("plan_done");
	// Persona/subagent frontmatter `tools:` allowlists builtins only.
	// LoopConfig wins when set (subagent spawn); otherwise the active persona.
	const allowedTools = loopConfig.allowedTools ?? currentPersonaObj?.tools;
	let builtins = disabledTools?.size ? builtinTools.filter((t) => !disabledTools.has(t.function.name)) : builtinTools;
	let mcps = disabledTools?.size ? mcpTools.filter((t) => !disabledTools.has(t.function.name)) : mcpTools;
	if (allowedTools !== undefined) {
		builtins = builtins.filter(
			(t) =>
				(loopConfig.planState?.enabled && t.function.name === "plan_done") ||
				matchesToolsAllowlist(t.function.name, allowedTools),
		);
	}
	// Persona `mcp:` allowlists by *server* name (matched against the
	// `[serverName] ...` prefix cast stamps on every MCP tool's description —
	// see mcpToolName/description in mcp.ts), not individual tool names:
	// users think "can this role touch postgres", not per-tool. Omitted =
	// every connected server stays visible, same "no restriction" default as
	// `tools:`.
	if (currentPersonaObj?.mcp !== undefined) {
		const mcpAllowlist = currentPersonaObj.mcp;
		mcps = mcps.filter((t) => {
			const server = mcpServerNameFromDescription(t.function.description);
			return server !== undefined && matchesToolsAllowlist(server, mcpAllowlist);
		});
	}
	const tools = [...builtins, ...mcps];
	// Names registered before allowlist/denylist filters — so a call to a
	// real-but-filtered builtin gets "not available", not an unknown-tool hint.
	const knownToolNames = new Set(allTools.map((t) => t.function.name));
	// Names the model is actually allowed to call this turn — used to catch
	// fabricated tool names in executeTool below.
	const advertisedNames = new Set(tools.map((t) => t.function.name));

	// Doom-loop detector: tracks the last DOOM_LOOP_THRESHOLD tool calls
	// (name + serialized args). When the same call appears that many times in
	// a row we refuse to execute it and tell the model to try something else.
	const recentToolCalls: Array<{ name: string; argsKey: string }> = [];

	const openWorkGateConfig: OpenWorkGateConfig = {
		...defaultOpenWorkGateConfig(),
		...loopConfig.openWorkGate,
	};
	// Cap is per outer-loop user prompt; reset when follow-up injects.
	let openWorkGateFires = 0;
	// Bounds a Stop hook that keeps blocking — a misconfigured hook shouldn't
	// be able to wedge the run into a permanent loop.
	let stopHookBlocks = 0;
	// Matches Grok Build/Claude Code's cap: after this many continuations in a
	// single turn, the gate is overridden and the turn ends regardless.
	const MAX_STOP_HOOK_BLOCKS = 8;

	// Wraps the interactive bash-confirmation callback with PermissionRequest/
	// PermissionDenied — the closest thing cast has to Claude Code's
	// permission-prompt lifecycle (there's no generic "any tool needs
	// permission" dispatcher; only bash has one). Placed here (not per call
	// site) so it applies to subagents too — they recurse through this same
	// function with `hooks` inherited from the parent.
	const confirmBashWithHooks: ConfirmBash | undefined =
		loopConfig.confirmBash && loopConfig.hooks
			? async (command, reason) => {
					const hooksForConfirm = loopConfig.hooks!;
					const pr = await runHooksForEvent(hooksForConfirm, {
						event: "PermissionRequest",
						matchTarget: "bash",
						cwd,
						sessionId: loopConfig.sessionId,
						payload: { tool_name: "bash", tool_input: { command, description: reason } },
						signal,
					});
					if (pr.blocked) {
						void runHooksForEvent(hooksForConfirm, {
							event: "PermissionDenied",
							matchTarget: "bash",
							cwd,
							sessionId: loopConfig.sessionId,
							payload: { tool_name: "bash", tool_input: { command } },
							signal,
						});
						return false;
					}
					const allowed = await loopConfig.confirmBash!(command, reason);
					if (!allowed) {
						void runHooksForEvent(hooksForConfirm, {
							event: "PermissionDenied",
							matchTarget: "bash",
							cwd,
							sessionId: loopConfig.sessionId,
							payload: { tool_name: "bash", tool_input: { command } },
							signal,
						});
					}
					return allowed;
				}
			: loopConfig.confirmBash;

	const builtinExecuteTool = createToolExecutor(
		cwd,
		config,
		confirmBashWithHooks,
		// Gate the executor on the same condition as tool advertisement: a persona
		// without `subagents: true` can neither see nor run `task`, even if the
		// model fabricates a call to it.
		subagentsEnabled
			? {
					model: loopConfig.subagentModel ?? initialModel,
					subagentPrompts: allowedSubagentPrompts,
					// Forward the already persona-filtered mcps/skills (not the raw
					// loopConfig lists) — otherwise a `mcp:`/`skills:` restriction on
					// the parent persona would be a no-op the moment it delegates.
					mcpTools: mcps,
					mcpToolIndex,
					confirmBash: loopConfig.confirmBash,
					mainModel: initialModel,
					subagentModel: loopConfig.subagentModel,
					subagentModelProvider: loopConfig.subagentModelProvider,
					disabledTools: loopConfig.disabledTools,
					planState: loopConfig.planState,
					projectTrusted: loopConfig.projectTrusted,
					noSkills: loopConfig.noSkills,
					cliSkillPaths: loopConfig.cliSkillPaths,
					mcpPromptSuffix: loopConfig.mcpPromptSuffix,
					sshHosts: loopConfig.sshHosts,
					hooks: loopConfig.hooks,
					sessionId: loopConfig.sessionId,
					skills: allowedSkills,
					runAgentLoop,
				}
			: undefined,
		loopConfig.planState,
		loopConfig.sshHosts,
		loopConfig.backgroundBash,
		allowedSkills ? { skills: allowedSkills, sessionId: loopConfig.sessionId } : undefined,
		loopConfig.beforeFileWrite,
	);
	const executeTool = async (
		name: string,
		args: Record<string, unknown>,
		toolSignal?: AbortSignal,
		toolCallId?: string,
	): Promise<ToolResult> => {
		// Legacy aliases (e.g. find → glob) before the allowlist / unknown check
		// so old model habits and allowlists keep working against one tool.
		name = normalizeToolName(name);
		// Advertised set is the single source of truth for both definitions and
		// real calls: disabledTools denylist, the persona/subagent builtin
		// `tools:` allowlist, and the persona `mcp:` allowlist (server-scoped
		// — see the mcp filter further up).
		if (!advertisedNames.has(name)) {
			if (knownToolNames.has(name) || disabledTools?.has(name)) {
				return Promise.resolve({
					content: `Tool "${name}" is not available in the current mode.`,
					isError: true,
				});
			}
			// Completely unknown name — suggest the closest advertised tool
			// instead of a bare "Unknown tool" the model tends to retry.
			return Promise.resolve(unknownToolResult(name, [...advertisedNames]));
		}
		// Plan mode allows bash for inspection only — enforced here, not by the
		// model's goodwill: pipelines of allowlisted read-only binaries pass,
		// anything that can write (redirects, substitution, unlisted binaries)
		// is refused with the reason. Subagents of a plan-mode parent inherit
		// the same gate via readOnlyBash.
		if (name === "bash" && (loopConfig.planState?.enabled || loopConfig.readOnlyBash)) {
			const verdict = await checkReadOnlyCommand(typeof args.command === "string" ? args.command : "");
			if (!verdict.ok) {
				return Promise.resolve({
					content: `Plan mode allows read-only commands only — rejected: ${verdict.reason}. Inspect with ls/cat/grep/find/git log|show|diff|status|blame.`,
					isError: true,
				});
			}
		}
		const dispatch = async (finalArgs: Record<string, unknown>): Promise<ToolResult> => {
			// Handled here (not in tools.ts's dispatcher) because it needs direct
			// access to this closure's `todos` — the list must be visible to
			// syncSystemPrompt on the very next request, not round-tripped through
			// a separate store.
			if (name === "todo_write") {
				const result = validateTodos(finalArgs.todos);
				if (!result.ok) return { content: `Error: ${result.error}`, isError: true };
				const previousTodos = todos;
				const planStepsByContent = new Map(
					previousTodos.flatMap((todo) => (todo.planStep ? [[todo.content, todo.planStep] as const] : [])),
				);
				todos = result.todos.map((todo) => {
					const planStep = planStepsByContent.get(todo.content);
					return planStep ? { ...todo, planStep } : todo;
				});
				onEvent({ type: "todos_updated", todos });
				// Observation-only, fire-and-forget — content is the only stable
				// identity todos have (no id field), so this is a best-effort diff,
				// not a guaranteed one (renaming a todo reads as create+drop).
				if (loopConfig.hooks) {
					const previousByContent = new Map(previousTodos.map((t) => [t.content, t]));
					for (const t of todos) {
						const prev = previousByContent.get(t.content);
						if (!prev) {
							void runHooksForEvent(loopConfig.hooks, {
								event: "TaskCreated",
								cwd,
								sessionId: loopConfig.sessionId,
								payload: { content: t.content, priority: t.priority },
								signal,
							});
						} else if (prev.status !== "completed" && t.status === "completed") {
							void runHooksForEvent(loopConfig.hooks, {
								event: "TaskCompleted",
								cwd,
								sessionId: loopConfig.sessionId,
								payload: { content: t.content, priority: t.priority },
								signal,
							});
						}
					}
				}
				return { content: JSON.stringify({ todos, remaining: remainingTodoCount(todos) }) };
			}
			const writeDenial = await gateDestructiveWrite(name, finalArgs, loopConfig.confirmWrite);
			if (writeDenial) return writeDenial;
			const mcpTool = mcpToolIndex?.get(name);
			if (mcpTool) return mcpTool.call(finalArgs, toolSignal);
			return builtinExecuteTool(name, finalArgs, toolSignal, toolCallId);
		};
		const hooks = loopConfig.hooks;
		if (hooks) {
			return runToolWithHooks(
				{
					hooks,
					name,
					args,
					cwd,
					sessionId: loopConfig.sessionId,
					signal: toolSignal ?? signal,
					mcpToolIndex,
					config,
					model: currentModel,
					onWarning,
					toolCallId,
					permissionMode: loopConfig.permissionMode,
				},
				dispatch,
			);
		}
		return dispatch(args);
	};
	const client = createClient(config, loopConfig.modelProvider);
	const steeringQueue = loopConfig.steeringQueue ?? new MessageQueue();
	const followUpQueue = loopConfig.followUpQueue ?? new MessageQueue();

	const currentModel = initialModel;
	// Session-scoped when the caller passes one (so a file referenced in an
	// earlier message keeps its glob rule attached); otherwise per-call.
	const contextFiles = loopConfig.contextFiles ?? [];

	// Build-mode plan snapshot, read ONCE per run. Mode toggles are
	// rejected while a run is active, so a per-run snapshot loses nothing; the
	// next submit picks up fresh checkbox state from disk.
	const buildPlanSnapshot =
		loopConfig.planState && !loopConfig.planState.enabled ? readActivePlan(loopConfig.planState) : undefined;
	// A session can hold several plans; the mirror carries only the approved
	// one, so name the rest — otherwise the model has no way to know they exist.
	const otherPlanNames =
		buildPlanSnapshot?.path && loopConfig.planState
			? listPlanNames(loopConfig.planState.plansDir).filter((n) => n !== basename(buildPlanSnapshot.path!, ".md"))
			: [];
	// Neutral wording: this line rides along with BOTH mirror variants, and the
	// done-variant explicitly says the plan no longer steers.
	const otherPlansLine =
		otherPlanNames.length > 0 && loopConfig.planState
			? `\n\nOther plans in this session: ${otherPlanNames.join(", ")} — read \`${loopConfig.planState.plansDir}/<name>.md\` to view one; none of them steers the work unless approved.`
			: "";

	// Recompute the system prompt from the latest contextFiles/@-mentions and
	// write it into messages[0]. Called before every request so rules that
	// match a file read mid-turn attach on the next request, not only next turn.
	const syncSystemPrompt = (): void => {
		let prompt = systemPrompt;
		if (loopConfig.rebuildSystemPrompt) {
			let userText = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i]!;
				if (m.role === "user") {
					if (typeof m.content === "string") {
						userText = m.content;
					} else if (Array.isArray(m.content)) {
						const textPart = m.content.find((p: { type?: string }) => p.type === "text") as
							| { type: "text"; text: string }
							| undefined;
						if (textPart) userText = textPart.text;
					}
					break;
				}
			}
			prompt = loopConfig.rebuildSystemPrompt({ userText, contextFiles });
		}
		// Plan mode: prepended AFTER any rebuild — the per-turn rebuild path
		// (always active in the TUI) replaces `prompt` wholesale and would
		// silently drop a block added earlier. The restriction must be the
		// first thing the model sees, persona and rules included.
		if (loopConfig.planState?.enabled) {
			const plansDir = loopConfig.planState.plansDir;
			prompt = `${PLAN_MODE_PROMPT.replace(/\{\{PLANS_DIR\}\}/g, () => plansDir)}\n\n${prompt}`;
		} else if (loopConfig.readOnlyBash) {
			// Subagent of a plan-mode parent: no plan-mode block (its authoring
			// tools aren't in this toolset), but the bash restriction must be
			// stated or rejections read like malfunctions.
			prompt = `${prompt}\n\n${READONLY_BASH_NOTE}`;
		}
		if (!loopConfig.planState?.enabled && buildPlanSnapshot?.exists && buildPlanSnapshot.path) {
			// Build mode with a plan from this session: append the approved plan
			// (the active one — most recently written) so it keeps steering
			// implementation. Snapshotted per run (see above); re-read on the
			// next run — that's what makes it survive compaction and resume.
			// Appended (not prepended) because it's guidance, not a restriction:
			// the persona keeps its place at the top.
			const linkedTodos = todos.filter((todo) => todo.planStep);
			if (linkedTodos.length > 0 && remainingTodoCount(linkedTodos) === 0) {
				// Fully executed plan: stop steering (and stop paying for the full
				// content every request) — leave a one-line reference instead.
				prompt = `${prompt}\n\n${BUILD_MODE_DONE_PROMPT.replace("{{NAME}}", () => basename(buildPlanSnapshot.path!, ".md")).replace("{{PATH}}", () => buildPlanSnapshot.path!)}${otherPlansLine}`;
			} else {
				prompt = `${prompt}\n\n${BUILD_MODE_PROMPT.replace("{{PLAN}}", () => buildPlanSnapshot.content)}${otherPlansLine}`;
			}
		}
		if (todoModeActive && todos.length > 0) {
			prompt = `${prompt}\n\n${TODO_LIST_PROMPT.replace("{{TODOS}}", () => formatTodoList(todos))}`;
		}
		if (messages.length === 0 || messages[0]?.role !== "system") {
			messages.unshift({ role: "system", content: prompt });
		} else {
			messages[0] = { role: "system", content: prompt };
		}
	};

	// Build an assistant message from partial content and persist it into
	// `messages` so aborted/disconnected turns survive in session history.
	const persistPartialAssistant = (content: string, thinking: string) => {
		if (!content && !thinking) return;
		const assistantMsg: Message = {
			role: "assistant",
			content: content || EMPTY_ASSISTANT_PLACEHOLDER,
		};
		messages.push(assistantMsg);
		onEvent({ type: "assistant_message", content, thinking });
	};

	/** Abort end: optional interrupt reminder for the next model turn, then settle. */
	const endAborted = () => {
		const shutdown = signal?.reason === "shutdown";
		if (appendInterruptReminder(messages, shutdown ? "shutdown" : undefined)) {
			onEvent({ type: "interrupt_reminder" });
		}
		onEvent({ type: "end", reason: "aborted" });
	};

	// Accumulate partial content so aborted/disconnected turns can be
	// persisted into session history (the catch block can't read
	// streamAndCollect's locals after it throws).
	let partialContent = "";
	let partialThinking = "";

	try {
		// Outer loop: continues when follow-up messages arrive after agent would stop
		let overflowCompacted = false;
		// Tracks whether we've already yanked the largest tool result out of
		// history on this turn as an in-place context-overflow fallback. Distinct
		// from `overflowCompacted` so we still try LLM-based compaction if the
		// in-place shrink wasn't enough.
		let toolResultTrimmed = false;
		// The main agent turn loop is inherently sequential: each iteration
		// depends on the previous model response and tool results. Promise.all
		// would break causality (the model hasn't produced the next step yet).
		outer: while (true) {
			if (signal?.aborted) {
				endAborted();
				break;
			}

			// Overnight sessions: one-shot notice when the local calendar day advances.
			if (loopConfig.announcedLocalDate && appendDateRolloverReminder(messages, loopConfig.announcedLocalDate)) {
				onEvent({ type: "date_rollover", date: loopConfig.announcedLocalDate.value });
			}

			// Sync before compaction so it summarizes against the right system prompt.
			syncSystemPrompt();

			// Compaction
			if (shouldCompact(messages, config, loopConfig.lastPromptTokens)) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential agent turn loop
				const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
				if (!result.compacted && result.error) {
					onEvent({ type: "compaction_failed", reason: result.error });
				}
			}

			// Check for steering messages at start
			let pendingMessages = steeringQueue.drain();

			// Inner loop: process tool calls and steering messages
			let hasMoreToolCalls = true;
			let effectiveMaxTokens = config.maxResponseTokens;
			let reasoningRetryDone = false;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				// Inject pending steering messages
				if (pendingMessages.length > 0) {
					for (const msg of pendingMessages) {
						messages.push(msg);
					}
					onEvent({ type: "steering_injected", messages: [...pendingMessages] });
					pendingMessages = [];
					// A fresh user instruction resets the doom-loop window — "run it
					// again" after three identical calls is an explicit go-ahead, not
					// the model stuck in a loop.
					recentToolCalls.length = 0;
				}

				// Re-sync the system prompt against contextFiles that tool calls
				// from the previous inner iteration may have added — this is what
				// makes a glob rule attach immediately after its file is read.
				syncSystemPrompt();

				// Stream assistant response
				// Apply prompt caching markers to request-ready copies; the live
				// messages/tools arrays stay clean so saveSession never persists
				// the provider-specific structured-content shape.
				const cached = applyCacheControl(messages, tools);

				// Vision fallback: if the model doesn't support images (404 from
				// OpenRouter or similar), strip any image_url messages we added
				// after tool results and retry. The tool result text already
				// contains "[Image: ...]" so the agent still knows an image was
				// there — it just can't see it.
				let completion: Awaited<ReturnType<typeof streamAndCollect>>;
				// Accumulate partial content so aborted/disconnected turns can be
				// persisted into session history (the catch block can't read
				// streamAndCollect's locals after it throws).
				try {
					// biome-ignore lint/performance/noAwaitInLoops: streaming requires sequential processing
					completion = await streamAndCollect(
						client,
						currentModel,
						cached.messages,
						cached.tools,
						effectiveMaxTokens,
						signal,
						(token) => {
							partialContent += token;
							onEvent({ type: "token", text: token });
						},
						(token) => {
							partialThinking += token;
							onEvent({ type: "thinking", text: token });
						},
						config.reasoningParams.body,
						(attempt, reason) => onEvent({ type: "retry", attempt, reason }),
					);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const isVisionError =
						IMAGE_VISION_RE.test(msg) ||
						(err instanceof Error &&
							"status" in err &&
							([404, 400] as number[]).includes((err as { status: number }).status));
					const hasImages = messages.some(
						(m) =>
							m.role === "user" &&
							Array.isArray(m.content) &&
							m.content.some((p: { type?: string }) => p.type === "image_url"),
					);
					if (isVisionError && hasImages) {
						// Remove image_url user messages. Persist the removal (mark
						// them out of context) so later turns don't re-send the
						// rejected image parts and pay the 400+retry again.
						for (let i = messages.length - 1; i >= 0; i--) {
							const m = messages[i]!;
							if (
								m.role === "user" &&
								Array.isArray(m.content) &&
								m.content.some((p: { type?: string }) => p.type === "image_url")
							) {
								messages.splice(i, 1);
							}
						}
						if (loopConfig.sessionId) markImageMessagesOutOfContext(loopConfig.sessionId);
						onWarning?.("Model doesn't support images — sending file path only");
						completion = await streamAndCollect(
							client,
							currentModel,
							messages,
							tools,
							config.maxResponseTokens,
							signal,
							(token) => {
								partialContent += token;
								onEvent({ type: "token", text: token });
							},
							(token) => {
								partialThinking += token;
								onEvent({ type: "thinking", text: token });
							},
							config.reasoningParams.body,
							(attempt, reason) => onEvent({ type: "retry", attempt, reason }),
						);
					} else if (isContextOverflow(err) && !toolResultTrimmed) {
						// Cheap first attempt: shrink the largest tool result in
						// place. The shrink is in-memory (no LLM call), so it can't
						// itself overflow, and the placeholder tells the model
						// what happened so it re-fetches with a narrower scope
						// instead of asking for the same content again. If even
						// this isn't enough, the next iteration trips
						// `overflowCompacted` and tries LLM-based compaction.
						const trimmed = replaceLargestToolResult(messages);
						if (trimmed) {
							toolResultTrimmed = true;
							const reminder =
								`<system-reminder>\n` +
								`Your previous turn was rejected with a context-window overflow. The largest tool result in history (tool_call_id ${trimmed.toolCallId}, ${formatMB(trimmed.bytesRemoved)} of content) was omitted to make room. ` +
								`Re-fetch the same information with a narrower scope — read with offset/limit, grep with a tighter path/glob/pattern, or split the request into smaller calls.\n` +
								`</system-reminder>`;
							messages.push({ role: "user", content: reminder });
							onEvent({
								type: "tool_result_truncated",
								toolCallId: trimmed.toolCallId,
								bytesRemoved: trimmed.bytesRemoved,
							});
							continue outer;
						}
						// No oversized tool result to drop — flag so we don't keep
						// retrying the same in-place shrink forever, and let the
						// `overflowCompacted` branch below try LLM-based compaction.
						toolResultTrimmed = true;
					}
					if (isContextOverflow(err) && !overflowCompacted) {
						// Context overflow — compact and retry the turn instead of
						// surfacing a raw error. Only once per turn to prevent infinite
						// loops when even compacted context is too large.
						const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
						if (result.compacted) {
							overflowCompacted = true;
							// Restart the outer loop — system prompt, compaction
							// check, and fresh streamAndCollect will all run again.
							continue outer;
						}
						// Compaction itself failed — surface the original error.
						onEvent({ type: "compaction_failed", reason: msg });
						throw err;
					}
					throw err;
				}

				// A mid-stream abort doesn't always reject: undici can end the async
				// iterator cleanly, so streamAndCollect returns a partial result and no
				// exception reaches the outer catch. Without this the partial turn
				// commits as a normal stop and never shows "Aborted" — the symptom of
				// pressing Esc while reasoning streams. `interrupted` (not raw
				// signal.aborted) so a turn that *finished* right before a late Esc is
				// committed normally instead of being mislabeled aborted.
				if (completion.interrupted) {
					persistPartialAssistant(completion.content, completion.thinking);
					endAborted();
					return;
				}

				// Silent truncation: the stream ended mid-response with no finish_reason
				// and no usage, and the user didn't abort — the provider dropped it.
				// Stop and flag it so a cut-off answer isn't mistaken for a clean exit.
				if (completion.disconnected) {
					persistPartialAssistant(completion.content, completion.thinking);
					onEvent({ type: "end", reason: "disconnected" });
					return;
				}

				// Truncated with no tool call: the model spent all max_tokens without
				// reaching a tool call — whether it burned the budget on hidden
				// reasoning_content, a verbose preamble/plan, or anything else, the
				// result is the same: no usable turn to commit yet. Retry once with
				// 2x the token budget instead of accepting a stub reply (e.g. "I'll
				// rewrite the file now" with no actual write) as the model's answer.
				const truncatedNoToolCall = !completion.toolCalls?.length && completion.finishReason === "length";
				if (truncatedNoToolCall && !reasoningRetryDone) {
					reasoningRetryDone = true;
					effectiveMaxTokens *= 2;
					onWarning?.("Response truncated before a tool call — retrying with doubled budget");
					continue;
				}

				if (completion.usage) {
					onEvent({ type: "usage", usage: completion.usage, generationMs: completion.generationMs });
				}

				// Check for streaming errors (pi pattern: stopReason check)
				if (completion.finishReason === "error" || completion.finishReason === "aborted") {
					const assistantMsg: Message = {
						role: "assistant",
						content: completion.content || EMPTY_ASSISTANT_PLACEHOLDER,
					};
					messages.push(assistantMsg);
					onEvent({ type: "turn_end", toolResults: [] });
					if (completion.finishReason === "aborted") {
						endAborted();
					} else {
						onEvent({ type: "end", reason: "error" });
					}
					return;
				}

				// Build assistant message. An assistant turn must carry either
				// content or tool_calls — a turn that produced only reasoning
				// (all output in reasoning_content) would otherwise persist as
				// `content: null` with no tool_calls, a shape providers reject
				// (400) on every following turn once it's in the session.
				const hasToolCalls = Boolean(completion.toolCalls && completion.toolCalls.length > 0);
				const assistantMsg: Message & { reasoning_content?: string } = {
					role: "assistant",
					content: completion.content || (hasToolCalls ? null : EMPTY_ASSISTANT_PLACEHOLDER),
					// Kimi and Z.ai also require this native trace to be preserved for
					// subsequent turns. It is only present when the provider emitted it.
					...(completion.reasoningContent ? { reasoning_content: completion.reasoningContent } : {}),
					...(hasToolCalls
						? {
								tool_calls: completion.toolCalls!.map((tc) => ({
									id: tc.id,
									type: "function" as const,
									function: { name: tc.name, arguments: tc.arguments },
								})),
							}
						: {}),
				};
				messages.push(assistantMsg);

				onEvent({
					type: "assistant_message",
					content: completion.content,
					thinking: completion.thinking,
					toolCalls: completion.toolCalls,
				});

				// Check for tool calls
				const toolCalls = completion.toolCalls;
				const toolResults: Array<{ id: string; name: string; result: ToolResult }> = [];
				hasMoreToolCalls = false;

				if (toolCalls && toolCalls.length > 0) {
					const executedToolBatch = await executeToolCalls(
						toolCalls,
						executeTool,
						onEvent,
						signal,
						recentToolCalls,
						DOOM_LOOP_THRESHOLD,
					);
					toolResults.push(...executedToolBatch);
					hasMoreToolCalls = true;

					// Observation-only, matching the official spec (no blocking
					// semantics documented) — fire-and-forget so a slow hook here
					// doesn't add latency to every multi-tool turn.
					if (loopConfig.hooks && executedToolBatch.length > 1) {
						void runHooksForEvent(loopConfig.hooks, {
							event: "PostToolBatch",
							cwd,
							sessionId: loopConfig.sessionId,
							payload: {
								tools: executedToolBatch.map((r) => ({ name: r.name, is_error: r.result.isError === true })),
							},
							signal,
						});
					}

					// Snapshot after tools execute but before results are pushed —
					// if the process dies mid-push, at least the assistant message
					// (with tool_calls) is on disk so the model can see what was
					// attempted on restart.
					loopConfig.onMessagesChanged?.(messages);

					// Track new tool result messages and extract context files
					for (const r of executedToolBatch) {
						// castIsError is stripped in sanitizeMessages before the API —
						// kept on the wire copy so UI rebuilds (resume/compaction) can
						// show [error] instead of always painting [ok].
						const toolMsg = {
							role: "tool" as const,
							tool_call_id: r.id,
							content: r.result.content,
							...(r.result.isError ? { castIsError: true } : {}),
						} as Message;
						messages.push(toolMsg);

						// Propagate subagent usage to the main session, tagged so the UI
						// can attribute it separately from the main agent's own tokens.
						if (r.result.subagentUsage) {
							onEvent({ type: "usage", usage: r.result.subagentUsage, subagent: true });
						}

						// Extract file paths from tool calls for glob matching
						const tc = toolCalls.find((t) => t.id === r.id);
						if (tc) {
							let args: Record<string, unknown>;
							try {
								args = JSON.parse(tc.arguments);
							} catch {
								args = {};
							}
							extractContextFile(tc.name, args, r.result.content, contextFiles, cwd);
						}

						// A `role: "tool"` message can't carry image content per the
						// OpenAI-compatible chat API, so a `read` on an image file
						// follows its tool result with a separate user message
						// containing the actual image (only works if the model
						// supports vision; otherwise the provider surfaces its own
						// error, which is the honest outcome here).
						if (r.result.imageDataUrl) {
							// Per-file size is already capped (tools/files.ts's
							// MAX_IMAGE_BYTES), but nothing bounded how many of those
							// individually-fine images could pile up in one context —
							// a real incident had 5 unresized photos (~1.6MB of base64
							// combined) get a bare, undebuggable 400 from the provider.
							// No native image-resize library is bundled here (cast ships as
							// a single esbuild file; sharp's native binary doesn't fit that
							// model) — cap the running total instead of the individual
							// file, and omit gracefully past it, with a note.
							const existingImageBytes = sumEmbeddedImageBytes(messages);
							if (existingImageBytes + r.result.imageDataUrl.length > MAX_TOTAL_EMBEDDED_IMAGE_BYTES) {
								toolMsg.content = `${toolMsg.content}\n\n[Image omitted: already ${formatMB(existingImageBytes)} of images in context (limit ${formatMB(MAX_TOTAL_EMBEDDED_IMAGE_BYTES)}). Ask the user to remove earlier images, or /compact, before reading more.]`;
							} else {
								// castToolCallId isn't part of the wire format —
								// sanitizeMessages strips it before this ever reaches a
								// provider (see llm.ts). It's only here so the UI can
								// attribute this image back to the `read` call that
								// produced it instead of showing it as an unexplained
								// floating message (see toDisplayMessages).
								const imageMsg = {
									role: "user",
									content: [{ type: "image_url", image_url: { url: r.result.imageDataUrl } }],
									castToolCallId: r.id,
								} as Message;
								messages.push(imageMsg);
							}
						}
					}
				}

				onEvent({ type: "turn_end", toolResults });

				// ── Post-tool-results context guard ──
				// Tool results (especially web_fetch, read of large files, grep)
				// can push context well past the compaction threshold between the
				// outer-loop's shouldCompact check (which runs against the previous
				// turn's actual prompt-token count) and the next LLM call. There's
				// no fresh usage reading yet at this point, so fall back to the
				// char-based estimate — same threshold math as shouldCompact, just
				// fed an estimate instead of a measured value.
				if (toolCalls && toolCalls.length > 0 && shouldCompact(messages, config, estimateTokens(messages))) {
					const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
					if (!result.compacted && result.error) {
						onEvent({ type: "compaction_failed", reason: result.error });
					}
				}

				// A successful terminal (signal) tool ends the run. The whole batch
				// has already executed and its tool results are in `messages` above —
				// nothing is left dangling — and turn_end fired, which the UI needs to
				// open the mode-transition dialog (it waits for the run to settle).
				// Return rather than break the outer loop: a terminal signal hands
				// control to the user, so the follow-up queue is intentionally not
				// drained. isError is excluded so a failed plan_done (no plan on disk,
				// etc.) lets the model recover instead of stranding the turn.
				if (toolResults.some((r) => TERMINAL_TOOLS.has(r.name) && !r.result.isError)) {
					onEvent({ type: "end", reason: "stop" });
					return;
				}

				// Turn-end open-work gate: content-only stop with open plan steps
				// → inject a system-reminder and keep sampling (capped).
				if (
					(!toolCalls || toolCalls.length === 0) &&
					isOpenWorkGateActive(loopConfig.planState, todos, openWorkGateConfig)
				) {
					const openSteps = collectOpenWorkSteps(todos);
					const decision = evaluateOpenWorkGate({ openSteps });
					if (decision.type === "nudge") {
						if (openWorkGateFires < openWorkGateConfig.maxFiresPerPrompt) {
							openWorkGateFires += 1;
							onEvent({
								type: "open_work_gate",
								fires: openWorkGateFires,
								openSteps: openSteps.length,
							});
							messages.push({ role: "user", content: decision.reminder });
							hasMoreToolCalls = true;
						} else {
							// Exhausted: emit the user-facing notice and let the turn
							// end. We deliberately do NOT push anything into `messages`
							// here — the exhausted text is addressed to the user ("Falling
							// through to the user. Prompt the agent to continue
							// explicitly…"), so it would be misleading to leave it in the
							// transcript where the model would see it on resume.
							onEvent({
								type: "open_work_gate_exhausted",
								openSteps: openSteps.length,
								maxFires: openWorkGateConfig.maxFiresPerPrompt,
							});
						}
					}
				}

				// re-poll steering at end of inner iteration
				pendingMessages = steeringQueue.drain();
			}

			// Agent would stop here. Check follow-up queue (outer loop).
			const followUpMsgs = followUpQueue.drain();
			if (followUpMsgs.length > 0) {
				for (const msg of followUpMsgs) {
					messages.push(msg);
				}
				onEvent({ type: "followup_injected", messages: [...followUpMsgs] });
				overflowCompacted = false;
				toolResultTrimmed = false;
				// Same as steering: a new user message resets the doom-loop window.
				recentToolCalls.length = 0;
				openWorkGateFires = 0;
				continue;
			}

			// No more messages — done, unless a Stop hook says otherwise.
			if (loopConfig.hooks && stopHookBlocks < MAX_STOP_HOOK_BLOCKS) {
				const stopResult = await runHooksForEvent(loopConfig.hooks, {
					event: "Stop",
					cwd,
					sessionId: loopConfig.sessionId,
					payload: { stop_hook_active: stopHookBlocks > 0 },
					signal,
				});
				// forceStop (`{"continue":false}`) wins over a block from another
				// hook in the same run — end right now instead of continuing.
				if (stopResult.blocked && !stopResult.forceStop) {
					stopHookBlocks += 1;
					messages.push({
						role: "user",
						content: stopResult.reason || "A Stop hook requested more work before ending this turn.",
					});
					onEvent({ type: "followup_injected", messages: [messages[messages.length - 1]] });
					continue;
				}
			}
			onEvent({ type: "end", reason: "stop" });
			break;
		}
	} catch (error) {
		// An abort mid-stream throws (APIUserAbortError, or a connection error
		// from the socket being torn down) rather than resolving with a clean
		// finishReason — signal.aborted is the only reliable way to tell "this
		// exception is a direct result of /abort" apart from a genuine failure.
		// Without this check every abort surfaced as reason "error" (with the
		// generic message this catch produces) instead of "aborted".
		if (signal?.aborted) {
			persistPartialAssistant(partialContent, partialThinking);
			endAborted();
			return;
		}
		const message = describeTurnError(error);
		// StopFailure is observation-only (matching Grok Build) — its output is
		// never awaited-on for a decision, so it can't affect what already
		// happened; fire it and move on regardless of the result.
		if (loopConfig.hooks) {
			void runHooksForEvent(loopConfig.hooks, {
				event: "StopFailure",
				cwd,
				sessionId: loopConfig.sessionId,
				payload: { error: message },
				signal,
			});
		}
		onEvent({ type: "error", message });
		onEvent({ type: "end", reason: "error" });
	}
}

/**
 * Wraps one tool dispatch with PreToolUse/PostToolUse(Failure) hooks. A
 * PreToolUse block skips `dispatch` entirely and returns the hook's reason
 * as the tool result. Afterward, PostToolUse fires on success and
 * PostToolUseFailure fires on an error result (mutually exclusive, matching
 * Grok Build) — either way a block appends the hook's reason to the real
 * result instead of replacing it, since the tool already ran.
 */
interface ToolHookContext {
	hooks: HooksFile;
	name: string;
	args: Record<string, unknown>;
	cwd: string;
	sessionId: string | undefined;
	signal: AbortSignal | undefined;
	mcpToolIndex: Map<string, McpToolHandle> | undefined;
	config: AppConfig;
	model: string;
	onWarning?: (message: string) => void;
	toolCallId?: string;
	permissionMode?: string;
}

/**
 * Wraps one tool dispatch with PreToolUse/PostToolUse(Failure) hooks. A
 * PreToolUse `deny`/block skips `dispatch` entirely and returns the hook's
 * reason as the tool result; `updatedInput` rewrites the arguments `dispatch`
 * actually runs with. Afterward, PostToolUse fires on success and
 * PostToolUseFailure fires on an error result (mutually exclusive, matching
 * the official spec) — `updatedToolOutput` replaces the real result outright,
 * or (without it) a block just appends the hook's reason as feedback since
 * the tool already ran.
 */
async function runToolWithHooks(
	ctx: ToolHookContext,
	dispatch: (args: Record<string, unknown>) => Promise<ToolResult>,
): Promise<ToolResult> {
	const { hooks, name, cwd, sessionId, signal, mcpToolIndex, config, model, onWarning, toolCallId, permissionMode } =
		ctx;
	let args = ctx.args;
	const pre = await runHooksForEvent(hooks, {
		event: "PreToolUse",
		matchTarget: name,
		cwd,
		sessionId,
		payload: { tool_name: name, tool_input: args, tool_use_id: toolCallId },
		signal,
		mcpToolIndex,
		config,
		model,
		permissionMode,
	});
	if (pre.permissionDecision === "ask" || pre.permissionDecision === "defer") {
		onWarning?.(
			`A PreToolUse hook for "${name}" returned "${pre.permissionDecision}" — cast has no interactive mid-turn prompt to honor that, so the call was allowed.`,
		);
	}
	if (pre.blocked) {
		return { content: pre.reason || `Blocked by a PreToolUse hook for "${name}".`, isError: true };
	}
	if (pre.updatedInput) args = pre.updatedInput;
	const result = await dispatch(args);
	const postEvent = result.isError ? "PostToolUseFailure" : "PostToolUse";
	const post = await runHooksForEvent(hooks, {
		event: postEvent,
		matchTarget: name,
		cwd,
		sessionId,
		payload: {
			tool_name: name,
			tool_input: args,
			tool_response: result.content,
			tool_use_id: toolCallId,
			error: result.isError ? result.content : undefined,
			is_interrupt: signal?.aborted === true,
		},
		signal,
		mcpToolIndex,
		config,
		model,
		permissionMode,
	});
	if (post.updatedToolOutput !== undefined) return { ...result, content: post.updatedToolOutput };
	if (post.blocked) {
		// A hook can block with exit 2 and no stdout/stderr at all — reason
		// is then empty (see interpretHookOutput), and gating on `post.reason`
		// here used to silently drop the block entirely, unlike PreToolUse's
		// equivalent branch above which always falls back to a message.
		const reason = post.reason || `Blocked by a ${postEvent} hook for "${name}".`;
		return { ...result, content: `${result.content}\n\n[Hook feedback: ${reason}]` };
	}
	return result;
}

// ============================================================================
// Tool execution — parallel
// ============================================================================

interface ToolCallResult {
	id: string;
	name: string;
	result: ToolResult;
}

async function executeToolCalls(
	toolCalls: Array<{ id: string; name: string; arguments: string }>,
	executeTool: (
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		toolCallId?: string,
	) => Promise<ToolResult>,
	onEvent: (event: AgentEvent) => void,
	signal: AbortSignal | undefined,
	recentToolCalls: Array<{ name: string; argsKey: string }>,
	doomLoopThreshold: number,
): Promise<ToolCallResult[]> {
	const prepared: Array<{ id: string; name: string; args: Record<string, unknown> | null }> = [];
	for (const tc of toolCalls) {
		let args: Record<string, unknown>;
		try {
			args = JSON.parse(tc.arguments);
		} catch {
			// Truncated or malformed arguments (e.g. streaming cut off mid-generation).
			// Don't execute with empty {} — that turns every tool into a confusing error.
			prepared.push({ id: tc.id, name: tc.name, args: null });
			continue;
		}
		prepared.push({ id: tc.id, name: tc.name, args });
	}

	for (const tc of prepared) {
		onEvent({
			type: "tool_start",
			id: tc.id,
			name: tc.name,
			args: tc.args ? JSON.stringify(tc.args) : "{}",
			status: "running",
		});
	}

	// Doom-loop detection, decided sequentially in call order BEFORE the
	// parallel execution below. Inside Promise.all every sibling's check runs
	// before any sibling's push lands (the synchronous prefix of each async fn
	// executes first), so checking/pushing per-call in there made a whole batch
	// of identical calls invisible to itself — and pushing after `await
	// executeTool` recorded completion order, not call order, scrambling the
	// "consecutive" window around parallel batches. A blocked call is NOT
	// pushed: repeat attempts stay blocked until a different call breaks the
	// run of identical entries.
	const doomBlocked = new Set<string>();
	for (const tc of prepared) {
		if (tc.args === null) continue;
		if (DOOM_LOOP_EXEMPT.has(tc.name)) continue;
		const argsKey = JSON.stringify(tc.args);
		const recent = recentToolCalls.slice(-doomLoopThreshold);
		if (recent.length === doomLoopThreshold && recent.every((r) => r.name === tc.name && r.argsKey === argsKey)) {
			doomBlocked.add(tc.id);
			onEvent({ type: "doom_loop", tool: tc.name, attempts: doomLoopThreshold });
		} else {
			recentToolCalls.push({ name: tc.name, argsKey });
		}
	}
	// Keep the sliding window bounded.
	if (recentToolCalls.length > doomLoopThreshold * 2) {
		recentToolCalls.splice(0, recentToolCalls.length - doomLoopThreshold);
	}

	// setMaxListeners(100, signal) is already called once in runLoop — no need
	// to raise it per-batch (and doing so with a small batch would *lower* it).

	const settled = new Map<string, ToolCallResult>();
	const toolPromises = prepared.map(async (tc): Promise<ToolCallResult> => {
		const runOne = async (): Promise<ToolCallResult> => {
			if (signal?.aborted) {
				return abortedToolResult(tc);
			}

			// Truncated/malformed arguments — return an error so the model can retry.
			if (tc.args === null) {
				return {
					id: tc.id,
					name: tc.name,
					result: {
						content: "Tool call arguments were truncated or malformed (invalid JSON). Retry the tool call.",
						isError: true,
					},
				};
			}

			if (doomBlocked.has(tc.id)) {
				return {
					id: tc.id,
					name: tc.name,
					result: {
						content: `Doom loop detected: tool "${tc.name}" was called ${doomLoopThreshold} times consecutively with the same arguments. You MUST try a completely different approach. Do NOT call this tool with the same arguments again.`,
						isError: true,
					},
				};
			}

			let result: ToolResult;
			try {
				result = await executeTool(tc.name, tc.args, signal, tc.id);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result = { content: message, isError: true };
			}

			return { id: tc.id, name: tc.name, result };
		};

		const result = await runOne();
		const normalized = { ...result, result: normalizeToolResultError(result.result) };
		settled.set(tc.id, normalized);
		return normalized;
	});

	// Abort must always end the turn: cooperating tools (bash/web/ssh) kill
	// themselves on the signal and settle within a few hundred ms, but a tool
	// that ignores it (a hung MCP server, a stalled remote transport) would
	// otherwise keep Promise.all — and with it the whole turn — open
	// indefinitely. Bound the wait: grace for the stragglers, then force the
	// batch closed with ABORTED results for anything still running.
	const results = await waitForToolBatch(toolPromises, prepared, settled, signal);

	for (const { id, name, result } of results) {
		onEvent({ type: "tool_end", id, name, result, status: completedToolCallStatus(result.isError) });
	}

	return results;
}

function abortedToolResult(tc: { id: string; name: string }): ToolCallResult {
	return {
		id: tc.id,
		name: tc.name,
		result: { content: "[ABORTED] Tool execution was cancelled.", isError: true },
	};
}

/** How long after an abort the tool batch waits for stragglers to settle
 * before being forced closed (see waitForToolBatch). */
export const TOOL_ABORT_GRACE_MS = 2000;

/**
 * Await a parallel tool batch, bounded by the abort signal. Signal-cooperating
 * tools (bash, web, ssh, task) resolve within a few hundred ms of the signal;
 * a tool that ignores it (a hung MCP server) would otherwise keep the caller
 * waiting forever. Once the signal fires, wait GRACE for the stragglers, then
 * resolve with ABORTED results for anything still in flight — the turn can
 * always end.
 */
export async function waitForToolBatch<T extends { id: string; name: string }>(
	toolPromises: Promise<ToolCallResult>[],
	prepared: T[],
	settled: Map<string, ToolCallResult>,
	signal: AbortSignal | undefined,
): Promise<ToolCallResult[]> {
	if (!signal) return Promise.all(toolPromises);

	return new Promise<ToolCallResult[]>((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			// Real results for tools that settled (in prepared order); ABORTED
			// placeholders for anything the grace caught still running.
			resolve(prepared.map((tc) => settled.get(tc.id) ?? abortedToolResult(tc)));
		};
		// Normal completion — every tool settled, all results already in the map.
		void Promise.all(toolPromises).then(finish);
		if (signal.aborted) {
			// Not unref'd: even with a straggler that holds no I/O, the turn
			// must resolve so the UI lands on "aborted" and the session saves.
			setTimeout(finish, TOOL_ABORT_GRACE_MS);
		} else {
			signal.addEventListener(
				"abort",
				() => {
					setTimeout(finish, TOOL_ABORT_GRACE_MS);
				},
				{ once: true },
			);
		}
	});
}

// ============================================================================
// Context file tracking — extracts paths from tool calls for glob matching
// ============================================================================

function extractContextFile(
	_toolName: string,
	args: Record<string, unknown>,
	_result: string,
	contextFiles: string[],
	cwd: string,
): void {
	const rawPath = typeof args.path === "string" ? args.path : undefined;
	if (!rawPath) return;

	// Normalize to relative path from cwd for consistent glob matching
	let relPath: string;
	if (rawPath.startsWith("/")) {
		relPath = rawPath.startsWith(cwd) ? rawPath.slice(cwd.length + 1) : rawPath;
	} else {
		relPath = rawPath;
	}

	if (!contextFiles.includes(relPath)) {
		contextFiles.push(relPath);
	}
}
