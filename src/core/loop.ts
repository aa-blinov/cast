import { setMaxListeners } from "node:events";
import { basename, join } from "node:path";
import {
	type AgentForkContext as ActorForkContext,
	type AgentActorRecoverySpec,
	type AgentActorSnapshot,
	type AgentForkRuntimeSnapshot,
	agentActorRegistry,
} from "./actors.ts";
import {
	buildCheckpointRepairPrompt,
	type CheckpointValidationIssue,
	extractDiscoveredTitles,
	hasBlockingCheckpointIssues,
	validateCheckpointArtifacts,
} from "./checkpoint-validation.ts";
import {
	formatPostCompactReminder,
	injectPostCompactReminder,
	type PostCompactReminderState,
	reminderStateFromPlan,
} from "./compaction-reminder.ts";
import type { AppConfig, ProviderCredentials } from "./config.ts";
import { type AnnouncedLocalDate, appendDateRolloverReminder } from "./date-rollover-reminder.ts";
import { matchesToolsAllowlist } from "./frontmatter.ts";
import {
	coerceHooksObject,
	type HookEvent,
	type HookMatcherGroup,
	type HookRunResult,
	type HooksFile,
	mergeHooks,
	runHooksForEvent,
} from "./hooks.ts";
import { appendInterruptReminder } from "./interrupt-reminder.ts";
import type { Message, Tool, Usage } from "./llm.ts";
import {
	applyCacheControl,
	createClient,
	describeTurnError,
	EMPTY_ASSISTANT_PLACEHOLDER,
	isContextOverflow,
	promptCacheRequestBody,
	resolvePromptCacheStrategy,
	streamAndCollect,
} from "./llm.ts";
import { closeMcpConnections, type McpToolHandle, mcpServerNameFromDescription } from "./mcp.ts";
import {
	type CheckpointWriterHandle,
	type CheckpointWriterToolRuntime,
	createProjectMemoryService,
	DEFAULT_REBUILD_GLOBAL_CAP,
	DEFAULT_REBUILD_MEMORY_CAP,
	type MemoryCheckpointWriterInput,
	type MemoryMaintenanceAgentInput,
	type MemoryMaintenanceAgentResult,
	type MemoryService,
	projectIdForCwd,
	readMemorySectionsWithinBudget,
	reconcileProjectMemoryFiles,
	runAutomaticMemoryMaintenanceRun,
	scheduleAutomaticMemoryMaintenance,
	scheduleProjectCheckpointWriter,
	waitForProjectCheckpointWriter,
} from "./memory.ts";
import {
	checkpointPath,
	ensureMemoryFiles,
	globalMemoryPath,
	notesPath,
	projectMemoryPath,
	readMemoryFile,
	readProjectMemory,
	readSessionMemory,
	tasksDir,
	writeMemoryFile,
} from "./memory-files.ts";
import {
	collectOpenWorkSteps,
	defaultOpenWorkGateConfig,
	evaluateOpenWorkGate,
	isOpenWorkGateActive,
	type OpenWorkGateConfig,
} from "./open-work-gate.ts";
import type { Persona } from "./personas.ts";
import { checkReadOnlyCommand, listPlanNames, readActivePlan, TERMINAL_TOOL_NAMES } from "./plan.ts";
import { type ProjectResolverDeps, resolveMcpForCwd } from "./project.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";
import {
	commitCheckpointWatermark,
	compactMessages,
	createSession,
	estimateTokens,
	fileTagsFromCompactionSummary,
	findCheckpointBoundaryForMessages,
	getCheckpointWatermark,
	getMessagesAfterCheckpoint,
	loadSession,
	markImageMessagesOutOfContext,
	saveSession,
	shouldCompact,
} from "./session.ts";
import {
	checkpointFork as checkpointForkSetting,
	checkpointPushCapsSetting,
	checkpointReservedSetting,
	checkpointThresholdsSetting,
	isMemoryEnabled,
	isMemoryWriteEnabled,
	loadSettings,
	memoryPromptBudget,
} from "./settings.ts";
import { resolveSshHosts, type SshHost } from "./ssh.ts";
import type { SubagentPrompt } from "./subagents.ts";
import { recordLlmRequest } from "./telemetry.ts";
import { formatTodoList, remainingTodoCount, type TodoItem, validateTodos } from "./todo.ts";
import { BackgroundTaskRegistry } from "./tools/bash-background.ts";
import {
	type CompletedToolCallStatus,
	completedToolCallStatus,
	normalizeToolResultError,
	relativeToCwd,
} from "./tools/shared.ts";
import {
	type BashBackgroundDeps,
	type ConfirmBash,
	type ConfirmWrite,
	createToolExecutor,
	getToolDefinitions,
	type ToolResult,
} from "./tools.ts";
import { acquireTurnRunner, clearTurnRunner, markTurnRunner, releaseTurnRunner } from "./turn-runner-state.ts";

const IMAGE_VISION_RE = /image|vision/i;
const MEMORY_EMPTY_LINE_RE = /^\(none/;
const DEFAULT_MEMORY_SERVICE = createProjectMemoryService();

// How many identical consecutive tool calls (same name + same args) before
// we treat it as a doom loop and block execution — the model gets an error
// result and must try something different.
const DOOM_LOOP_THRESHOLD = 3;
// Safety cap for turns without an explicit /goal budget: a model that keeps
// calling DIFFERENT tools (so the doom-loop detector can't catch it) must not
// loop forever. Matches the settings default; the bridge overrides it with the
// configured maxTurnIterations each submit. The work done so far is persisted
// per tool batch, so hitting it loses nothing.
const DEFAULT_OUTER_ITERATION_CAP = 500;
export { DEFAULT_OUTER_ITERATION_CAP };
const MEMORY_RECALL_HINT = [
	"<system-reminder>",
	"Durable project or global memory may contain prior decisions, facts, or user preferences.",
	"When relevant, search it with the memory tool using 1–3 distinctive terms before asking the user.",
	"</system-reminder>",
].join("\n");
const MEMORY_SYSTEM_PROMPT = readRequiredPrompt(promptsDir, "memory-system.md");
const CHECKPOINT_REPAIR_ATTEMPTS = 2;
const CHECKPOINT_WRITER_TIMEOUT_MS = 5 * 60_000;
const CHECKPOINT_REBUILD_WAIT_MS = 30_000;
const CHECKPOINT_FIRST_REBUILD_WAIT_MS = 5 * 60_000;

/**
 * Reduce every path-like token in a todo's text to its basename, so a rewritten
 * item still matches the one it replaces when the model shortened the paths in
 * it. Used only to carry `planStep` across a `todo_write`; never stored.
 */
export function shortenPathsForTodoMatch(content: string): string {
	return content.replace(/\S*\/(\S+)/g, "$1").trim();
}

function memoryPromptBudgetTokens(config: AppConfig): number {
	const inputBudget = Math.max(0, config.contextWindow - config.maxResponseTokens);
	const settings = loadSettings();
	const configuredBudget =
		typeof settings.memoryPromptBudget === "number"
			? memoryPromptBudget(settings)
			: Math.min(4_096, Math.max(256, Math.floor(inputBudget * 0.05)));
	return Math.min(configuredBudget, Math.max(256, inputBudget));
}

/** True once a memory file has at least one line of real content — not just headings, italic scaffolding comments, or blank lines. */
function isMeaningfulMemoryText(text: string): boolean {
	return text.split("\n").some((line) => {
		const value = line.trim();
		return value.length > 0 && !value.startsWith("#") && !value.startsWith("_") && !MEMORY_EMPTY_LINE_RE.test(value);
	});
}

function hasMemoryOrTasks(cwd: string, sessionId: string): boolean {
	const projectText = readProjectMemory(projectIdForCwd(cwd));
	const globalText = readMemoryFile(globalMemoryPath());
	const sessionMemory = readSessionMemory(sessionId);
	return (
		isMeaningfulMemoryText(projectText) ||
		isMeaningfulMemoryText(globalText) ||
		isMeaningfulMemoryText(sessionMemory.checkpoint) ||
		isMeaningfulMemoryText(sessionMemory.notes) ||
		Boolean(sessionMemory.taskProgress.trim())
	);
}

// Global memory is meant to hold a short list of cross-project user
// preferences (see prompts/memory-system.md) — small enough that, unlike
// project memory, it's worth always loading in full rather than relying on
// the model to think to search for it (see hasMemoryOrTasks/
// MEMORY_RECALL_HINT for that pull-based path, kept for project memory).
// Reuses the same checkpointPushCaps setting/defaults as the checkpoint
// rebuild context (memory.ts) — same content, same reasonable size budget,
// already user-configurable via Settings → Memory → Caps, rather than a
// second, smaller set of magic numbers for what's otherwise the same data.

/** Appends a bounded "already loaded" block for `text` under `heading`, or returns `prompt` unchanged when `text` has no real content. */
function withInlinedMemorySection(prompt: string, heading: string, text: string, tokenCap: number): string {
	if (!isMeaningfulMemoryText(text)) return prompt;
	const { text: bounded } = readMemorySectionsWithinBudget(text, tokenCap);
	return `${prompt}\n\n## ${heading} (already loaded)\nThe following is already in your context — do not Read the file itself.\n\n${bounded}`;
}

function memorySystemPrompt(cwd: string, sessionId: string): string {
	const projectId = projectIdForCwd(cwd);
	let prompt = MEMORY_SYSTEM_PROMPT.replace("{{MEMORY_PATH}}", projectMemoryPath(projectId))
		.replace("{{GLOBAL_MEMORY_PATH}}", globalMemoryPath())
		.replace("{{CHECKPOINT_PATH}}", checkpointPath(sessionId))
		.replace("{{NOTES_PATH}}", notesPath(sessionId));
	const caps = checkpointPushCapsSetting() ?? {};
	// Pushed unconditionally when present (nothing when absent) rather than
	// left purely pull-based — relying on the model to proactively decide to
	// search project/global memory before it's relevant proved unreliable in
	// practice (confirmed live: a saved preference with no direct question
	// attached to it didn't reliably get looked up). Session checkpoint/
	// notes/task-progress stay pull-only (via MEMORY_RECALL_HINT below) and
	// fully pushed only at an actual checkpoint rebuild — they're
	// session-in-progress state, not "read this once at the start" material.
	prompt = withInlinedMemorySection(
		prompt,
		"Project memory",
		readProjectMemory(projectId),
		caps.memory ?? DEFAULT_REBUILD_MEMORY_CAP,
	);
	prompt = withInlinedMemorySection(
		prompt,
		"Global memory",
		readMemoryFile(globalMemoryPath()),
		caps.global ?? DEFAULT_REBUILD_GLOBAL_CAP,
	);
	return prompt;
}

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

// Only tools with an explicit read-only contract may share a Promise.all
// group. Unknown/MCP tools, shells, subagents, and stateful plan tools stay
// ordered so a sibling mutation cannot race another tool in the same model
// response. Read-only calls remain parallel when they are adjacent.
export const PARALLEL_SAFE_TOOL_NAMES = new Set([
	"glob",
	"grep",
	"ls",
	"memory",
	"session_history",
	"web_search",
	"web_fetch",
	"bash_output",
]);

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
const CHECKPOINT_WRITER_SYSTEM_PROMPT = readRequiredPrompt(promptsDir, "checkpoint-writer-system.md");

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
	if (loopConfig.memory?.sessionId) {
		const waitMs =
			getCheckpointWatermark(loopConfig.memory.sessionId) === undefined
				? CHECKPOINT_FIRST_REBUILD_WAIT_MS
				: CHECKPOINT_REBUILD_WAIT_MS;
		const writerState = await waitForProjectCheckpointWriter(
			loopConfig.cwd,
			loopConfig.memory.sessionId,
			waitMs,
			signal,
		);
		if (writerState === "timed-out") {
			loopConfig.onWarning?.("Checkpoint writer did not settle before rebuild; using the last durable files");
		}
	}
	if (loopConfig.hooks) {
		// PreCompact is documented as able to cancel compaction, and the manual
		// /compact path honours it — but here the result was awaited and thrown
		// away, so a guard the user wrote to protect a long transcript worked
		// everywhere except the automatic threshold, which is the one that
		// actually fires on its own.
		const preCompact = await runHooksForEvent(loopConfig.hooks, {
			event: "PreCompact",
			cwd: loopConfig.cwd,
			sessionId: loopConfig.sessionId,
			payload: { trigger: "auto" },
			signal,
		});
		if (preCompact.blocked) {
			loopConfig.onWarning?.(
				preCompact.reason
					? `Compaction blocked by a PreCompact hook: ${preCompact.reason}`
					: "Compaction blocked by a PreCompact hook.",
			);
			return { messages, compacted: false, messagesCompacted: 0, tokensBefore: 0 };
		}
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
	| { type: "usage"; usage: Usage; generationMs?: number; ttftMs?: number; subagent?: boolean; background?: boolean }
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
	/** Enables durable project memory after a completed turn. A service override
	 * keeps the loop independent from the SQLite implementation in tests. */
	memory?: { sessionId: string; service?: MemoryService };
	onEvent: (event: AgentEvent) => void;
	/** Non-fatal warning shown to the user (e.g. vision fallback). */
	onWarning?: (message: string) => void;
	signal?: AbortSignal;
	steeringQueue?: MessageQueue;
	followUpQueue?: MessageQueue;
	confirmBash?: ConfirmBash;
	/** Hard cap on outer-loop iterations (each iteration is one LLM call plus
	 * its tool batch). Goal mode sets this so an autonomous run can't loop
	 * forever on different-but-unproductive tool calls; the model is nudged
	 * before the cap and a notice is emitted when it's hit. */
	maxOuterIterations?: number;
	/** Runaway backstop for ordinary turns (no /goal budget): the configurable
	 * `maxTurnIterations` setting, read fresh on each submit. */
	defaultOuterIterations?: number;
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
	/** Use an immutable parent tool registry for a cache-preserving fork. */
	toolDefinitionsOverride?: Tool[];
	/** Tools that may actually execute when the advertised fork registry is broader. */
	executionAllowedTools?: Set<string>;
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
	/** Suppress automatic compaction in this loop. Used by short-lived system
	 * agents (checkpoint writer): a self-compacted maintenance session can lose
	 * the thread mid-repair, so it should fail explicitly instead. */
	skipCompaction?: boolean;
	/** Nested in-process run (task-tool subagent): skip the cross-process
	 * turn-runner lock — the parent holds it for the same session, and the
	 * subagent runs synchronously inside the parent's awaited tool call. */
	skipTurnRunnerLock?: boolean;
	/** Last durable checkpoint boundary in the current message snapshot. */
	checkpointBoundary?: number;
	/** Checkpoint writer prefix-fork mode; false uses only the post-checkpoint delta. */
	checkpointFork?: boolean;
	/** Override the checkpoint writer trigger points (% of window). Falls back to the setting, then the window defaults. */
	checkpointThresholds?: number[];
	/** Request-only cache marker for the fork prefix. */
	cachePrefixBoundary?: number;
	/** Run configured dream/distill maintenance when this is a fresh top-level session. */
	automaticMemoryMaintenance?: boolean;
	/** Completed session snapshot used by automatic maintenance; excludes the new user turn. */
	automaticMemoryMessages?: Message[];
	/** Receives the background checkpoint writer handle after it is scheduled. */
	onCheckpointWriter?: (handle: CheckpointWriterHandle) => void;
	/** Parent fork captured after the final prompt/tool assembly for checkpoint writers. */
	checkpointForkContext?: AgentForkContext;
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

function checkpointWriterPrompt(input: MemoryCheckpointWriterInput): string {
	const projectId = projectIdForCwd(input.cwd);
	const projectMemory = projectMemoryPath(projectId);
	ensureMemoryFiles(input.sessionId, projectId);
	return [
		"You are operating in checkpoint-writer mode for this request. Ignore the general coding-agent task framing and perform only checkpoint and project-memory maintenance.",
		input.checkpointFork === true
			? "The parent fork's complete tool registry is available and executable. Use the exact parent tool contract when the checkpoint work requires it; do not assume that only file tools are available."
			: "This is a dedicated checkpoint-writer tool registry. Use the tools advertised for this writer and do not assume that parent-only tools are available.",
		"",
		"Checkpoint paths — use these absolute paths verbatim:",
		`CHECKPOINT_PATH = ${checkpointPath(input.sessionId)}`,
		`MEMORY_PATH = ${projectMemory}`,
		`TASK_MEM_DIR = ${tasksDir(input.sessionId)}`,
		`NOTES_PATH = ${notesPath(input.sessionId)}`,
		"",
		"Read the existing checkpoint, MEMORY.md, and notes.md first. Update the files in place using the file tools. Keep all required checkpoint sections. Do not edit source code.",
		"For every discovered knowledge entry, include a concise Why: and How to apply: line. Keep Next concrete; do not write filler such as continue or resume.",
		"If a section exceeds its budget, move the least important material into a topic-named checkpoint-<topic>.md or MEMORY-<topic>.md spillover and leave a short index line.",
		"",
		`Fork boundary message index: ${input.checkpointBoundary ?? -1}`,
		"The forked conversation before this instruction is the source of truth. Read the existing files, then update them in place.",
	].join("\n");
}

export function createAgentForkRuntimeSnapshot(loopConfig: LoopConfig): AgentForkRuntimeSnapshot {
	return {
		personas: loopConfig.personas ? structuredClone(loopConfig.personas) : undefined,
		currentPersona: loopConfig.currentPersona,
		subagentPrompts: loopConfig.subagentPrompts ? structuredClone(loopConfig.subagentPrompts) : undefined,
		subagentModel: loopConfig.subagentModel,
		subagentModelProvider: loopConfig.subagentModelProvider
			? { baseURL: loopConfig.subagentModelProvider.baseURL }
			: undefined,
		disabledTools: loopConfig.disabledTools ? [...loopConfig.disabledTools] : undefined,
		allowedTools: loopConfig.allowedTools,
		projectTrusted: loopConfig.projectTrusted,
		permissionMode: loopConfig.permissionMode,
		noSkills: loopConfig.noSkills,
		cliSkillPaths: loopConfig.cliSkillPaths,
		planState: loopConfig.planState
			? {
					enabled: loopConfig.planState.enabled,
					plansDir: loopConfig.planState.plansDir,
					activePlanPath: loopConfig.planState.activePlanPath,
					planQuestion: loopConfig.planState.planQuestion,
					planTransition: loopConfig.planState.planTransition,
				}
			: undefined,
		hooks: loopConfig.hooks ? structuredClone(loopConfig.hooks) : undefined,
		skills: loopConfig.skills ? structuredClone(loopConfig.skills) : undefined,
		sshHostNames: loopConfig.sshHosts?.map((host) => host.name),
		mcpServerNames: loopConfig.mcpTools
			?.map((tool) => mcpServerNameFromDescription(tool.function.description))
			.filter((name): name is string => name !== undefined),
		mcpToolNames: loopConfig.mcpTools?.map((tool) => tool.function.name),
		mcpPromptSuffix: loopConfig.mcpPromptSuffix,
	};
}

function checkpointWriterRuntime(loopConfig: LoopConfig): CheckpointWriterToolRuntime {
	const runtimeSnapshot = createAgentForkRuntimeSnapshot(loopConfig);
	return {
		confirmBash: loopConfig.confirmBash,
		confirmWrite: loopConfig.confirmWrite,
		mcpTools: loopConfig.mcpTools,
		mcpToolIndex: loopConfig.mcpToolIndex,
		personas: loopConfig.personas,
		currentPersona: loopConfig.currentPersona,
		subagentPrompts: loopConfig.subagentPrompts,
		subagentModel: loopConfig.subagentModel,
		subagentModelProvider: loopConfig.subagentModelProvider,
		disabledTools: loopConfig.disabledTools,
		allowedTools: loopConfig.allowedTools,
		projectTrusted: loopConfig.projectTrusted,
		noSkills: loopConfig.noSkills,
		cliSkillPaths: loopConfig.cliSkillPaths,
		planState: loopConfig.planState,
		hooks: loopConfig.hooks,
		skills: loopConfig.skills,
		sshHosts: loopConfig.sshHosts,
		backgroundBash: loopConfig.backgroundBash,
		mcpPromptSuffix: loopConfig.mcpPromptSuffix,
		beforeFileWrite: loopConfig.beforeFileWrite,
		snapshot: runtimeSnapshot,
	};
}

function checkpointWriterRecoverySpec(input: MemoryCheckpointWriterInput): AgentActorRecoverySpec {
	return {
		kind: "checkpoint-writer",
		cwd: input.cwd,
		sessionId: input.sessionId,
		writerSessionId: input.writerSessionId,
		parentSystemPrompt: input.parentSystemPrompt,
		model: input.model,
		providerBaseURL: input.providerOverride?.baseURL ?? input.config.baseURL,
		checkpointBoundary: input.checkpointBoundary ?? -1,
		checkpointFork: input.checkpointFork === true,
		config: {
			baseURL: input.config.baseURL,
			contextWindow: input.config.contextWindow,
			maxResponseTokens: input.config.maxResponseTokens,
			compactionThreshold: input.config.compactionThreshold,
			maxToolOutputLines: input.config.maxToolOutputLines,
			maxToolOutputBytes: input.config.maxToolOutputBytes,
			defaultBashTimeout: input.config.defaultBashTimeout,
			reasoningLevel: input.config.reasoningLevel,
			reasoningParams: input.config.reasoningParams,
			reasoningFormat: input.config.reasoningFormat,
		},
	};
}

/** Immutable parent-side context captured for a background agent fork. */
export type AgentForkContext = ActorForkContext;

export type AgentContextFork = AgentForkContext;

export function createAgentForkContext(
	messages: Message[],
	boundaryIndex: number,
	metadata?: Pick<
		AgentForkContext,
		| "systemPrompt"
		| "toolNames"
		| "toolDefinitions"
		| "allowedTools"
		| "disabledTools"
		| "readOnlyBash"
		| "permissionMode"
		| "model"
		| "runtime"
	>,
): AgentForkContext {
	const snapshot = structuredClone([...messages]);
	const boundary = Math.max(-1, Math.min(boundaryIndex, snapshot.length - 1));
	return {
		messages: snapshot,
		inheritedMessages: snapshot,
		prefix: snapshot.slice(0, boundary + 1),
		tail: snapshot.slice(boundary + 1),
		boundaryIndex: boundary,
		cachePrefixBoundary: boundary >= 0 ? boundary : undefined,
		...metadata,
	};
}

export function createAgentContextFork(messages: Message[], boundaryIndex: number): AgentForkContext {
	return createAgentForkContext(messages, boundaryIndex);
}

function checkpointWriterMessages(fork: AgentForkContext, forkMode: boolean): Message[] {
	// A first checkpoint has no prior durable boundary, so both modes receive the
	// complete transcript. Later no-fork writers only receive the new delta.
	if (fork.boundaryIndex < 0) return fork.inheritedMessages;
	if (forkMode) return fork.prefix;
	const firstUser = fork.tail.findIndex((message) => message.role === "user");
	return firstUser < 0 ? [] : fork.tail.slice(firstUser);
}

interface BackgroundAgentContext {
	config: AppConfig;
	model: string;
	providerOverride?: ProviderCredentials;
}

// Background sessions (memory maintenance, checkpoint writer) run outside the
// bridge's onEvent, so their usage never reached telemetry — memory
// maintenance in particular is a steady, non-trivial share of total tokens.
// Same provider-name resolution the bridge uses for the chat footer.
function recordBackgroundUsage(
	context: BackgroundAgentContext,
	event: { usage: Usage; generationMs?: number; ttftMs?: number },
): void {
	const settings = loadSettings();
	const baseURL = context.providerOverride?.baseURL ?? context.config.baseURL;
	const apiKey = context.providerOverride?.apiKey ?? context.config.apiKey;
	const provider = (settings.providers ?? []).find((p) => p.url === baseURL && p.apiKey === apiKey);
	recordLlmRequest({
		provider: provider?.name ?? "default",
		model: context.model,
		kind: "background",
		promptTokens: event.usage.promptTokens,
		completionTokens: event.usage.completionTokens,
		cacheReadTokens: event.usage.cacheReadTokens,
		cacheWriteTokens: event.usage.cacheWriteTokens,
		cost: event.usage.cost,
		latencyMs: event.generationMs,
		ttftMs: event.ttftMs,
		contextWindow: context.config.contextWindow,
	});
}

export async function runMemoryMaintenanceAgent(
	input: MemoryMaintenanceAgentInput,
): Promise<MemoryMaintenanceAgentResult> {
	const controller = new AbortController();
	// Cap a single maintenance pass at 3 minutes (matches the bash default):
	// long enough for a big project to consolidate, short enough that a hung
	// background run can't linger.
	const timeout = setTimeout(() => controller.abort(), 180_000);
	timeout.unref();
	const abortFromParent = () => controller.abort();
	input.signal?.addEventListener("abort", abortFromParent, { once: true });
	let usage: Usage | undefined;
	try {
		const messages = await runAgentLoop([{ role: "user", content: input.prompt }], {
			config: input.config,
			model: input.model,
			modelProvider: input.providerOverride,
			cwd: input.cwd,
			systemPrompt: input.systemPrompt,
			signal: controller.signal,
			onEvent: (event) => {
				if (event.type === "usage") {
					usage = event.usage;
					input.onUsage?.(event.usage);
					recordBackgroundUsage(input, event);
				}
			},
			onWarning: () => {},
			allowedTools: ["bash", "read", "write", "edit", "glob", "grep"],
			readOnlyBash: true,
			disabledTools: new Set(["task", "memory", "web_search", "web_fetch", "ssh", "skill"]),
			personas: [],
			subagentPrompts: [],
			mcpTools: [],
			skills: [],
			noSkills: true,
			projectTrusted: false,
		});
		return { messages, usage };
	} finally {
		input.signal?.removeEventListener("abort", abortFromParent);
		clearTimeout(timeout);
	}
}

async function runCheckpointWriter(input: MemoryCheckpointWriterInput): Promise<void> {
	if (!isMemoryWriteEnabled()) return;
	const forkMode = input.checkpointFork === true;
	// Fork mode re-anchors the parent fork at the CURRENT transcript end: the
	// forked prefix must cover the latest turn (the whole point of the
	// cache-preserving fork) and the watermark commit must advance past the
	// previous durable boundary. Anchoring at the last durable boundary would
	// stall the checkpoint: the writer would never see new messages and the
	// watermark could never move past them.
	const forkBoundary = forkMode ? lastNonSystemIndex(input.messages) : (input.checkpointBoundary ?? -1);
	const fork =
		forkMode && input.parentForkContext
			? createAgentForkContext(input.messages, forkBoundary, {
					systemPrompt: input.parentForkContext.systemPrompt,
					toolNames: input.parentForkContext.toolNames,
					toolDefinitions: input.parentForkContext.toolDefinitions,
					allowedTools: input.parentForkContext.allowedTools,
					disabledTools: input.parentForkContext.disabledTools,
					readOnlyBash: input.parentForkContext.readOnlyBash,
					permissionMode: input.parentForkContext.permissionMode,
					model: input.parentForkContext.model,
					runtime: input.parentForkContext.runtime,
				})
			: input.parentForkContext
				? structuredClone(input.parentForkContext)
				: createAgentForkContext(input.messages, forkBoundary, {
						systemPrompt: input.parentSystemPrompt,
						model: input.model,
					});
	if (forkMode) {
		if (forkBoundary < 0) return;
	} else {
		fork.cachePrefixBoundary = undefined;
		if (fork.boundaryIndex >= 0 && checkpointWriterMessages(fork, false).length === 0) return;
	}
	const writerSession = input.writerSessionId
		? loadSession(input.writerSessionId)
		: createSession(input.model, input.cwd, {
				title: `checkpoint-writer: ${input.sessionId}`,
				parentSessionId: input.sessionId,
				sessionKind: "background",
				backgroundKind: "checkpoint-writer",
			});
	if (!writerSession) throw new Error(`Checkpoint writer session ${input.writerSessionId} was not found`);
	const projectId = projectIdForCwd(input.cwd);
	const artifactPaths = {
		checkpoint: checkpointPath(input.sessionId),
		memory: projectMemoryPath(projectId),
		notes: notesPath(input.sessionId),
	};
	const previousArtifacts = {
		checkpoint: readMemoryFile(artifactPaths.checkpoint),
		memory: readMemoryFile(artifactPaths.memory),
		notes: readMemoryFile(artifactPaths.notes),
	};
	let writerMessages = [
		...checkpointWriterMessages(fork, forkMode),
		{ role: "user" as const, content: checkpointWriterPrompt(input) },
	];
	writerSession.messages = structuredClone(writerMessages);
	saveSession(writerSession);
	const actorSpec = {
		parentSessionId: input.sessionId,
		sessionId: writerSession.id,
		agent: "checkpoint-writer",
		mode: "subagent" as const,
		background: true,
		lifecycle: "persistent" as const,
		forkContext: fork,
		recovery: checkpointWriterRecoverySpec({ ...input, writerSessionId: writerSession.id }),
	};
	const actor = input.writerActorId
		? agentActorRegistry.resume(input.writerActorId, input.signal, actorSpec)
		: agentActorRegistry.spawn(actorSpec, input.signal);
	if (!actor) throw new Error(`Checkpoint writer actor ${input.writerActorId} is no longer recoverable`);
	await actor.run(async (actorSignal) => {
		const timeout = setTimeout(() => actor.cancel(), CHECKPOINT_WRITER_TIMEOUT_MS);
		timeout.unref();
		try {
			const actorFork = actor.snapshot().forkContext;
			if (!actorFork) throw new Error("Checkpoint writer actor was created without a fork context");
			let validationIssues: CheckpointValidationIssue[] = [];
			for (let attempt = 0; attempt < CHECKPOINT_REPAIR_ATTEMPTS; attempt++) {
				// Repair attempts must be sequential: each pass validates the files produced by the previous pass.
				// biome-ignore lint/performance/noAwaitInLoops: checkpoint repair is intentionally sequential
				writerMessages = await runAgentLoop(writerMessages, {
					config: input.config,
					model: input.model,
					modelProvider: input.providerOverride,
					cwd: input.cwd,
					// A maintenance session must never self-compact: the checkpoint
					// writer's context is small and a compaction mid-repair derails it.
					skipCompaction: true,
					systemPrompt: forkMode
						? (actorFork.systemPrompt ?? CHECKPOINT_WRITER_SYSTEM_PROMPT)
						: CHECKPOINT_WRITER_SYSTEM_PROMPT,
					signal: actorSignal,
					onEvent: (event) => {
						// The checkpoint writer is a background session; capture its
						// usage so it lands in telemetry as kind=background.
						if (event.type === "usage") recordBackgroundUsage(input, event);
					},
					onWarning: () => {},
					...(forkMode && actorFork.toolDefinitions
						? {
								toolDefinitionsOverride: actorFork.toolDefinitions,
								...(input.parentToolRuntime ?? {}),
							}
						: {
								allowedTools: ["read", "write", "edit", "glob", "grep"],
								disabledTools: new Set(["bash", "task", "memory", "web_search", "web_fetch", "ssh", "skill"]),
								personas: [],
								subagentPrompts: [],
								mcpTools: [],
								skills: [],
								noSkills: true,
								projectTrusted: false,
							}),
					sessionId: writerSession.id,
					checkpointBoundary: actorFork.boundaryIndex,
					cachePrefixBoundary: actorFork.cachePrefixBoundary,
				});
				writerSession.messages = structuredClone(writerMessages);
				saveSession(writerSession);
				validationIssues = validateCheckpointArtifacts({
					checkpoint: readMemoryFile(artifactPaths.checkpoint),
					memory: readMemoryFile(artifactPaths.memory),
					notes: readMemoryFile(artifactPaths.notes),
					taskProgress: { [`tasks/${input.sessionId}`]: readSessionMemory(input.sessionId).taskProgress },
					priorDiscoveredTitles: new Set(extractDiscoveredTitles(previousArtifacts.checkpoint)),
					priorCheckpoint: previousArtifacts.checkpoint,
				});
				if (!hasBlockingCheckpointIssues(validationIssues)) {
					reconcileProjectMemoryFiles(input.cwd, input.sessionId);
					const watermarkTarget = checkpointCommitTarget(input, forkMode);
					if (!watermarkTarget || !commitCheckpointWatermark(input.sessionId, watermarkTarget)) {
						const invalidSuffix = `.invalid.watermark.${Date.now()}`;
						for (const [name, path] of Object.entries(artifactPaths)) {
							const current = readMemoryFile(path);
							if (current !== previousArtifacts[name as keyof typeof previousArtifacts]) {
								writeMemoryFile(`${path}${invalidSuffix}`, current);
							}
							writeMemoryFile(path, previousArtifacts[name as keyof typeof previousArtifacts]);
						}
						throw new Error("Checkpoint writer produced valid files but no persisted message could be committed");
					}
					return;
				}
				if (attempt + 1 < CHECKPOINT_REPAIR_ATTEMPTS) {
					writerMessages = [
						...writerMessages,
						{
							role: "user",
							content: buildCheckpointRepairPrompt(validationIssues, artifactPaths),
						},
					];
				}
			}
			const invalidSuffix = `.invalid.${Date.now()}`;
			for (const [name, path] of Object.entries(artifactPaths)) {
				const current = readMemoryFile(path);
				if (current !== previousArtifacts[name as keyof typeof previousArtifacts])
					writeMemoryFile(`${path}${invalidSuffix}`, current);
				writeMemoryFile(path, previousArtifacts[name as keyof typeof previousArtifacts]);
			}
			throw new Error(
				`Checkpoint writer output failed validation after ${CHECKPOINT_REPAIR_ATTEMPTS} attempts: ${validationIssues
					.map((issue) => `${issue.file}: ${issue.detail}`)
					.join("; ")}`,
			);
		} finally {
			clearTimeout(timeout);
		}
	});
}

async function recoverCheckpointWriter(snapshot: AgentActorSnapshot): Promise<void> {
	const recovery = snapshot.recovery;
	if (!recovery || recovery.kind !== "checkpoint-writer") return;
	const settings = loadSettings();
	const savedProvider = (settings.providers ?? []).find((provider) => provider.url === recovery.providerBaseURL);
	const credentials = savedProvider?.apiKey
		? { baseURL: savedProvider.url, apiKey: savedProvider.apiKey }
		: settings.providerUrl === recovery.providerBaseURL && settings.apiKey
			? { baseURL: settings.providerUrl, apiKey: settings.apiKey }
			: undefined;
	if (!credentials) throw new Error(`No credentials available for checkpoint provider ${recovery.providerBaseURL}`);
	const config = { ...recovery.config, apiKey: credentials.apiKey };
	const runtimeSnapshot = snapshot.forkContext?.runtime;
	const subagentProvider = runtimeSnapshot?.subagentModelProvider
		? ((): { baseURL: string; apiKey: string } | undefined => {
				const provider = (settings.providers ?? []).find(
					(candidate) => candidate.url === runtimeSnapshot.subagentModelProvider?.baseURL,
				);
				if (provider?.apiKey) return { baseURL: provider.url, apiKey: provider.apiKey };
				if (settings.providerUrl === runtimeSnapshot.subagentModelProvider?.baseURL && settings.apiKey) {
					return { baseURL: settings.providerUrl, apiKey: settings.apiKey };
				}
				return undefined;
			})()
		: undefined;
	const recoveredSshHosts = runtimeSnapshot?.sshHostNames
		? resolveSshHosts(recovery.cwd, runtimeSnapshot.projectTrusted === true).filter((host) =>
				runtimeSnapshot.sshHostNames?.includes(host.name),
			)
		: undefined;
	let mcpConnections: Awaited<ReturnType<typeof resolveMcpForCwd>>["connections"] = [];
	let parentToolRuntime: CheckpointWriterToolRuntime | undefined = runtimeSnapshot
		? {
				...runtimeSnapshot,
				// Interactive confirmation callbacks cannot survive a process restart.
				// Preserve bypass semantics, but fail closed for dangerous commands in
				// default mode instead of silently disabling the permission gate.
				confirmBash: runtimeSnapshot.permissionMode === "bypass" ? undefined : async () => false,
				disabledTools: runtimeSnapshot.disabledTools ? new Set(runtimeSnapshot.disabledTools) : undefined,
				subagentModelProvider: subagentProvider,
				sshHosts: recoveredSshHosts,
				backgroundBash: {
					registry: new BackgroundTaskRegistry(),
					followUpQueue: new MessageQueue(),
					isRunning: () => true,
				},
			}
		: undefined;
	if (runtimeSnapshot?.mcpServerNames?.length || runtimeSnapshot?.mcpToolNames?.length) {
		const mcp = await resolveMcpForCwd(
			{
				noSkills: true,
				noMcp: false,
				cliSkillPaths: [],
				cliMcpPaths: [],
				settings,
				pickers: {} as ProjectResolverDeps["pickers"],
			},
			recovery.cwd,
			runtimeSnapshot.projectTrusted === true,
			settings.disabledMcpServers ?? [],
		);
		const parentMcpServers = new Set(runtimeSnapshot.mcpServerNames ?? []);
		const parentMcpNames = new Set(runtimeSnapshot.mcpToolNames ?? []);
		const parentMcpTools = mcp.toolDefinitions.filter((tool) => {
			const server = mcpServerNameFromDescription(tool.function.description);
			return parentMcpNames.has(tool.function.name) || (server !== undefined && parentMcpServers.has(server));
		});
		const recoveredMcpNames = new Set(parentMcpTools.map((tool) => tool.function.name));
		mcpConnections = mcp.connections;
		parentToolRuntime = {
			...(parentToolRuntime ?? {}),
			mcpTools: parentMcpTools,
			mcpToolIndex: new Map([...mcp.toolIndex.entries()].filter(([name]) => recoveredMcpNames.has(name))),
		};
	}
	try {
		await runCheckpointWriter({
			cwd: recovery.cwd,
			sessionId: recovery.sessionId,
			writerSessionId: recovery.writerSessionId ?? snapshot.sessionId,
			writerActorId: snapshot.id,
			parentSystemPrompt: recovery.parentSystemPrompt,
			parentForkContext: snapshot.forkContext,
			parentToolRuntime,
			model: recovery.model,
			config,
			messages: snapshot.forkContext?.inheritedMessages ?? [],
			providerOverride: recovery.providerBaseURL === config.baseURL ? undefined : credentials,
			checkpointBoundary: recovery.checkpointBoundary,
			checkpointFork: recovery.checkpointFork,
		});
	} finally {
		if (mcpConnections.length > 0) await closeMcpConnections(mcpConnections);
	}
}

async function recoverMemoryMaintenance(snapshot: AgentActorSnapshot): Promise<void> {
	const recovery = snapshot.recovery;
	if (!recovery || recovery.kind !== "memory-maintenance") return;
	const settings = loadSettings();
	const savedProvider = (settings.providers ?? []).find((provider) => provider.url === recovery.providerBaseURL);
	const provider = savedProvider?.apiKey
		? { baseURL: savedProvider.url, apiKey: savedProvider.apiKey }
		: settings.providerUrl === recovery.providerBaseURL && settings.apiKey
			? { baseURL: settings.providerUrl, apiKey: settings.apiKey }
			: undefined;
	if (!provider) throw new Error(`No credentials available for memory ${recovery.maintenanceKind} recovery`);
	const config = { ...recovery.config, apiKey: provider.apiKey };
	await runAutomaticMemoryMaintenanceRun(
		{
			cwd: recovery.cwd,
			sessionId: recovery.sessionId,
			model: recovery.model,
			config,
			messages: recovery.messages,
			providerOverride: recovery.providerBaseURL === config.baseURL ? undefined : provider,
			runAgent: runMemoryMaintenanceAgent,
		},
		recovery.maintenanceKind,
		{
			parentSessionId: snapshot.parentSessionId,
			backgroundSessionId: recovery.sessionId,
			runId: snapshot.id,
		},
	);
}

agentActorRegistry.registerRecoveryHandler("checkpoint-writer", recoverCheckpointWriter);
agentActorRegistry.registerRecoveryHandler("memory-maintenance", recoverMemoryMaintenance);

// In-process record of which checkpoint thresholds each session already fired.
// A process restart simply re-fires the first uncrossed threshold, which is
// idempotent for the writer.
const crossedCheckpointThresholds = new Map<string, Set<number>>();

// Token safety buffer reserved at the end of the window: no checkpoint
// threshold is allowed to fire past window - reserved, because past that point
// there is no room left in the window for the writer's own turn.
const CHECKPOINT_RESERVED = 13_000;

/**
 * Checkpoint trigger ladder: a writer fires each time the used context crosses
 * the next percentage of the model window, so a fresh checkpoint.md almost
 * always exists when compaction needs to rebuild from it.
 */
export function defaultCheckpointThresholds(contextWindow: number): number[] {
	if (contextWindow < 25_000) return [];
	if (contextWindow <= 200_000) return [20, 40, 60, 80];
	if (contextWindow <= 500_000) return [10, 20, 30, 40, 50, 60, 70, 80, 90];
	return Array.from({ length: 18 }, (_, index) => (index + 1) * 5);
}

/** Resolve the configured/derived percentages into clamped token counts. */
function resolveCheckpointThresholdTokens(contextWindow: number, override?: number[]): number[] {
	const percentages = override ?? checkpointThresholdsSetting() ?? defaultCheckpointThresholds(contextWindow);
	if (percentages.length === 0) return [];
	const reserved = checkpointReservedSetting() ?? CHECKPOINT_RESERVED;
	// The reserve only makes sense once the window can actually accommodate it;
	// tiny (test) windows run without a buffer.
	const maxAllowed = Math.max(1, contextWindow - (contextWindow > CHECKPOINT_RESERVED ? reserved : 0));
	const tokens = percentages.map((percentage) =>
		Math.floor((contextWindow * Math.min(100, Math.max(0, percentage))) / 100),
	);
	return [...new Set(tokens.map((count) => Math.min(count, maxAllowed)))].sort((a, b) => a - b);
}

/** True when the observed tokens crossed a not-yet-fired threshold for the session. */
function crossedCheckpointThreshold(
	sessionId: string,
	contextWindow: number,
	observedTokens: number,
	override?: number[],
): boolean {
	const thresholds = resolveCheckpointThresholdTokens(contextWindow, override);
	if (thresholds.length === 0) return false;
	let crossed = crossedCheckpointThresholds.get(sessionId);
	if (!crossed) {
		crossed = new Set<number>();
		crossedCheckpointThresholds.set(sessionId, crossed);
	}
	const newly = thresholds.filter((threshold) => observedTokens >= threshold && !crossed.has(threshold));
	for (const threshold of newly) crossed.add(threshold);
	return newly.length > 0;
}

function findCheckpointBoundary(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			message?.role === "user" &&
			typeof message.content === "string" &&
			message.content.includes("<checkpoint-boundary>")
		) {
			return i;
		}
	}
	return -1;
}

/** Index of the newest non-system message — the durable commit point for a full-prefix fork. */
function lastNonSystemIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role !== "system") return i;
	}
	return -1;
}

function checkpointCommitTarget(input: MemoryCheckpointWriterInput, forkMode: boolean): Message | undefined {
	if (forkMode && (input.checkpointBoundary ?? -1) >= 0) {
		return input.messages[input.checkpointBoundary!];
	}
	for (let i = input.messages.length - 1; i >= 0; i--) {
		if (input.messages[i]?.role !== "system") return input.messages[i];
	}
	return undefined;
}

function persistCheckpointSource(sessionId: string, messages: Message[]): void {
	const session = loadSession(sessionId);
	if (!session) return;
	// The writer runs after the loop returns and may outlive the UI's final
	// onMessagesChanged callback. Persist this exact source snapshot before
	// handing it to the background actor, so a successful file write always
	// has a message row to watermark atomically.
	session.messages = messages.slice();
	saveSession(session);
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
	if (loopConfig.automaticMemoryMaintenance && loopConfig.memory && loopConfig.sessionId) {
		scheduleAutomaticMemoryMaintenance({
			cwd: loopConfig.cwd,
			sessionId: loopConfig.memory.sessionId,
			model: loopConfig.model,
			config: loopConfig.config,
			messages: loopConfig.automaticMemoryMessages ?? initialMessages,
			providerOverride: loopConfig.modelProvider,
			signal: loopConfig.signal,
			onWarning: loopConfig.onWarning,
			runAgent: runMemoryMaintenanceAgent,
		});
	}
	await runLoop(tracked, loopConfig);
	if (loopConfig.memory && isMemoryWriteEnabled() && !loopConfig.signal?.aborted) {
		const observedTokens = loopConfig.lastPromptTokens ?? estimateTokens(tracked);
		if (
			crossedCheckpointThreshold(
				loopConfig.memory.sessionId,
				loopConfig.config.contextWindow,
				observedTokens,
				loopConfig.checkpointThresholds,
			)
		) {
			persistCheckpointSource(loopConfig.memory.sessionId, tracked);
			const checkpointFork = loopConfig.checkpointFork ?? checkpointForkSetting();
			const checkpointBoundary = loopConfig.checkpointBoundary ?? findCheckpointBoundary(tracked);
			const durableDelta =
				!checkpointFork &&
				checkpointBoundary < 0 &&
				getCheckpointWatermark(loopConfig.memory!.sessionId) !== undefined
					? getMessagesAfterCheckpoint(loopConfig.memory!.sessionId)
					: [];
			const writerMessages = durableDelta.length > 0 ? durableDelta : tracked;
			// Fork mode anchors the writer at the CURRENT transcript end, not the last
			// durable boundary: the forked prefix then covers the latest turn (the whole
			// point of the cache-preserving fork) and the watermark commit advances past
			// it. The durable watermark only feeds the delta-only no-fork path.
			const writerBoundary = checkpointFork
				? lastNonSystemIndex(tracked)
				: durableDelta.length > 0
					? -1
					: checkpointBoundary;
			if (!checkpointFork || writerBoundary >= 0) {
				const writerHandle = scheduleProjectCheckpointWriter(
					{
						cwd: loopConfig.cwd,
						sessionId: loopConfig.memory!.sessionId,
						model: loopConfig.model,
						config: loopConfig.config,
						messages: writerMessages,
						providerOverride: loopConfig.modelProvider,
						checkpointBoundary: writerBoundary,
						checkpointFork,
						parentSystemPrompt: loopConfig.checkpointForkContext?.systemPrompt,
						parentForkContext: loopConfig.checkpointForkContext,
						parentToolRuntime: checkpointWriterRuntime(loopConfig),
					},
					runCheckpointWriter,
					loopConfig.onWarning,
				);
				loopConfig.onCheckpointWriter?.(writerHandle);
			}
		}
	}
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
	// Nested in-process runs (the task tool's subagent) must not trip the
	// cross-process turn-runner lock — the parent already holds it for this
	// session, and the subagent runs synchronously while the parent awaits it,
	// so there is no cross-process race to guard against.
	const lockAcquired =
		!runnerSessionId || loopConfig.skipTurnRunnerLock || acquireTurnRunner(runnerSessionId, process.pid);
	if (!lockAcquired) throw new Error(`Session "${runnerSessionId}" is already running in another process`);
	if (runnerSessionId) markTurnRunner(runnerSessionId, process.pid);
	try {
		await runLoopInner(messages, loopConfig);
	} finally {
		// clearTurnRunner checks the pid inside the file matches our own before
		// unlinking, so a second TUI racing on the same session won't have its
		// marker clobbered by us.
		if (runnerSessionId) clearTurnRunner(runnerSessionId, process.pid);
		if (runnerSessionId) releaseTurnRunner(runnerSessionId, process.pid);
	}
}

async function runLoopInner(messages: Message[], loopConfig: LoopConfig): Promise<void> {
	const { config, model: initialModel, cwd, systemPrompt, onEvent, onWarning, signal, mcpToolIndex } = loopConfig;
	const promptCacheStrategy = resolvePromptCacheStrategy(
		loopConfig.modelProvider?.baseURL ?? config.baseURL,
		loopConfig.sessionId,
	);
	const promptCacheBody = promptCacheRequestBody(promptCacheStrategy);
	const memoryBudgetTokens = memoryPromptBudgetTokens(config);
	let checkpointBoundary = loopConfig.checkpointBoundary ?? findCheckpointBoundary(messages);
	if (checkpointBoundary < 0 && loopConfig.sessionId) {
		checkpointBoundary = findCheckpointBoundaryForMessages(loopConfig.sessionId, messages);
	}
	loopConfig.checkpointBoundary = checkpointBoundary;
	const memoryEnabled = loopConfig.memory !== undefined && isMemoryEnabled();
	const memoryService = memoryEnabled ? (loopConfig.memory?.service ?? DEFAULT_MEMORY_SERVICE) : undefined;
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
		memoryEnabled,
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
	const baseTools = loopConfig.toolDefinitionsOverride
		? structuredClone(loopConfig.toolDefinitionsOverride)
		: [...builtins, ...mcps];
	// Tools an invoked skill removed for the rest of this turn via its
	// `disallowed-tools` frontmatter. Per the spec the restriction "clears when
	// you send your next message", so a steer or follow-up empties it.
	const skillDisallowedTools = new Set<string>();
	let tools = baseTools;
	const applySkillToolRestrictions = (): void => {
		tools = skillDisallowedTools.size
			? baseTools.filter((t) => !skillDisallowedTools.has(t.function.name))
			: baseTools;
		advertisedNames = new Set(tools.map((t) => t.function.name));
	};
	// Names registered before allowlist/denylist filters — so a call to a
	// real-but-filtered builtin gets "not available", not an unknown-tool hint.
	const knownToolNames = new Set(allTools.map((t) => t.function.name));
	// Names the model is actually allowed to call this turn — used to catch
	// fabricated tool names in executeTool below.
	let advertisedNames = new Set(tools.map((t) => t.function.name));

	// Doom-loop detector: tracks the last DOOM_LOOP_THRESHOLD tool calls
	// (name + serialized args). When the same call appears that many times in
	// a row we refuse to execute it and tell the model to try something else.
	const recentToolCalls: Array<{ name: string; argsKey: string }> = [];

	// Hooks in force for this run. Seeded from the caller's set and extended
	// when a skill with a `hooks:` block is invoked — a skill whose whole point
	// is "run the formatter after every edit" is inert without them. Kept local
	// rather than mutating loopConfig, which the caller owns and reuses.
	let activeHooks: HooksFile | undefined = loopConfig.hooks;
	/** Groups registered by a skill with `once: true`, dropped after they fire. */
	const onceHookEvents = new Set<HookEvent>();
	const registerSkillHooks = (raw: unknown): void => {
		const incoming = coerceHooksObject(raw, "project");
		if (Object.keys(incoming).length === 0) return;
		for (const [event, groups] of Object.entries(incoming) as [HookEvent, HookMatcherGroup[]][]) {
			if (groups.some((group) => group.hooks.some((hook) => (hook as { once?: boolean }).once))) {
				onceHookEvents.add(event);
			}
		}
		activeHooks = mergeHooks(activeHooks ?? {}, incoming);
	};
	/** Runs an event against the active set and retires any `once` group that
	 * fired successfully. Every in-run hook dispatch goes through this. */
	const runHook = async (opts: Parameters<typeof runHooksForEvent>[1]): Promise<HookRunResult> => {
		const result = await runHooksForEvent(activeHooks ?? {}, opts);
		retireOnceHooks(opts.event, result.blocked);
		return result;
	};

	/** After an event fires, drop the skill groups that asked to run once. */
	const retireOnceHooks = (event: HookEvent, blocked: boolean): void => {
		if (!onceHookEvents.has(event) || blocked || !activeHooks?.[event]) return;
		const kept = activeHooks[event]!.filter(
			(group) => !group.hooks.some((hook) => (hook as { once?: boolean }).once),
		);
		activeHooks = { ...activeHooks, [event]: kept };
		onceHookEvents.delete(event);
	};

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
	// Read `activeHooks` at call time, not at construction: a skill invoked
	// mid-run can add PermissionRequest/PermissionDenied hooks, and a run that
	// started with none would otherwise never see them.
	const confirmBashWithHooks: ConfirmBash | undefined = loopConfig.confirmBash
		? async (command, reason) => {
				const hooksForConfirm = activeHooks;
				if (!hooksForConfirm) return loopConfig.confirmBash!(command, reason);
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
					hooks: activeHooks,
					sessionId: loopConfig.sessionId,
					forkContext: () =>
						createAgentForkContext(messages, checkpointBoundary, {
							systemPrompt: loopConfig.systemPrompt,
							toolNames: tools.map((tool) => tool.function.name),
							toolDefinitions: structuredClone(tools),
							allowedTools,
							disabledTools: [...disabledTools],
							readOnlyBash: loopConfig.readOnlyBash,
							permissionMode: loopConfig.permissionMode,
							model: initialModel,
						}),
					skills: allowedSkills,
					runAgentLoop,
				}
			: undefined,
		loopConfig.planState,
		loopConfig.sshHosts,
		loopConfig.backgroundBash,
		allowedSkills
			? {
					skills: allowedSkills,
					sessionId: loopConfig.sessionId,
					cwd,
					// Plan mode (and a plan-mode parent's subagent) restricts a skill's
					// inline commands exactly as it restricts the bash tool.
					inlineGate: { readOnly: loopConfig.planState?.enabled === true || loopConfig.readOnlyBash === true },
				}
			: undefined,
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
		if (loopConfig.executionAllowedTools && !loopConfig.executionAllowedTools.has(name)) {
			return { content: `Tool "${name}" is not available in this fork's execution policy.`, isError: true };
		}
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
				// Rewriting the list to flip one status, models routinely retype the
				// item and shorten any absolute path in it ("…/note.txt" becomes
				// "note.txt"). Exact content matching then loses the plan link, and
				// with it the open-work gate's only handle on that step, so a second
				// pass compares with directories stripped off path-like tokens.
				const planStepsByShortenedContent = new Map(
					previousTodos.flatMap((todo) =>
						todo.planStep ? [[shortenPathsForTodoMatch(todo.content), todo.planStep] as const] : [],
					),
				);
				todos = result.todos.map((todo) => {
					const planStep =
						planStepsByContent.get(todo.content) ??
						planStepsByShortenedContent.get(shortenPathsForTodoMatch(todo.content));
					return planStep ? { ...todo, planStep } : todo;
				});
				onEvent({ type: "todos_updated", todos });
				// Observation-only, fire-and-forget — content is the only stable
				// identity todos have (no id field), so this is a best-effort diff,
				// not a guaranteed one (renaming a todo reads as create+drop).
				if (activeHooks) {
					const previousByContent = new Map(previousTodos.map((t) => [t.content, t]));
					for (const t of todos) {
						const prev = previousByContent.get(t.content);
						if (!prev) {
							void runHook({
								event: "TaskCreated",
								cwd,
								sessionId: loopConfig.sessionId,
								payload: { content: t.content, priority: t.priority },
								signal,
							});
						} else if (prev.status !== "completed" && t.status === "completed") {
							void runHook({
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
		const hooks = activeHooks;
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
	// write it into messages[0]. Memory is deliberately not reconstructed here:
	// ordinary turns get only a small recall hint, while the full durable context
	// is inserted at a checkpoint boundary after compaction.
	const syncSystemPrompt = (): void => {
		let prompt = systemPrompt;
		let userText = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]!;
			if (m.role !== "user") continue;
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
		if (loopConfig.rebuildSystemPrompt) {
			prompt = loopConfig.rebuildSystemPrompt({ userText, contextFiles });
		}
		if (memoryService && isMemoryWriteEnabled() && loopConfig.memory?.sessionId) {
			prompt = `${prompt}\n\n${memorySystemPrompt(cwd, loopConfig.memory.sessionId)}`;
		}
		if (
			memoryService &&
			isMemoryWriteEnabled() &&
			loopConfig.memory?.sessionId &&
			hasMemoryOrTasks(cwd, loopConfig.memory.sessionId)
		) {
			prompt = `${prompt}\n\n${MEMORY_RECALL_HINT}`;
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

	const appendMemoryRebuildBoundary = (): void => {
		if (!memoryService || !isMemoryWriteEnabled() || !loopConfig.memory?.sessionId) return;
		const context = memoryService.buildPrompt(cwd, "", loopConfig.memory.sessionId, {
			tokenBudget: memoryBudgetTokens,
			rebuildContext: true,
			recentMessages: messages,
		});
		if (!context) return;
		const boundaryIndex = messages.length;
		messages.push({
			role: "user",
			content: `<checkpoint-boundary>\n${context}\n</checkpoint-boundary>`,
		});
		checkpointBoundary = boundaryIndex;
		loopConfig.checkpointBoundary = checkpointBoundary;
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
		let nearCapReminderSent = false;
		let overflowCompacted = false;
		// Tracks whether we've already yanked the largest tool result out of
		// history on this turn as an in-place context-overflow fallback. Distinct
		// from `overflowCompacted` so we still try LLM-based compaction if the
		// in-place shrink wasn't enough.
		let toolResultTrimmed = false;
		// Goal-mode iteration budget (maxOuterIterations), enforced in the loop.
		let outerIteration = 0;
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

			// Compaction (suppressed for short-lived system agents)
			if (!loopConfig.skipCompaction && shouldCompact(messages, config, loopConfig.lastPromptTokens)) {
				// biome-ignore lint/performance/noAwaitInLoops: sequential agent turn loop
				const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
				if (result.compacted) appendMemoryRebuildBoundary();
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
				// Iteration bound: count each model call (one per inner-loop pass,
				// which may carry several tool calls). The explicit /goal budget
				// caps an autonomous run; a default safety cap applies to every
				// other turn so a model spinning on different-but-unproductive
				// tool calls can't loop forever. Either way the model is nudged
				// to wrap up near the cap and warned if it burns through — the
				// work done so far is already persisted per tool batch.
				const goalCap = loopConfig.maxOuterIterations;
				const activeCap = goalCap ?? loopConfig.defaultOuterIterations ?? DEFAULT_OUTER_ITERATION_CAP;
				outerIteration += 1;
				if (outerIteration > activeCap) {
					loopConfig.onWarning?.(
						goalCap !== undefined
							? `Autonomous goal hit its iteration budget (${goalCap}) — stopping.`
							: `Turn hit the iteration safety cap (${activeCap}) — stopping. This may be a runaway loop; check the recent tool calls.`,
					);
					hasMoreToolCalls = false;
					// A steer already drained out of the queue must not vanish
					// with the turn: it was typed by the user, and dropping it
					// here persisted nothing and emitted no event, so it was
					// gone without trace. Keep it in the transcript — the model
					// answers it on the next turn rather than this one — and say
					// why it wasn't acted on now.
					if (pendingMessages.length > 0) {
						for (const message of pendingMessages) messages.push(message);
						onEvent({ type: "steering_injected", messages: [...pendingMessages] });
						loopConfig.onWarning?.(
							pendingMessages.length === 1
								? "Your message arrived as this turn ran out of its iteration budget — it's kept in the conversation and will be answered on the next turn."
								: `${pendingMessages.length} of your messages arrived as this turn ran out of its iteration budget — they're kept in the conversation and will be answered on the next turn.`,
						);
						pendingMessages = [];
					}
					break;
				}
				// Once, on entering the last stretch — not on every remaining
				// iteration. Repeating it pushed a near-identical system message
				// per pass, spending context on the reminder itself at exactly
				// the point the turn is short of room.
				if (!nearCapReminderSent && activeCap >= 4 && outerIteration >= activeCap - 3) {
					nearCapReminderSent = true;
					messages.push({
						role: "system",
						content: `<system-reminder>You are near the end of this turn's iteration budget (~${activeCap - outerIteration} iterations left). Finish the current work and summarize; do not start new sub-tasks.</system-reminder>`,
					});
				}
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
					// …and the open-work gate's budget, which is documented as "per
					// user prompt". The follow-up path already reset it; steering did
					// not, so a steer sent after the gate had fired twice left the
					// model free to stop with approved-plan work still open, exactly
					// when the user had just asked for more.
					openWorkGateFires = 0;
					// A skill's tool restriction lasts until the next user message.
					if (skillDisallowedTools.size) {
						skillDisallowedTools.clear();
						applySkillToolRestrictions();
					}
				}

				// Re-sync the system prompt against contextFiles that tool calls
				// from the previous inner iteration may have added — this is what
				// makes a glob rule attach immediately after its file is read.
				syncSystemPrompt();

				// Stream assistant response. Explicit providers get request-only
				// markers; automatic-prefix providers keep the native message shape.
				// The live messages/tools arrays stay clean so saveSession never
				// persists provider-specific structured content.
				const cached = applyCacheControl(messages, tools, loopConfig.cachePrefixBoundary, promptCacheStrategy.mode);

				// Vision fallback: if the model doesn't support images (404 from
				// OpenRouter or similar), strip any image_url messages we added
				// after tool results and retry. The tool result text already
				// contains "[Image: ...]" so the agent still knows an image was
				// there — it just can't see it.
				// Accumulate partial content so aborted/disconnected turns can be
				// persisted into session history (the catch block can't read
				// streamAndCollect's locals after it throws). Reset per completion
				// attempt: a multi-message run (steering/follow-up turns processed
				// by the same runAgentLoop call) otherwise leaves earlier turns'
				// already-committed content in the accumulator, and an abort mid-
				// later-stream would persist the whole concatenation as the
				// "partial assistant", duplicating earlier turns in history.
				partialContent = "";
				partialThinking = "";
				let completion: Awaited<ReturnType<typeof streamAndCollect>> | null = null;
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
						promptCacheBody,
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
					// True when a recovery branch below produced a usable completion
					// (or queued a retry) — the trailing `throw err` must not re-raise
					// the original failure past a successful vision fallback.
					let recovered = false;
					if (isVisionError && hasImages) {
						// Drop the rejected image_url parts, keeping any text (the
						// user's actual question) so the retry is still meaningful.
						// Persist the removal (mark them out of context) so later
						// turns don't re-send the rejected image parts and pay the
						// 400+retry again.
						for (let i = messages.length - 1; i >= 0; i--) {
							const m = messages[i]!;
							if (
								m.role === "user" &&
								Array.isArray(m.content) &&
								m.content.some((p: { type?: string }) => p.type === "image_url")
							) {
								const textParts = m.content.filter((p: { type?: string }) => p.type !== "image_url");
								if (textParts.length > 0) {
									messages[i] = {
										...m,
										content: textParts,
									} as Message;
								} else {
									messages.splice(i, 1);
								}
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
							promptCacheBody,
						);
						recovered = true;
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
					if (isContextOverflow(err) && !overflowCompacted && !loopConfig.skipCompaction) {
						// Context overflow — compact and retry the turn instead of
						// surfacing a raw error. Only once per turn to prevent infinite
						// loops when even compacted context is too large.
						const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
						if (result.compacted) appendMemoryRebuildBoundary();
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
					if (!recovered) throw err;
					// Unreachable in practice — the only path that sets `recovered`
					// also assigns `completion` — but the null guard is what lets
					// TypeScript know the value is set here at all.
					if (!completion) throw err;
				}

				// A mid-stream abort doesn't always reject: undici can end the async
				// iterator cleanly, so streamAndCollect returns a partial result and no
				// exception reaches the outer catch. Without this the partial turn
				// commits as a normal stop and never shows "Aborted" — the symptom of
				// pressing Esc while reasoning streams. `interrupted` (not raw
				// signal.aborted) so a turn that *finished* right before a late Esc is
				// committed normally instead of being mislabeled aborted.
				if (completion.interrupted) {
					// A provider can stream a terminal usage chunk before the abort
					// actually tears down the connection (llm.ts assigns `usage` from
					// any chunk that carries it, not only a finish-reason'd one) — if
					// it did, that's real, provider-billed cost that must still be
					// recorded, the same as the finishReason==="aborted" path below.
					if (completion.usage) {
						loopConfig.lastPromptTokens = completion.usage.promptTokens;
						onEvent({
							type: "usage",
							usage: completion.usage,
							generationMs: completion.generationMs,
							ttftMs: completion.ttftMs,
						});
					}
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

				// The model produced no usable turn: no text, no tool calls. On
				// "length" the budget ran out mid-answer; on "stop" a reasoning
				// model often burned the whole output budget on hidden
				// reasoning_content and stopped before writing the actual answer.
				// Either way it's not a real answer yet — retry once with 2x the
				// budget instead of committing "(no response)". Terminal failure
				// reasons (error/aborted) and moderation blocks are handled below
				// and must not be retried here.
				const terminalFinish =
					completion.finishReason === "error" ||
					completion.finishReason === "aborted" ||
					completion.finishReason === "content_filter";
				const emptyTurn =
					!completion.toolCalls?.length &&
					!completion.refusal &&
					!terminalFinish &&
					(completion.finishReason === "length" || !completion.content);
				if (emptyTurn && !reasoningRetryDone) {
					reasoningRetryDone = true;
					effectiveMaxTokens *= 2;
					// Mirrors MiMo Code's think-only recovery: tell the MODEL why it's
					// being asked to continue (just doubling the budget alone lets a
					// reasoning model repeat the same reasoning-only output), then
					// re-loop with the nudge + room to actually answer.
					messages.push({
						role: "user",
						content:
							"<system-reminder>\n" +
							"The model's previous response contained no usable answer (it had only reasoning, or was empty). " +
							"Provide a final answer now or call a tool to make progress on the task. " +
							"Do not respond with only reasoning/thinking.\n" +
							"</system-reminder>",
					});
					onWarning?.(
						completion.finishReason === "length"
							? "Response truncated before a tool call — retrying with doubled budget"
							: "The model returned an empty response — retrying with doubled budget",
					);
					continue;
				}

				if (completion.usage) {
					loopConfig.lastPromptTokens = completion.usage.promptTokens;
					onEvent({
						type: "usage",
						usage: completion.usage,
						generationMs: completion.generationMs,
						ttftMs: completion.ttftMs,
					});
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

				// Moderation / content-policy block. OpenAI reports it as
				// finish_reason "content_filter" or a streamed `refusal` field —
				// neither lands in `content`, so without this branch the refusal
				// would commit as an empty/placeholder answer and the user would
				// have no idea the request was blocked. Commit a visible
				// explanation instead.
				if (completion.finishReason === "content_filter" || completion.refusal) {
					const refusalText = (completion.refusal ?? "").trim();
					const refusalMsg = refusalText
						? `The model refused the request: ${refusalText}`
						: "The model refused the request (content filter).";
					messages.push({ role: "assistant", content: refusalMsg });
					onEvent({ type: "turn_end", toolResults: [] });
					onWarning?.(refusalMsg);
					onEvent({ type: "end", reason: "stop" });
					return;
				}

				// Build assistant message. An assistant turn must carry either
				// content or tool_calls — a turn that produced only reasoning
				// (all output in reasoning_content) would otherwise persist as
				// `content: null` with no tool_calls, a shape providers reject
				// (400) on every following turn once it's in the session.
				const hasToolCalls = Boolean(completion.toolCalls && completion.toolCalls.length > 0);
				// Reaching here with nothing to show means the empty-turn retry
				// above already fired and the model still produced nothing — make
				// sure "(no response)" is never committed without explanation.
				if (!completion.content && !hasToolCalls && !completion.refusal) {
					onWarning?.("The model returned an empty response again — showing the empty turn.");
				}
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
					if (activeHooks && executedToolBatch.length > 1) {
						void runHook({
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

						// A skill with `disallowed-tools` narrows the pool for the rest
						// of the turn — the author's way of saying "this procedure must
						// not touch these", which was previously parsed and ignored.
						if (r.result.skillHooks) registerSkillHooks(r.result.skillHooks);
						if (r.result.skillDisallowedTools?.length) {
							for (const name of r.result.skillDisallowedTools) skillDisallowedTools.add(name);
							applySkillToolRestrictions();
						}

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
				if (
					toolCalls &&
					toolCalls.length > 0 &&
					!loopConfig.skipCompaction &&
					shouldCompact(messages, config, estimateTokens(messages))
				) {
					const result = await performCompaction(messages, config, currentModel, signal, loopConfig, onEvent);
					if (result.compacted) appendMemoryRebuildBoundary();
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
				if (skillDisallowedTools.size) {
					skillDisallowedTools.clear();
					applySkillToolRestrictions();
				}
				continue;
			}

			// No more messages — done, unless a Stop hook says otherwise.
			if (activeHooks && stopHookBlocks < MAX_STOP_HOOK_BLOCKS) {
				const stopResult = await runHook({
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
		if (activeHooks) {
			void runHook({
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
	loopConfig.checkpointForkContext = createAgentForkContext(messages, checkpointBoundary, {
		systemPrompt:
			typeof messages.find((message) => message.role === "system")?.content === "string"
				? (messages.find((message) => message.role === "system")?.content as string)
				: systemPrompt,
		toolNames: tools.map((tool) => tool.function.name),
		toolDefinitions: structuredClone(tools),
		allowedTools,
		disabledTools: [...disabledTools],
		readOnlyBash: loopConfig.readOnlyBash,
		permissionMode: loopConfig.permissionMode,
		model: currentModel,
		runtime: checkpointWriterRuntime(loopConfig).snapshot,
	});
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
		// No arguments at all is a legitimate call, not a malformed one. Several
		// OpenAI-compatible providers send `arguments: ""` (or omit the field, which
		// accumulates to "") for a tool invoked without parameters, and JSON.parse
		// rejected that — so a plain `ls` or `plan_done` with no arguments came back
		// as "arguments were truncated or malformed. Retry the tool call", which the
		// model could only answer by retrying the same call forever.
		if (tc.arguments.trim() === "") {
			prepared.push({ id: tc.id, name: tc.name, args: {} });
			continue;
		}
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

	const runOne = async (tc: (typeof prepared)[number]): Promise<ToolCallResult> => {
		if (signal?.aborted) return abortedToolResult(tc);

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

	const results: ToolCallResult[] = [];
	let cursor = 0;
	while (cursor < prepared.length) {
		if (signal?.aborted) {
			results.push(...prepared.slice(cursor).map(abortedToolResult));
			break;
		}
		const group: typeof prepared = [prepared[cursor]!];
		if (PARALLEL_SAFE_TOOL_NAMES.has(prepared[cursor]!.name)) {
			while (
				cursor + group.length < prepared.length &&
				PARALLEL_SAFE_TOOL_NAMES.has(prepared[cursor + group.length]!.name)
			) {
				group.push(prepared[cursor + group.length]!);
			}
		}
		const groupSettled = new Map<string, ToolCallResult>();
		const toolPromises = group.map(async (tc): Promise<ToolCallResult> => {
			const result = await runOne(tc);
			const normalized = { ...result, result: normalizeToolResultError(result.result) };
			groupSettled.set(tc.id, normalized);
			return normalized;
		});
		// Abort must always end the turn: cooperating tools settle quickly, while
		// an uncooperative tool gets the same bounded grace period per group.
		// biome-ignore lint/performance/noAwaitInLoops: mutation groups must remain ordered
		results.push(...(await waitForToolBatch(toolPromises, group, groupSettled, signal)));
		cursor += group.length;
	}

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
		relPath = relativeToCwd(rawPath, cwd);
	} else {
		relPath = rawPath;
	}

	if (!contextFiles.includes(relPath)) {
		contextFiles.push(relPath);
	}
}
