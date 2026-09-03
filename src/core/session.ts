import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { TurnCheckpoint } from "./checkpoint.ts";
import type { AppConfig } from "./config.ts";
import { formatLocalDate } from "./date-rollover-reminder.ts";
import { getDb } from "./db.ts";
import type { Message, Usage } from "./llm.ts";
import type { PlanQuestion, PlanTransition } from "./plan.ts";
import { deriveSessionTitle } from "./session-title.ts";
import type { TodoItem } from "./todo.ts";

const READ_FILES_RE = /<read-files>\n([\s\S]*?)\n<\/read-files>/;
const MODIFIED_FILES_RE = /<modified-files>\n([\s\S]*?)\n<\/modified-files>/;
const JSON_EXT_RE = /\.json$/;
const NEWLINE_RE_G = /\n/g;
const DOUBLE_QUOTE_RE = /"/g;
const WHITESPACE_RE = /\s+/;
const SQL_LIKE_SPECIAL_RE = /[\\%_]/g;
const DATAURL_RE = /^data:([^;]+);base64,(.*)$/s;

// ============================================================================
// Session state
// ============================================================================

export interface SessionUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cost: number;
	/** Cumulative tokens served from provider's prompt cache (hits). */
	cacheReadTokens: number;
	/** Cumulative tokens written to provider's prompt cache (new entries). */
	cacheWriteTokens: number;
	/** Cumulative input tokens that were neither cached read nor cached write (full price). */
	uncachedTokens: number;
	/** Cumulative total tokens attributed to subagents — a subset of totalTokens,
	 * tracked separately so the status line can show how much delegation cost. */
	subagentTokens: number;
}

/** One turn's "how it ran" summary — provider/model/timing. See
 *  `SessionState.turnMeta` for how it's keyed and persisted. */
export interface TurnMeta {
	provider?: string;
	model?: string;
	totalMs?: number;
	generationMs?: number;
	tokensPerSecond?: number;
	completedAt: string;
}

export interface SessionState {
	id: string;
	messages: Message[];
	model: string;
	createdAt: string;
	updatedAt: string;
	/** Monotonic version for optimistic concurrency — increments on every save. */
	version?: number;
	checkpoints?: TurnCheckpoint[];
	/** Cumulative token/cost usage across every turn in this session. */
	usage: SessionUsage;
	/** promptTokens from the most recent API response — the authoritative
	 * measure of current context size. undefined before the first call or
	 * when a session is loaded from disk with no prior API data. */
	lastPromptTokens?: number;
	/** Highest persisted message sequence fully covered by a successful checkpoint. */
	checkpointWatermarkSeq?: number;
	/**
	 * Absolute path cast was launched from when this session was created —
	 * lets --resume/--continue/`/sessions` switch back into the right project
	 * instead of leaving you wherever you happened to launch from this time.
	 * Optional: sessions saved before per-project grouping existed don't have
	 * one and just stay in the flat legacy directory (see getSessionFileDir).
	 */
	cwd?: string;
	/** Agent mode this session was left in — restored on resume so quitting
	 * mid-planning comes back to plan mode. Unset means "build", the default.
	 * Per-session on purpose: the mode is task state, and storing it globally
	 * leaked plan mode from one project into every other one. */
	mode?: "plan" | "build";
	/** Persona name this thread was last driven by — restored on resume, same
	 * rationale as `mode`: the persona shaped the conversation's reasoning and
	 * tone, so reopening the thread under whatever persona happens to be the
	 * current global one silently swaps the system prompt out from under the
	 * history. Unset on sessions saved before this field existed (resume keeps
	 * the current persona for those). The global settings.persona remains the
	 * default for NEW sessions only. */
	persona?: string;
	/**
	 * Local calendar date (`YYYY-MM-DD`) last announced to the model via the
	 * date-rollover `<system-reminder>`. Used so overnight sessions get a
	 * one-shot notice when the day advances. Optional for older session files.
	 */
	lastAnnouncedLocalDate?: string;
	/**
	 * Provider base URL this session's `model` belongs to. Resume only reuses
	 * the stored model when the current provider matches — a session pinned to
	 * "some-model" from provider A resumed against provider B otherwise sends
	 * every request to a model that doesn't exist there, and providers answer
	 * that with opaque 400s rather than a clean "unknown model". Optional for
	 * sessions saved before this field existed (treated as "unknown provider").
	 */
	providerUrl?: string;
	/**
	 * Name of the saved provider entry (settings.providers) this session is
	 * actually pinned to — providerUrl alone can't disambiguate two saved
	 * providers that legitimately share a base URL with different API keys;
	 * matching by URL only would silently pick whichever one happens to come
	 * first in the list. Optional for sessions saved before this field
	 * existed, or when the session tracks the globally active provider
	 * rather than a specific pin (URL-only matching is the accepted fallback
	 * there, same as before this field existed).
	 */
	providerName?: string;
	/** Conversation sessions are user-facing; background sessions are maintenance runs. */
	sessionKind?: "conversation" | "background";
	/** Parent conversation for a background session. */
	parentSessionId?: string;
	/** Maintenance kind for a background session. */
	backgroundKind?: "memory-dream" | "memory-distill" | "checkpoint-writer";
	/**
	 * Reasoning ("thinking") text for assistant messages, keyed by that
	 * message's index in `messages`. The OpenAI wire format (`Message` in
	 * core/llm.ts) has no field for it and it's never sent back to the model,
	 * so it can't live on the message itself — it's only ever handed to
	 * callers as an ephemeral `assistant_message` event (see core/loop.ts).
	 * Only the web UI currently writes/reads this, so a page reload or
	 * session switch can still show a turn's reasoning instead of silently
	 * dropping it; the TUI continues to show reasoning live-only, matching
	 * its prior behavior on resume.
	 */
	reasoning?: Record<number, string>;
	/**
	 * Per-turn "provider · model · Ns" summary, keyed by the index of the
	 * assistant message that concluded that turn — same sidecar-map shape and
	 * rationale as `reasoning` above (no field on the wire-format `Message`
	 * itself to hold it). Unlike `reasoning`, this used to be purely ephemeral
	 * (WebAgentSession.lastTurn, in-memory only, one entry for the whole
	 * session) — now persisted per-turn so every past reply in a thread shows
	 * its own footer on reload, not just whichever turn happened to be most
	 * recent when the page loaded. Only the web UI currently writes/reads this.
	 */
	turnMeta?: Record<number, TurnMeta>;
	/**
	 * Display title for this thread — defaults to a truncation of the first
	 * user message (set once, the first time one arrives) and can be
	 * overridden by an explicit rename. Optional: sessions saved before this
	 * field existed, or ones with no messages yet, fall back to showing the
	 * persona name instead. Currently only read/written by the web UI.
	 */
	title?: string;
	/** Pinned to the top of the web UI's session list. Web-only, like `title`. */
	pinned?: boolean;
	/** Build-mode task list written via the todo_write tool (see core/todo.ts
	 * and loop.ts's syncSystemPrompt) — kept off `messages` so it survives
	 * compaction, and restored on resume/continue so a long task list isn't
	 * silently dropped by ending the process mid-run. */
	todos?: TodoItem[];
	/** Set when the web UI has generated a public read-only link for this
	 * thread (`/shared/<token>`) — unset means never shared or since revoked.
	 * That route serves messages with no auth at all, so this must be an
	 * unguessable random token, not a derived/sequential id. */
	shareToken?: string;
	/** Pending plan picker state. The Markdown plan remains a project artifact;
	 * these transient UI decisions belong to the session record. */
	planQuestion?: PlanQuestion;
	planTransition?: PlanTransition;
}

/** Fold one turn's usage into the session's running totals. When `opts.subagent`
 * is set, the tokens are also accumulated into `subagentTokens` (still part of the
 * grand total) and the context-size tracker is left untouched — a subagent's
 * prompt size says nothing about the main session's context. */
const safe = (v: number | undefined) => Math.max(0, v ?? 0);

export function addUsage(
	session: SessionState,
	usage: Usage,
	opts?: { subagent?: boolean; background?: boolean },
): void {
	session.usage.promptTokens += safe(usage.promptTokens);
	session.usage.completionTokens += safe(usage.completionTokens);
	session.usage.totalTokens += safe(usage.totalTokens);
	if (usage.cost !== undefined) session.usage.cost += safe(usage.cost);
	if (usage.cacheReadTokens !== undefined) session.usage.cacheReadTokens += safe(usage.cacheReadTokens);
	if (usage.cacheWriteTokens !== undefined) session.usage.cacheWriteTokens += safe(usage.cacheWriteTokens);
	if (usage.uncachedTokens !== undefined) session.usage.uncachedTokens += safe(usage.uncachedTokens);
	if (opts?.subagent) {
		session.usage.subagentTokens += usage.totalTokens;
		return;
	}
	if (opts?.background) return;
	// Track the latest promptTokens as the authoritative context size.
	session.lastPromptTokens = usage.promptTokens;
}

// ============================================================================
// Token estimation
// ============================================================================

export function estimateTokens(messages: Message[]): number {
	// Rough estimate: ~3.8 characters per token. Walk the structure directly
	// to avoid materializing a huge JSON string via JSON.stringify.
	let chars = 0;
	for (const m of messages) {
		chars += 20; // JSON overhead per message (braces, role key, commas)
		if (typeof m.content === "string") {
			chars += m.content.length;
		} else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") {
					chars += part.text.length;
				} else {
					chars += 50; // structured content estimate
				}
			}
		}
		if ("tool_calls" in m && m.tool_calls) {
			for (const tc of m.tool_calls) {
				if (tc.type === "function") {
					chars += tc.function.name.length + tc.function.arguments.length + 30;
				}
			}
		}
		if ("name" in m && typeof m.name === "string") chars += m.name.length;
		if ("refusal" in m && typeof m.refusal === "string") chars += m.refusal.length;
		if (m.role === "tool" && "tool_call_id" in m && typeof m.tool_call_id === "string")
			chars += m.tool_call_id.length;
	}
	return Math.ceil(chars / 3.8);
}

// ============================================================================
// Compaction
// ============================================================================

interface CompactionSummary {
	summary: string;
	tokensBefore: number;
	messagesCompacted: number;
}

/**
 * Check if compaction is needed.
 *
 * Uses the API-reported promptTokens from the last call (authoritative).
 * Returns false when no API data is available (e.g. before the first turn
 * or session loaded from disk) — missing usage simply means no compaction
 * trigger; the provider will error with "context exceeded" if the
 * conversation grows too large.
 */
export function shouldCompact(_messages: Message[], config: AppConfig, lastPromptTokens?: number): boolean {
	if (lastPromptTokens === undefined) return false;
	const budget = config.contextWindow - config.maxResponseTokens;
	return lastPromptTokens > budget * config.compactionThreshold;
}

/**
 * Move a proposed cut index to the start of the nearest turn (the `user`
 * message that began it). Two things go wrong without this:
 *
 * 1. A `tool` result is only valid immediately after the `assistant`
 *    message whose `tool_calls` produced it — landing the cut between them
 *    sends the provider a message list it will reject outright (a tool
 *    result with no matching tool_calls in the same request).
 * 2. Even a cut that avoids (1) but lands mid-turn (e.g. between two
 *    tool-call rounds within the same turn) stashes half a turn's tool
 *    calls in "recent" with no user message explaining why they happened.
 *
 * Snapping to the turn boundary fixes both: a turn's messages always travel
 * together. Searches forward first — like pi's findCutPoint, which snaps to
 * the nearest valid boundary *at or after* where it stopped accumulating
 * "recent" tokens — so a mid-turn target extends "recent" rather than
 * shrinking it below what was asked for. Falls back to searching backward
 * only when there's no turn boundary ahead at all (the target is already
 * inside the last open turn); if that also finds nothing, 0 means "nothing
 * safely compactable yet", which compactMessages already treats as a no-op.
 * Simplified from pi's turn tree + separate turn-prefix summarization,
 * which we don't need since our split is a rough 60/40 index cut rather
 * than a strict token budget — there's already slack either side of it.
 */
/**
 * A `role: "user"` row that actually opens a turn — as opposed to the
 * synthetic image_url message loop.ts inserts mid-turn after a `read` on an
 * image file (there's no `role: "tool"` slot for images in the
 * OpenAI-compatible API, so it's smuggled in as a `user` message instead;
 * see loop.ts's castToolCallId comment). Landing a cut right after one of
 * those — indistinguishable from a real turn boundary by role alone — drops
 * the assistant message that declared the tool_calls while keeping later
 * `tool` results that reference it, producing exactly the "tool result's
 * tool id not found" 400 this function exists to prevent. A real turn
 * (typed text, or an image attached *to* that turn) always contains a text
 * part; the synthetic relay never does — image_url parts only. Checked
 * structurally (not via castToolCallId alone) so it also covers sessions
 * that predate that tag.
 */
function isRealTurnStart(m: Message | undefined): boolean {
	if (m?.role !== "user") return false;
	if (typeof m.content === "string") return true;
	if (!Array.isArray(m.content)) return false;
	return (m.content as Array<{ type?: string }>).some((p) => p.type === "text");
}

function safeCutIndex(messages: Message[], idx: number): number {
	const target = Math.max(0, Math.min(idx, messages.length));

	for (let i = target; i < messages.length; i++) {
		if (isRealTurnStart(messages[i])) return i;
	}
	for (let i = target; i > 0; i--) {
		if (isRealTurnStart(messages[i])) return i;
	}
	return 0;
}

// ============================================================================
// File operations tracking (for compaction summaries)
// ============================================================================

/**
 * Pull file paths touched by read/write/edit tool calls out of the messages
 * being summarized away, bucketed into read-only vs. modified, seeded with
 * whatever a previous compaction round already found (see
 * parseFileTagsFromSummary) so paths touched several compactions ago don't
 * fall off as each round only ever looks at its own slice of history. The
 * compaction prompt already asks the summarizer to "keep all file paths",
 * but that's a request, not a guarantee — this extracts them deterministically
 * from the tool_calls themselves and appends them to the summary, so a path
 * surviving compaction doesn't depend on the summarizer remembering it.
 */
function extractFileOps(
	messages: Message[],
	previousReadFiles: string[] = [],
	previousModifiedFiles: string[] = [],
): { readFiles: string[]; modifiedFiles: string[] } {
	const read = new Set(previousReadFiles);
	const written = new Set<string>();
	const edited = new Set(previousModifiedFiles);

	for (const m of messages) {
		if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
		for (const tc of m.tool_calls) {
			if (tc.type !== "function") continue;
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				continue;
			}
			const path = typeof args.path === "string" ? args.path : undefined;
			if (!path) continue;
			if (tc.function.name === "read") read.add(path);
			else if (tc.function.name === "write") written.add(path);
			else if (tc.function.name === "edit") edited.add(path);
		}
	}

	const modified = new Set([...written, ...edited]);
	const readFiles = [...read].filter((f) => !modified.has(f)).sort();
	return { readFiles, modifiedFiles: [...modified].sort() };
}

function formatFileOps(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Pull the `<read-files>`/`<modified-files>` tags back out of a previous summary. */
function parseFileTagsFromSummary(text: string): { readFiles: string[]; modifiedFiles: string[] } {
	const readMatch = text.match(READ_FILES_RE);
	const modifiedMatch = text.match(MODIFIED_FILES_RE);
	return {
		readFiles: readMatch ? readMatch[1]!.split("\n").filter(Boolean) : [],
		modifiedFiles: modifiedMatch ? modifiedMatch[1]!.split("\n").filter(Boolean) : [],
	};
}

/** Public alias for post-compact reminder assembly. */
export function fileTagsFromCompactionSummary(text: string): { readFiles: string[]; modifiedFiles: string[] } {
	return parseFileTagsFromSummary(text);
}

const COMPACTION_MARKER_PREFIX = "[Compacted context";

/**
 * Split a message array's system messages into the persona/instructions
 * ones and (if present) an existing compaction-summary marker. Repeat
 * compactions thread that summary back in as `previousSummary` so the
 * result is one running summary that gets updated, not a stack of markers
 * from every compaction round this session has ever hit.
 */
function extractPreviousCompaction(systemMessages: Message[]): {
	personaMessages: Message[];
	previousSummary?: string;
} {
	const personaMessages: Message[] = [];
	let previousSummary: string | undefined;

	for (const m of systemMessages) {
		const content = typeof m.content === "string" ? m.content : "";
		if (previousSummary === undefined && content.startsWith(COMPACTION_MARKER_PREFIX)) {
			const newlineIdx = content.indexOf("\n");
			previousSummary = newlineIdx === -1 ? "" : content.slice(newlineIdx + 1);
		} else {
			personaMessages.push(m);
		}
	}

	return { personaMessages, previousSummary };
}

const TOOL_RESULT_MAX_CHARS = 500;
const TAIL_MIN_TOKENS = 10_000;
const TAIL_MAX_TOKENS = 20_000;
const TAIL_MIN_TEXT_BLOCK_MESSAGES = 5;

/** One tool call as `name(arg=val, ...)`, truncating long argument values. */
function formatToolCall(name: string, argsJson: string): string {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(argsJson);
	} catch {
		return `${name}(${argsJson.slice(0, 200)})`;
	}
	const argsStr = Object.entries(args)
		.map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 200) : JSON.stringify(v)}`)
		.join(", ");
	return `${name}(${argsStr})`;
}

/**
 * Render one message as a line of text for the summarization prompt. The
 * OpenAI-shaped Message (content: string | null, tool_calls as a sibling
 * field) means an assistant turn that's purely a tool call has null content
 * — without surfacing tool_calls explicitly here, that turn would vanish
 * from the summarizer's input entirely, which for a coding agent (mostly
 * tool calls) throws away almost everything that happened.
 */
function formatMessageForSummary(m: Message): string {
	if (m.role === "assistant") {
		const parts: string[] = [];
		if (typeof m.content === "string" && m.content) parts.push(m.content);
		if ("tool_calls" in m && m.tool_calls) {
			for (const tc of m.tool_calls) {
				if (tc.type === "function")
					parts.push(`[tool call: ${formatToolCall(tc.function.name, tc.function.arguments)}]`);
			}
		}
		return `assistant: ${parts.join(" ") || "(no content)"}`;
	}
	if (m.role === "tool") return `tool (${m.tool_call_id}): ${String(m.content).slice(0, TOOL_RESULT_MAX_CHARS)}`;
	if (typeof m.content === "string") return `${m.role}: ${m.content.slice(0, 500)}`;
	return `${m.role}: [structured content]`;
}

/**
 * LLM-based compaction: summarize old messages, keep recent ones.
 *
 * summarizeFn's second argument is the previous compaction's summary, when
 * this isn't the first time this session has been compacted — pass it
 * through to the model as update-in-place context (matching pi's
 * UPDATE_SUMMARIZATION_PROMPT) rather than starting from scratch each time,
 * so the running summary keeps improving instead of each round only
 * knowing about its own slice of history.
 */
export async function compactMessages(
	messages: Message[],
	summarizeFn: (text: string, previousSummary?: string) => Promise<string>,
	_config: AppConfig,
): Promise<{ messages: Message[]; summary: CompactionSummary }> {
	const tokensBefore = estimateTokens(messages);

	// Preserve a token-budgeted tail, snapped to a real user-turn boundary so
	// tool_use/tool_result pairs and the current task stay together. Small
	// histories retain the old proportional behavior; large histories use the
	// same 10k–20k tail envelope as the checkpoint rebuild path.
	const { personaMessages: system, previousSummary } = extractPreviousCompaction(
		messages.filter((m) => m.role === "system"),
	);
	const nonSystem = messages.filter((m) => m.role !== "system");
	const nonSystemTokens = estimateTokens(nonSystem);
	const targetTailTokens =
		nonSystemTokens < TAIL_MIN_TOKENS * 1.5
			? Math.max(1, Math.floor(nonSystemTokens * 0.4))
			: Math.min(TAIL_MAX_TOKENS, Math.max(TAIL_MIN_TOKENS, Math.floor(nonSystemTokens * 0.4)));
	let tailStart = nonSystem.length;
	let tailTokens = 0;
	let textBlocks = 0;
	const requiredTextBlocks = nonSystemTokens < TAIL_MIN_TOKENS * 1.5 ? 0 : TAIL_MIN_TEXT_BLOCK_MESSAGES;
	for (let i = nonSystem.length - 1; i >= 0; i--) {
		const message = nonSystem[i]!;
		tailTokens += estimateTokens([message]);
		if (typeof message.content === "string" && message.content.trim()) textBlocks += 1;
		tailStart = i;
		if (tailTokens >= targetTailTokens && textBlocks >= requiredTextBlocks) break;
	}
	const splitIdx = safeCutIndex(nonSystem, tailStart);
	const old = nonSystem.slice(0, splitIdx);
	const recent = nonSystem.slice(splitIdx);

	// No safe cut point below the target split (a degenerate history —
	// e.g. one long unbroken tool-call chain with nothing before it) means
	// there's nothing to compact yet. Skip the LLM call rather than
	// "summarizing" zero messages and injecting a pointless marker.
	if (old.length === 0) {
		return { messages, summary: { summary: "", tokensBefore, messagesCompacted: 0 } };
	}

	// File tags are appended to the LLM's output below, not baked into its
	// input — extraction is deterministic from the tool_calls themselves,
	// so there's no reason to hope the model reproduces them verbatim (it
	// wasn't even asked to; the structured summary template has no tags
	// section). Matches pi: formatFileOperations is appended after the
	// summarization call, not folded into the conversation text.
	const previousFileTags = previousSummary ? parseFileTagsFromSummary(previousSummary) : undefined;
	const { readFiles, modifiedFiles } = extractFileOps(
		old,
		previousFileTags?.readFiles,
		previousFileTags?.modifiedFiles,
	);
	const oldText = old.map(formatMessageForSummary).join("\n");

	const summarized = await summarizeFn(oldText, previousSummary);
	// A summarization call that *succeeds* with nothing usable is a failure,
	// not a compaction. Without this check an empty response still flipped
	// every old row out of context and replaced it with a content-free marker
	// — the caller reported `compacted: true` and the model was handed a
	// summary of nothing, irreversibly for the running conversation (the rows
	// survive on disk, but the working context doesn't get them back).
	// Providers produce this in ordinary ways: a reasoning-only stream, a
	// refusal emitted as an empty assistant turn, a stream truncated without
	// throwing. Throwing here puts it on the same path as a network failure,
	// which leaves the history untouched and retries on the next turn.
	if (!summarized.trim()) throw new Error("Compaction summary came back empty — keeping the full history.");
	const summary = summarized + formatFileOps(readFiles, modifiedFiles);

	const compacted: Message[] = [
		...system,
		{
			role: "system",
			content: `${COMPACTION_MARKER_PREFIX} — ${old.length} messages summarized]\n${summary}`,
		},
		...recent,
	];

	return {
		messages: compacted,
		summary: {
			summary,
			tokensBefore,
			messagesCompacted: old.length,
		},
	};
}

// ============================================================================
// Session persistence (SQLite)
//
// One row per message, flagged `in_context` rather than deleted. Compaction
// (recordCompaction) flips the flag on superseded rows and inserts the
// summary marker — nothing is ever removed, so the full transcript survives
// on disk regardless of how many times a session gets compacted.
// `SessionState.messages` keeps its existing meaning: the in-context working
// set fed to runAgentLoop (`WHERE in_context = 1`). getFullHistory() is the
// new thing display/resume call sites read instead.
// ============================================================================

/** Maps a live message object to the DB row it's already persisted as, so
 *  saveSession/recordCompaction never have to reason about array indices —
 *  those shift under compaction, but object identity doesn't. Populated both
 *  on insert and on load (loadSession seeds every row it reads), so a
 *  session swapped into a live SessionState (e.g. /continue) is recognized
 *  as already-persisted instead of being re-inserted as new rows. */
const messageSeq = new WeakMap<Message, number>();
const messageMessageId = new WeakMap<Message, string>();

function nextSeqFor(sessionId: string): number {
	const db = getDb();
	const row = db
		.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = ?")
		.get(sessionId) as { next: number } | undefined;
	return row?.next ?? 0;
}

/** Extract metadata-only fields for the `sessions` row. */
function sessionMetaRow(session: SessionState) {
	return {
		id: session.id,
		cwd: session.cwd ?? null,
		model: session.model,
		persona: session.persona ?? null,
		mode: session.mode ?? null,
		title: session.title ?? null,
		pinned: session.pinned ? 1 : 0,
		created_at: session.createdAt,
		updated_at: session.updatedAt,
		last_prompt_tokens: session.lastPromptTokens ?? null,
		checkpoint_watermark_seq: session.checkpointWatermarkSeq ?? null,
		last_announced_local_date: session.lastAnnouncedLocalDate ?? null,
		provider_url: session.providerUrl ?? null,
		provider_name: session.providerName ?? null,
		session_kind: session.sessionKind ?? "conversation",
		parent_session_id: session.parentSessionId ?? null,
		background_kind: session.backgroundKind ?? null,
		usage_json: JSON.stringify(session.usage),
		todos_json: session.todos ? JSON.stringify(session.todos) : null,
		share_token: session.shareToken ?? null,
		plan_question_json: session.planQuestion ? JSON.stringify(session.planQuestion) : null,
		plan_transition_json: session.planTransition ? JSON.stringify(session.planTransition) : null,
		version: session.version ?? 0,
	};
}

export function saveSession(session: SessionState): void {
	session.version = (session.version ?? 0) + 1;
	session.updatedAt = new Date().toISOString();
	const db = getDb();
	// Every row this save writes goes in as one transaction. The sessions
	// UPSERT bumps version/updated_at and each message is a separate INSERT,
	// so a throw (or a crash) partway through used to leave the session row
	// claiming a version whose messages were only half persisted. BEGIN
	// IMMEDIATE like the other write transactions in this file, so a
	// concurrent writer waits out busy_timeout instead of failing on its
	// first write, and the isTransaction check keeps a caller that already
	// opened a transaction reentrant.
	const pending = db.isTransaction
		? writeSessionRows(db, session)
		: (() => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const rows = writeSessionRows(db, session);
					db.exec("COMMIT");
					return rows;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			})();
	// Applied only once the rows are committed: mapping a message to a seq
	// that got rolled back would make every later save treat it as already
	// persisted and skip it forever.
	for (const [message, seq, messageId] of pending) {
		messageSeq.set(message, seq);
		if (messageId !== undefined) messageMessageId.set(message, messageId);
	}
}

/** The row writes behind saveSession, split out so the transaction wrapper
 *  above stays readable. Returns the message→seq/id mappings to record once
 *  the transaction commits, rather than setting them as it goes. */
function writeSessionRows(db: DatabaseSync, session: SessionState): Array<[Message, number, string | undefined]> {
	const pending: Array<[Message, number, string | undefined]> = [];
	const meta = sessionMetaRow(session);
	db.prepare(
		`INSERT INTO sessions (id, cwd, model, persona, mode, title, pinned, created_at, updated_at, last_prompt_tokens, last_announced_local_date, provider_url, provider_name, session_kind, parent_session_id, background_kind, usage_json, todos_json, share_token, plan_question_json, plan_transition_json, checkpoint_watermark_seq, version)
			 VALUES (:id, :cwd, :model, :persona, :mode, :title, :pinned, :created_at, :updated_at, :last_prompt_tokens, :last_announced_local_date, :provider_url, :provider_name, :session_kind, :parent_session_id, :background_kind, :usage_json, :todos_json, :share_token, :plan_question_json, :plan_transition_json, :checkpoint_watermark_seq, :version)
		 ON CONFLICT(id) DO UPDATE SET
		   cwd = excluded.cwd, model = excluded.model, persona = excluded.persona, mode = excluded.mode,
		   title = excluded.title, pinned = excluded.pinned, updated_at = excluded.updated_at,
		   last_prompt_tokens = excluded.last_prompt_tokens, last_announced_local_date = excluded.last_announced_local_date,
		   provider_url = excluded.provider_url, provider_name = excluded.provider_name, session_kind = excluded.session_kind,
		   parent_session_id = excluded.parent_session_id, background_kind = excluded.background_kind,
		   usage_json = excluded.usage_json, todos_json = excluded.todos_json,
		   share_token = excluded.share_token, plan_question_json = excluded.plan_question_json,
		   plan_transition_json = excluded.plan_transition_json,
		   version = excluded.version,
		   checkpoint_watermark_seq = CASE
		     WHEN sessions.checkpoint_watermark_seq IS NULL THEN excluded.checkpoint_watermark_seq
		     WHEN excluded.checkpoint_watermark_seq IS NULL THEN sessions.checkpoint_watermark_seq
		     ELSE MAX(sessions.checkpoint_watermark_seq, excluded.checkpoint_watermark_seq)
		   END`,
	).run(meta);

	const insertRow = db.prepare(
		"INSERT INTO messages (session_id, seq, message_id, role, content_json, in_context, has_tool_calls, reasoning, turn_meta) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
	);
	const updateReasoning = db.prepare("UPDATE messages SET reasoning = ? WHERE session_id = ? AND seq = ?");
	const updateTurnMeta = db.prepare("UPDATE messages SET turn_meta = ? WHERE session_id = ? AND seq = ?");
	// syncSystemPrompt (loop.ts) rebuilds messages[0] fresh every turn — a new
	// object even when the text is unchanged — so a naive "insert if this
	// object was never seen before" would pile up one permanent in_context
	// row per turn forever. The persona system message isn't a real
	// conversation turn worth keeping every historical copy of in-context;
	// superseding it here (not deleting — still visible via getFullHistory)
	// keeps the in-context working set at exactly one current system row,
	// same as it's always conceptually been. The compaction marker (also
	// role "system") is deliberately exempt — that one IS a real turn.
	const deactivateOldSystemRows = db.prepare(
		"UPDATE messages SET in_context = 0 WHERE session_id = ? AND role = 'system' AND in_context = 1 AND content_json NOT LIKE ?",
	);
	// syncSystemPrompt re-runs (and rebuilds messages[0] as a new object) on
	// every inner-loop iteration — every tool-call round within a turn, not
	// just once per turn — but the text itself is usually unchanged between
	// rounds. Without this check, a long tool-heavy turn would write one
	// multi-KB near-duplicate persona blob per round; comparing against the
	// currently active row first turns the common case into a plain lookup
	// with no write at all.
	const currentSystemRow = db.prepare(
		"SELECT seq, content_json FROM messages WHERE session_id = ? AND role = 'system' AND in_context = 1 AND content_json NOT LIKE ? ORDER BY seq DESC LIMIT 1",
	);

	let seq = nextSeqFor(session.id);
	(Array.isArray(session.messages) ? session.messages : []).forEach((m, i) => {
		const reasoning = session.reasoning?.[i] ?? null;
		const turnMetaEntry = session.turnMeta?.[i];
		const turnMetaJson = turnMetaEntry ? JSON.stringify(turnMetaEntry) : null;
		const existing = messageSeq.get(m);
		if (existing !== undefined) {
			if (reasoning) updateReasoning.run(reasoning, session.id, existing);
			if (turnMetaJson) updateTurnMeta.run(turnMetaJson, session.id, existing);
			return;
		}
		if (m.role === "system" && typeof m.content === "string" && !m.content.startsWith(COMPACTION_MARKER_PREFIX)) {
			const serialized = JSON.stringify(m);
			const current = currentSystemRow.get(session.id, `%${COMPACTION_MARKER_PREFIX}%`) as
				| { seq: number; content_json: string }
				| undefined;
			if (current && current.content_json === serialized) {
				// Identical to the already-active row — alias this turn's fresh
				// object to that row instead of writing a redundant duplicate.
				pending.push([m, current.seq, undefined]);
				return;
			}
			deactivateOldSystemRows.run(session.id, `%${COMPACTION_MARKER_PREFIX}%`);
		}
		const messageId = randomUUID();
		insertRow.run(
			session.id,
			seq,
			messageId,
			m.role,
			JSON.stringify(m),
			isToolCallOnly(m) ? 1 : 0,
			reasoning,
			turnMetaJson,
		);
		pending.push([m, seq, messageId]);
		seq++;
	});
	return pending;
}

/** Return the message id covered by the last successful checkpoint. */
export function getCheckpointWatermark(sessionId: string): string | undefined {
	const row = getDb().prepare("SELECT checkpoint_watermark_message_id FROM sessions WHERE id = ?").get(sessionId) as
		| { checkpoint_watermark_message_id: string | null }
		| undefined;
	return row?.checkpoint_watermark_message_id ?? undefined;
}

function persistedMessageSeq(sessionId: string, message: Message): number | undefined {
	const serialized = JSON.stringify(message);
	const known = messageSeq.get(message);
	if (known !== undefined) {
		const row = getDb()
			.prepare("SELECT content_json FROM messages WHERE session_id = ? AND seq = ?")
			.get(sessionId, known) as { content_json: string } | undefined;
		if (row?.content_json === serialized) return known;
	}
	const row = getDb()
		.prepare("SELECT seq FROM messages WHERE session_id = ? AND content_json = ? ORDER BY seq DESC LIMIT 1")
		.get(sessionId, serialized) as { seq: number } | undefined;
	return row?.seq;
}

function persistedMessageId(sessionId: string, message: Message): string | undefined {
	const serialized = JSON.stringify(message);
	const known = messageMessageId.get(message);
	if (known !== undefined) {
		const knownSeq = messageSeq.get(message);
		const row =
			knownSeq === undefined
				? undefined
				: (getDb()
						.prepare("SELECT message_id, content_json FROM messages WHERE session_id = ? AND seq = ?")
						.get(sessionId, knownSeq) as { message_id: string; content_json: string } | undefined);
		if (row && row.message_id === known && row.content_json === serialized) return known;
	}
	const row = getDb()
		.prepare("SELECT message_id FROM messages WHERE session_id = ? AND content_json = ? ORDER BY seq DESC LIMIT 1")
		.get(sessionId, serialized) as { message_id: string } | undefined;
	return row?.message_id;
}

/** The watermark message's current sequence, resolving the stored id against the live table. */
function watermarkMessageSeq(sessionId: string): number | undefined {
	const watermark = getCheckpointWatermark(sessionId);
	if (watermark === undefined) return undefined;
	const row = getDb()
		.prepare("SELECT seq FROM messages WHERE session_id = ? AND message_id = ?")
		.get(sessionId, watermark) as { seq: number } | undefined;
	return row?.seq;
}

/**
 * Commit the message covered by a completed writer. The row lookup and
 * monotonic update share one immediate transaction so a stale writer cannot
 * move the boundary backwards or claim success for an unpersisted snapshot.
 * The watermark is an immutable message id, so compaction seq shifts never
 * invalidate it.
 */
export function commitCheckpointWatermark(sessionId: string, message: Message): boolean {
	const db = getDb();
	const commit = (): boolean => {
		const messageId = persistedMessageId(sessionId, message);
		if (messageId === undefined) return false;
		const targetSeq = db
			.prepare("SELECT seq FROM messages WHERE session_id = ? AND message_id = ?")
			.get(sessionId, messageId) as { seq: number } | undefined;
		if (!targetSeq) return false;
		const current = getCheckpointWatermark(sessionId);
		if (current !== undefined) {
			const currentSeq = db
				.prepare("SELECT seq FROM messages WHERE session_id = ? AND message_id = ?")
				.get(sessionId, current) as { seq: number } | undefined;
			if (currentSeq !== undefined && currentSeq.seq > targetSeq.seq) return false;
		}
		return (
			db.prepare("UPDATE sessions SET checkpoint_watermark_message_id = ? WHERE id = ?").run(messageId, sessionId)
				.changes > 0
		);
	};
	if (db.isTransaction) return commit();
	db.exec("BEGIN IMMEDIATE");
	try {
		const committed = commit();
		db.exec("COMMIT");
		return committed;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** Return the in-memory index of the newest active message covered by the watermark. */
export function findCheckpointBoundaryForMessages(sessionId: string, messages: Message[]): number {
	const watermarkSeq = watermarkMessageSeq(sessionId);
	if (watermarkSeq === undefined) return -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || message.role === "system") continue;
		const seq = persistedMessageSeq(sessionId, message);
		if (seq !== undefined && seq <= watermarkSeq) return i;
	}
	return -1;
}

/** Load the durable transcript delta after the last successful checkpoint. */
export function getMessagesAfterCheckpoint(sessionId: string): Message[] {
	const watermarkSeq = watermarkMessageSeq(sessionId);
	if (watermarkSeq === undefined) return [];
	const rows = getDb()
		.prepare("SELECT content_json FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq")
		.all(sessionId, watermarkSeq) as Array<{ content_json: string }>;
	const messages = rows.map((row) => JSON.parse(row.content_json) as Message);
	normalizeStoredMessages(messages);
	return messages.filter((message) => message.role !== "system");
}

/** Persist only the session routing identity. TUI model/provider switches can
 * happen while the daemon owns a newer message history; upserting the whole
 * local SessionState there would overwrite that history with a stale mirror. */
export function updateSessionIdentity(
	session: Pick<SessionState, "id" | "model" | "providerUrl" | "providerName">,
): void {
	const updatedAt = new Date().toISOString();
	// provider_name is always overwritten with whatever's on the in-memory
	// session (including clearing it to NULL when absent) rather than left
	// untouched — a caller that updates providerUrl without also supplying
	// the matching providerName (e.g. the TUI's /model, which only tracks
	// the currently-active provider by URL) must not leave a now-stale name
	// behind for a run to trust over the URL it just changed.
	const result = getDb()
		.prepare("UPDATE sessions SET model = ?, provider_url = ?, provider_name = ?, updated_at = ? WHERE id = ?")
		.run(session.model, session.providerUrl ?? null, session.providerName ?? null, updatedAt, session.id);
	if (result.changes === 0) saveSession(session as SessionState);
}

/**
 * Called from the compaction callback with the full pre-cut message array
 * and the marker-bearing replacement compactMessages() built. Nothing is
 * deleted: rows already in the DB that didn't survive into `compacted` get
 * `in_context = 0`; any message in `fullHistoryBeforeCompaction` not yet
 * persisted (e.g. added earlier this same turn, before any save) gets
 * inserted now with the correct flag, so it's never lost even if it was
 * folded into the summary before ever hitting disk on its own. The one new
 * object in `compacted` (the summary marker) is inserted last.
 */
function recordCompactionInTransaction(
	session: SessionState,
	fullHistoryBeforeCompaction: Message[],
	compacted: Message[],
): void {
	const db = getDb();
	const kept = new Set(compacted);
	const insertRow = db.prepare(
		"INSERT INTO messages (session_id, seq, message_id, role, content_json, in_context, has_tool_calls) VALUES (?, ?, ?, ?, ?, ?, ?)",
	);
	const flipOut = db.prepare("UPDATE messages SET in_context = 0 WHERE session_id = ? AND seq = ?");

	let seq = nextSeqFor(session.id);
	for (const m of fullHistoryBeforeCompaction) {
		const existing = messageSeq.get(m);
		if (existing !== undefined) {
			if (!kept.has(m)) flipOut.run(session.id, existing);
			continue;
		}
		const messageId = randomUUID();
		insertRow.run(
			session.id,
			seq,
			messageId,
			m.role,
			JSON.stringify(m),
			kept.has(m) ? 1 : 0,
			isToolCallOnly(m) ? 1 : 0,
		);
		messageSeq.set(m, seq);
		messageMessageId.set(m, messageId);
		seq++;
	}

	const marker = compacted.find((m) => !fullHistoryBeforeCompaction.includes(m));
	if (marker && !messageSeq.has(marker)) {
		// The marker must sort BEFORE the kept "recent" messages in the
		// in-context view (summary, then what's still ongoing) even though
		// those messages were inserted earlier and already hold lower seqs.
		// Make room by shifting them (and anything already after them) up by
		// one — one row at a time, descending, so the WITHOUT ROWID primary
		// key never collides mid-shift — then insert the marker into the
		// vacated slot.
		const keptSeqs = compacted
			.filter((m) => m !== marker)
			.map((m) => messageSeq.get(m))
			.filter((s): s is number => s !== undefined);
		const insertAt = keptSeqs.length > 0 ? Math.min(...keptSeqs) : seq;
		if (keptSeqs.length > 0) {
			const shiftRows = db
				.prepare("SELECT seq FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq DESC")
				.all(session.id, insertAt) as Array<{ seq: number }>;
			const shiftOne = db.prepare("UPDATE messages SET seq = seq + 1 WHERE session_id = ? AND seq = ?");
			for (const row of shiftRows) shiftOne.run(session.id, row.seq);
			// The watermark references an immutable message_id, so a seq shift
			// does not move it — no adjustment needed here.
			for (const m of compacted) {
				if (m === marker) continue;
				const s = messageSeq.get(m);
				if (s !== undefined && s >= insertAt) messageSeq.set(m, s + 1);
			}
		}
		const markerId = randomUUID();
		insertRow.run(
			session.id,
			insertAt,
			markerId,
			marker.role,
			JSON.stringify(marker),
			1,
			isToolCallOnly(marker) ? 1 : 0,
		);
		messageSeq.set(marker, insertAt);
		messageMessageId.set(marker, markerId);
	}
}

/** Persist compaction rows, context flags, and watermark shifts atomically. */
export function recordCompaction(
	session: SessionState,
	fullHistoryBeforeCompaction: Message[],
	compacted: Message[],
): void {
	const db = getDb();
	if (db.isTransaction) {
		recordCompactionInTransaction(session, fullHistoryBeforeCompaction, compacted);
		return;
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		recordCompactionInTransaction(session, fullHistoryBeforeCompaction, compacted);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** Full, never-truncated transcript for display/resume — every message the
 *  session ever had, in order, regardless of `in_context`. Distinct from
 *  `session.messages`, which after a compaction only holds the shrunk
 *  context actually sent to the model. */
export function getFullHistory(id: string): Message[] {
	return getFullHistoryWithReasoning(id).messages;
}

/** Same as getFullHistory, plus each message's stored reasoning and turn-meta
 *  (if any), re-keyed to indices into the returned (full-history) array —
 *  the row's `reasoning`/`turn_meta` columns, not the fragile
 *  index-into-session.messages maps (`SessionState.reasoning`/`turnMeta`)
 *  used for the in-context working set. */
export function getFullHistoryWithReasoning(id: string): {
	messages: Message[];
	reasoning: Record<number, string>;
	turnMeta: Record<number, TurnMeta>;
	/** DB `seq` per returned index — lets a caller address a specific row
	 *  later (e.g. to stream an embedded image out-of-band) without re-doing
	 *  the array-position bookkeeping that reasoning/turnMeta already need. */
	seqs: number[];
} {
	const db = getDb();
	const rows = db
		.prepare("SELECT seq, content_json, reasoning, turn_meta FROM messages WHERE session_id = ? ORDER BY seq")
		.all(id) as Array<{ seq: number; content_json: string; reasoning: string | null; turn_meta: string | null }>;
	const messages: Message[] = [];
	const reasoning: Record<number, string> = {};
	const turnMeta: Record<number, TurnMeta> = {};
	const seqs: number[] = [];
	rows.forEach((r, i) => {
		messages.push(JSON.parse(r.content_json) as Message);
		if (r.reasoning) reasoning[i] = r.reasoning;
		if (r.turn_meta) turnMeta[i] = JSON.parse(r.turn_meta) as TurnMeta;
		seqs.push(r.seq);
	});
	return { messages, reasoning, turnMeta, seqs };
}

/** One image embedded in a `read`-on-image-file message (see loop.ts's
 *  imageDataUrl handling), decoded back to raw bytes for the image-blob
 *  route — the JSON session/history responses carry a URL to this instead
 *  of the inline data: URL so a handful of photos doesn't turn a session
 *  load into a multi-MB payload (same class of problem getHistoryPage's
 *  pagination already solves for message count). */
export function getMessageImage(
	id: string,
	seq: number,
	imageIndex: number,
): { mimeType: string; buffer: Buffer } | undefined {
	const db = getDb();
	const row = db.prepare("SELECT content_json FROM messages WHERE session_id = ? AND seq = ?").get(id, seq) as
		| { content_json: string }
		| undefined;
	if (!row) return undefined;
	const message = JSON.parse(row.content_json) as Message;
	if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
	const parts = message.content as Array<{ type?: string; image_url?: { url?: string } }>;
	const imageParts = parts.filter((p) => p.type === "image_url" && p.image_url?.url);
	const url = imageParts[imageIndex]?.image_url?.url;
	if (!url) return undefined;
	const match = DATAURL_RE.exec(url);
	if (!match) return undefined;
	return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") };
}

export interface HistoryPage {
	messages: Message[];
	reasoning: Record<number, string>;
	turnMeta: Record<number, TurnMeta>;
	/** DB `seq` per returned index — see getFullHistoryWithReasoning's field
	 *  of the same name. */
	seqs: number[];
	/** seq of the earliest message in this page — pass as `beforeSeq` to fetch
	 *  the page before this one. undefined when the page is empty. */
	oldestSeq: number | undefined;
	/** True if there's at least one more turn further back than this page. */
	hasMore: boolean;
}

const DEFAULT_HISTORY_PAGE_TURNS = 30;

/**
 * One page of full history, newest-first pagination, always cut on a turn
 * boundary (a `role: "user"` row) — never mid-turn, so a page can't split a
 * `tool_calls`/`tool` pair the way an arbitrary row-count cut could (same
 * concern `safeCutIndex` in compaction handles for the same reason).
 *
 * `beforeSeq` omitted fetches the most recent page. Pass a previous call's
 * `oldestSeq` to page further back. Reading a whole long-lived session's
 * history in one shot (getFullHistory) is what `GET /api/sessions/:id` used
 * to always do — fine for a normal thread, but a session with thousands of
 * turns turned that into a multi-MB response and thousands of DOM nodes on
 * every reload. This is what the web client's scroll-up pagination uses
 * instead; getFullHistory/getFullHistoryWithReasoning are unchanged and
 * still used where the whole thing genuinely is needed (e.g. summaries).
 */
export function getHistoryPage(
	id: string,
	beforeSeq?: number,
	turns: number = DEFAULT_HISTORY_PAGE_TURNS,
): HistoryPage {
	const db = getDb();
	// The seq of the earliest user-turn boundary among the `turns` most
	// recent user messages before the cutoff — this is where the page starts.
	const boundary = db
		.prepare(
			`SELECT seq FROM (
				SELECT seq FROM messages
				WHERE session_id = ? AND role = 'user' AND (? IS NULL OR seq < ?)
				ORDER BY seq DESC LIMIT ?
			) ORDER BY seq ASC LIMIT 1`,
		)
		.get(id, beforeSeq ?? null, beforeSeq ?? null, turns) as { seq: number } | undefined;

	if (!boundary) return { messages: [], reasoning: {}, turnMeta: {}, seqs: [], oldestSeq: undefined, hasMore: false };

	const rows = db
		.prepare(
			`SELECT seq, content_json, reasoning, turn_meta FROM messages
			 WHERE session_id = ? AND seq >= ? AND (? IS NULL OR seq < ?)
			 ORDER BY seq ASC`,
		)
		.all(id, boundary.seq, beforeSeq ?? null, beforeSeq ?? null) as Array<{
		seq: number;
		content_json: string;
		reasoning: string | null;
		turn_meta: string | null;
	}>;

	const messages: Message[] = [];
	const reasoning: Record<number, string> = {};
	const turnMeta: Record<number, TurnMeta> = {};
	const seqs: number[] = [];
	let oldestSeq: number | undefined;
	rows.forEach((r, i) => {
		messages.push(JSON.parse(r.content_json) as Message);
		if (r.reasoning) reasoning[i] = r.reasoning;
		if (r.turn_meta) turnMeta[i] = JSON.parse(r.turn_meta) as TurnMeta;
		seqs.push(r.seq);
		if (oldestSeq === undefined) oldestSeq = r.seq;
	});

	const hasMore = Boolean(
		db.prepare("SELECT 1 FROM messages WHERE session_id = ? AND role = 'user' AND seq < ?").get(id, boundary.seq),
	);

	return { messages, reasoning, turnMeta, seqs, oldestSeq, hasMore };
}

/** Full wipe: deletes every message row for the session (not just flags them
 *  off) — `/clear`'s contract is "forget this thread's history entirely",
 *  distinct from compaction's "keep it, just stop sending it to the model". */
export function clearSessionMessages(session: SessionState): void {
	const db = getDb();
	const clear = () =>
		withMessageFtsClearedFor(db, [session.id], () =>
			db.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id),
		);
	if (db.isTransaction) {
		clear();
	} else {
		db.exec("BEGIN IMMEDIATE");
		try {
			clear();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	session.messages = [];
}

/** Starts a new model-facing phase without deleting the transcript the user
 * sees. Used when an approved plan should be implemented without exploration
 * noise: old rows remain in history, but none are sent to the next run. */
export function resetSessionContext(session: SessionState): string | undefined {
	const originalTask = getFullHistory(session.id).find(
		(message): message is Message & { role: "user"; content: string } =>
			message.role === "user" && typeof message.content === "string",
	)?.content;
	getDb().prepare("UPDATE messages SET in_context = 0 WHERE session_id = ?").run(session.id);
	session.messages = [];
	session.reasoning = undefined;
	session.turnMeta = undefined;
	session.lastPromptTokens = undefined;
	return originalTask;
}

/** Sessions saved before `usage` existed don't have it on disk — default it in. */
function withUsageDefault(usage: SessionUsage | undefined): SessionUsage {
	return {
		promptTokens: usage?.promptTokens ?? 0,
		completionTokens: usage?.completionTokens ?? 0,
		totalTokens: usage?.totalTokens ?? 0,
		cost: usage?.cost ?? 0,
		cacheReadTokens: usage?.cacheReadTokens ?? 0,
		cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
		uncachedTokens: usage?.uncachedTokens ?? 0,
		subagentTokens: usage?.subagentTokens ?? 0,
	};
}

/**
 * Undo provider-specific damage persisted by older builds: applyCacheControl
 * used to mutate the live message objects (string content → [{type: "text",
 * text, cache_control}]) and older saves wrote that request-only shape to
 * disk. A provider whose chat template expects plain string content then
 * 400s on every resumed session ("Can only get item pairs from a mapping").
 * Flatten all-text part arrays back to strings and drop cache_control
 * everywhere; genuinely multimodal arrays (image parts) are kept as arrays,
 * only stripped of cache_control.
 */
function normalizeStoredMessages(messages: Message[]): void {
	for (const message of messages as Array<{ content?: unknown }>) {
		const content = message.content;
		if (!Array.isArray(content)) continue;
		const parts = content.map((p) => {
			if (p && typeof p === "object" && "cache_control" in p) {
				const { cache_control: _dropped, ...rest } = p as Record<string, unknown>;
				return rest;
			}
			return p;
		});
		const allText = parts.every(
			(p) =>
				p &&
				typeof p === "object" &&
				(p as { type?: unknown }).type === "text" &&
				typeof (p as { text?: unknown }).text === "string",
		);
		message.content = allText ? parts.map((p) => (p as { text: string }).text).join("") : parts;
	}
}

interface SessionRow {
	id: string;
	cwd: string | null;
	model: string | null;
	persona: string | null;
	mode: "plan" | "build" | null;
	title: string | null;
	pinned: number;
	created_at: string;
	updated_at: string;
	last_prompt_tokens: number | null;
	checkpoint_watermark_seq: number | null;
	last_announced_local_date: string | null;
	provider_url: string | null;
	provider_name: string | null;
	session_kind: "conversation" | "background" | null;
	parent_session_id: string | null;
	background_kind: "memory-dream" | "memory-distill" | null;
	usage_json: string;
	todos_json: string | null;
	share_token: string | null;
	plan_question_json: string | null;
	plan_transition_json: string | null;
	version: number | null;
}

function rowToMeta(row: SessionRow): Omit<SessionState, "messages"> {
	return {
		id: row.id,
		cwd: row.cwd ?? undefined,
		model: row.model ?? "",
		persona: row.persona ?? undefined,
		mode: row.mode ?? undefined,
		title: row.title ?? undefined,
		pinned: row.pinned === 1 ? true : undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastPromptTokens: row.last_prompt_tokens ?? undefined,
		checkpointWatermarkSeq: row.checkpoint_watermark_seq ?? undefined,
		lastAnnouncedLocalDate: row.last_announced_local_date ?? undefined,
		providerUrl: row.provider_url ?? undefined,
		providerName: row.provider_name ?? undefined,
		sessionKind: row.session_kind ?? "conversation",
		parentSessionId: row.parent_session_id ?? undefined,
		backgroundKind: row.background_kind ?? undefined,
		usage: withUsageDefault(JSON.parse(row.usage_json)),
		todos: row.todos_json ? JSON.parse(row.todos_json) : undefined,
		shareToken: row.share_token ?? undefined,
		planQuestion: row.plan_question_json ? (JSON.parse(row.plan_question_json) as PlanQuestion) : undefined,
		planTransition:
			row.plan_transition_json && (JSON.parse(row.plan_transition_json) as { kind?: unknown }).kind === "done"
				? { kind: "done" }
				: undefined,
		version: row.version ?? undefined,
	};
}

/** Loads the in-context working set (`in_context = 1`) into
 *  `SessionState.messages`, seeding messageSeq for every row read so a
 *  later saveSession/recordCompaction on this object recognizes them as
 *  already-persisted. */
export function loadSession(id: string): SessionState | null {
	return loadSessionByRow(getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined);
}

/** Read the mutable session identity without loading its messages. The daemon
 * uses this at turn boundaries to notice model/provider changes made by TUI
 * or another web surface while it was idle. */
export function loadSessionMeta(
	id: string,
): Pick<SessionState, "id" | "model" | "providerUrl" | "providerName" | "updatedAt"> | null {
	const row = getDb()
		.prepare("SELECT id, model, updated_at, provider_url, provider_name FROM sessions WHERE id = ?")
		.get(id) as Pick<SessionRow, "id" | "model" | "updated_at" | "provider_url" | "provider_name"> | undefined;
	if (!row) return null;
	return {
		id: row.id,
		model: row.model ?? "",
		updatedAt: row.updated_at,
		providerUrl: row.provider_url ?? undefined,
		providerName: row.provider_name ?? undefined,
	};
}

/** Same lookup as `loadSession`, keyed by the public share link's token
 *  instead of the session id — used by the unauthenticated `/shared/:token`
 *  route, so it never has to expose real session ids to a logged-out
 *  visitor. Returns null for an unshared/revoked/unknown token. */
export function loadSessionByShareToken(token: string): SessionState | null {
	return loadSessionByRow(
		getDb().prepare("SELECT * FROM sessions WHERE share_token = ?").get(token) as SessionRow | undefined,
	);
}

function loadSessionByRow(row: SessionRow | undefined): SessionState | null {
	if (!row) return null;
	const db = getDb();
	const msgRows = db
		.prepare(
			"SELECT seq, content_json, reasoning, turn_meta FROM messages WHERE session_id = ? AND in_context = 1 ORDER BY seq",
		)
		.all(row.id) as Array<{ seq: number; content_json: string; reasoning: string | null; turn_meta: string | null }>;

	const messages: Message[] = [];
	const reasoning: Record<number, string> = {};
	const turnMeta: Record<number, TurnMeta> = {};
	msgRows.forEach((r, i) => {
		const m = JSON.parse(r.content_json) as Message;
		messageSeq.set(m, r.seq);
		messages.push(m);
		if (r.reasoning) reasoning[i] = r.reasoning;
		if (r.turn_meta) turnMeta[i] = JSON.parse(r.turn_meta) as TurnMeta;
	});
	normalizeStoredMessages(messages);

	const session: SessionState = { ...rowToMeta(row), messages };
	if (Object.keys(reasoning).length > 0) session.reasoning = reasoning;
	if (Object.keys(turnMeta).length > 0) session.turnMeta = turnMeta;
	const checkpoints = loadCheckpoints(row.id);
	if (checkpoints.length > 0) session.checkpoints = checkpoints;
	return session;
}

// ----------------------------------------------------------------------------
// Undo checkpoints — persisted separately from the session row (see the
// session_checkpoints table) so a growing checkpoint list isn't rewritten on
// every saveSession. The in-memory `session.checkpoints` array is the runtime
// source for /undo; these helpers keep the table in lockstep at the four call
// sites that mutate it (turn start push, /undo pop, in TUI and daemon).
// ----------------------------------------------------------------------------

export function appendCheckpoint(sessionId: string, checkpoint: TurnCheckpoint): void {
	getDb()
		.prepare(
			"INSERT INTO session_checkpoints (session_id, seq, json) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM session_checkpoints WHERE session_id = ?), ?)",
		)
		.run(sessionId, sessionId, JSON.stringify(checkpoint));
}

export function dropLastCheckpoint(sessionId: string): void {
	getDb()
		.prepare(
			"DELETE FROM session_checkpoints WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM session_checkpoints WHERE session_id = ?)",
		)
		.run(sessionId, sessionId);
}

/** Persist shadow backups added to the checkpoint while a turn is running. */
export function updateLastCheckpoint(sessionId: string, checkpoint: TurnCheckpoint): void {
	getDb()
		.prepare(
			"UPDATE session_checkpoints SET json = ? WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM session_checkpoints WHERE session_id = ?)",
		)
		.run(JSON.stringify(checkpoint), sessionId, sessionId);
}

export function loadCheckpoints(sessionId: string): TurnCheckpoint[] {
	const rows = getDb()
		.prepare("SELECT json FROM session_checkpoints WHERE session_id = ? ORDER BY seq")
		.all(sessionId) as Array<{ json: string }>;
	return rows.map((r) => JSON.parse(r.json) as TurnCheckpoint);
}

// ----------------------------------------------------------------------------
// Live agent events — execution telemetry (tool_start, turn_end, doom_loop,
// retry, compaction_failed, error, end, …). Append-only, deliberately kept out
// of `messages` so the model never sees execution noise as conversation
// context on the next turn. Persisted for audit/debug (see session_events).
// ----------------------------------------------------------------------------

/** Append one live agent event. Idempotent by (session, seq) — safe to call
 *  on retry paths. `payload` is anything JSON-serializable (often undefined). */
export function appendSessionEvent(sessionId: string, type: string, payload?: unknown): void {
	const db = getDb();
	const insert = (): void => {
		db.prepare(
			"INSERT OR IGNORE INTO session_events (session_id, seq, ts, type, payload_json) VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM session_events WHERE session_id = ?), ?, ?, ?)",
		).run(
			sessionId,
			sessionId,
			new Date().toISOString(),
			type,
			payload === undefined ? null : JSON.stringify(payload),
		);
	};
	if (db.isTransaction) {
		insert();
		return;
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		insert();
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** All recorded live events for a session, oldest first. */
export function getSessionEvents(
	sessionId: string,
): Array<{ seq: number; ts: string; type: string; payload: unknown }> {
	const rows = getDb()
		.prepare("SELECT seq, ts, type, payload_json FROM session_events WHERE session_id = ? ORDER BY seq")
		.all(sessionId) as Array<{ seq: number; ts: string; type: string; payload_json: string | null }>;
	return rows.map((r) => ({
		seq: r.seq,
		ts: r.ts,
		type: r.type,
		payload: r.payload_json ? (JSON.parse(r.payload_json) as unknown) : undefined,
	}));
}

// ----------------------------------------------------------------------------
// Subagent (task tool) transcripts — the child run's full message chain,
// persisted so a subagent's work survives the process that ran it.
// ----------------------------------------------------------------------------

export interface SubagentRunRecord {
	sessionId: string;
	toolCallId: string;
	persona: string | undefined;
	model: string | undefined;
	startedAt: string;
	endReason: string;
	messages: Message[];
}

export function saveSubagentRun(run: SubagentRunRecord): void {
	getDb()
		.prepare(
			`INSERT INTO subagent_runs (session_id, seq, tool_call_id, persona, model, started_at, end_reason, messages_json)
			 VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM subagent_runs WHERE session_id = ?), ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			run.sessionId,
			run.sessionId,
			run.toolCallId,
			run.persona ?? null,
			run.model ?? null,
			run.startedAt,
			run.endReason,
			JSON.stringify(run.messages),
		);
}
export function loadSubagentRuns(sessionId: string): SubagentRunRecord[] {
	const rows = getDb()
		.prepare(
			"SELECT tool_call_id, persona, model, started_at, end_reason, messages_json FROM subagent_runs WHERE session_id = ? ORDER BY seq",
		)
		.all(sessionId) as Array<{
		tool_call_id: string;
		persona: string | null;
		model: string | null;
		started_at: string;
		end_reason: string;
		messages_json: string;
	}>;
	return rows.map((r) => ({
		sessionId,
		toolCallId: r.tool_call_id,
		persona: r.persona ?? undefined,
		model: r.model ?? undefined,
		startedAt: r.started_at,
		endReason: r.end_reason,
		messages: JSON.parse(r.messages_json) as Message[],
	}));
}

/**
 * Vision fallback cleanup: once a model has rejected image_url message parts
 * (400/404), those user messages are useless to it. saveSession only upserts
 * rows present in `session.messages` — it never deletes — so the rejected
 * image messages stayed in_context and re-triggered the 400 on every later
 * turn. Mark them out of context so they stop being sent (the caller has
 * already removed them from the in-memory array for the current request).
 */
export function markImageMessagesOutOfContext(sessionId: string): void {
	getDb()
		.prepare(
			"UPDATE messages SET in_context = 0 WHERE session_id = ? AND in_context = 1 AND content_json LIKE '%image_url%'",
		)
		.run(sessionId);
}

/** Delete a saved session entirely — cascades to its message rows. Returns
 *  false if it wasn't found. */
/**
 * Runs `work` with the per-message FTS delete triggers off, having cleared the
 * session's rows from each index with a single session-scoped delete first.
 *
 * messages_fts and session_history_fts keep session_id/seq as UNINDEXED
 * columns, which FTS5 cannot index — so `DELETE FROM ... WHERE session_id = ?
 * AND seq = ?` scans the whole index, and the AFTER DELETE triggers run that
 * scan once per message. Measured on a real 185MB store, deleting one
 * 2786-message conversation took 241 seconds, holding the write lock the
 * entire time (long enough for every concurrent writer to blow past the 5s
 * busy_timeout). Doing it this way is two scans instead of two per message.
 *
 * Safe only because callers hold a `BEGIN IMMEDIATE` write transaction: no
 * other connection can insert a message while the triggers are missing. The
 * trigger definitions are read back from sqlite_master and replayed verbatim,
 * so this never has to keep its own copy of them in sync with migrations.
 */
function withMessageFtsClearedFor<T>(db: DatabaseSync, sessionIds: readonly string[], work: () => T): T {
	const triggers = db
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('messages_fts_ad', 'session_history_fts_ad')",
		)
		.all() as Array<{ name: string; sql: string }>;
	for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
	try {
		for (const table of ["messages_fts", "session_history_fts"]) {
			try {
				const clear = db.prepare(`DELETE FROM ${table} WHERE session_id = ?`);
				for (const sessionId of sessionIds) clear.run(sessionId);
			} catch {
				// A legacy store can be missing one of the indexes entirely
				// (its creating migration recorded as baselined without the
				// DDL having run); nothing to clear then.
			}
		}
		return work();
	} finally {
		for (const trigger of triggers) db.exec(trigger.sql);
	}
}

export function deleteSession(id: string, cwd?: string): boolean {
	const db = getDb();
	const remove = () =>
		withMessageFtsClearedFor(db, [id], () => db.prepare("DELETE FROM sessions WHERE id = ?").run(id));
	let result: { changes: number | bigint };
	if (db.isTransaction) {
		result = remove();
	} else {
		db.exec("BEGIN IMMEDIATE");
		try {
			result = remove();
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
	// A sandbox session owns its throwaway working copy
	// (~/.cast/sandbox/cast-<id>); remove it with the session so these dirs
	// don't pile up as orphans. Matched exactly (never by prefix), so a
	// project that merely lives under ~/.cast/sandbox is never touched.
	// The caller passes the cwd it captured before the row was deleted.
	if (cwd && cwd === join(homedir(), ".cast", "sandbox", `cast-${id}`)) {
		rmSync(cwd, { recursive: true, force: true });
	}
	return result.changes > 0;
}

export function listSessions(): SessionState[] {
	const db = getDb();
	const rows = db
		.prepare("SELECT id FROM sessions WHERE session_kind = 'conversation' OR session_kind IS NULL")
		.all() as Array<{ id: string }>;
	const sessions: SessionState[] = [];
	for (const { id } of rows) {
		// loadSession parses several JSON columns unguarded, so one row with a
		// malformed usage_json/todos_json throws — and an unguarded loop here
		// meant that single bad row hid EVERY session from the sidebar and the
		// picker. Skip the row it can't read instead: the rest of the list is
		// still correct and usable, and the broken session is one entry missing
		// rather than a blank app.
		try {
			const s = loadSession(id);
			if (s) sessions.push(s);
		} catch (err) {
			console.error(`[cast] skipping unreadable session ${id}:`, err instanceof Error ? err.message : err);
		}
	}
	return sessions;
}

// ----------------------------------------------------------------------------
// Legacy file-store migration — one-time import of pre-SQLite sessions.
// Old `.json`/`.jsonl` files are left untouched on disk as a rollback safety
// net; only sessions whose id isn't already in the DB get imported.
// ----------------------------------------------------------------------------

const SESSIONS_DIR = ".cast/sessions";
const JSONL_EXT = ".jsonl";
const INDEX_FILE_NAME = "index.json";

function legacySessionsRootDir(): string {
	return join(homedir(), SESSIONS_DIR);
}

function legacySessionFilePaths(): string[] {
	const root = legacySessionsRootDir();
	if (!existsSync(root)) return [];
	const paths: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".json")) {
			if (entry.name === INDEX_FILE_NAME) continue;
			paths.push(join(root, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const projectDir = join(root, entry.name);
		for (const f of readdirSync(projectDir).filter((name) => name.endsWith(".json"))) {
			paths.push(join(projectDir, f));
		}
	}
	return paths;
}

function readLegacySessionFile(filePath: string): SessionState | null {
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8")) as SessionState & { messages?: unknown };
		const jsonlPath = filePath.replace(JSON_EXT_RE, JSONL_EXT);
		if (existsSync(jsonlPath)) {
			const text = readFileSync(jsonlPath, "utf-8");
			raw.messages = text
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Message);
		} else if (!Array.isArray(raw.messages)) {
			raw.messages = [];
		}
		raw.usage = withUsageDefault(raw.usage);
		normalizeStoredMessages(raw.messages as Message[]);
		return raw as SessionState;
	} catch {
		return null;
	}
}

/**
 * One-time import of legacy file-store sessions into the SQLite DB. Safe to
 * call on every startup — skips any id already present. Returns the count of
 * newly imported sessions. Source files are never modified or deleted.
 */
export function migrateLegacySessionsToDb(): number {
	const db = getDb();
	const existing = new Set((db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>).map((r) => r.id));
	let migrated = 0;
	for (const filePath of legacySessionFilePaths()) {
		const session = readLegacySessionFile(filePath);
		// A few defenses against files that aren't actually sessions (e.g. stray
		// config or partial exports from an older schema): a missing/non-string id
		// is unrecoverable for the INSERT below, and a single bad file shouldn't
		// abort the whole migration. Skip and move on.
		if (!session || !session.id || typeof session.id !== "string" || existing.has(session.id)) continue;
		try {
			if (!session.title) session.title = deriveSessionTitle(getFirstUserMessage(session));
			db.prepare(
				`INSERT INTO sessions (id, cwd, model, persona, mode, title, pinned, created_at, updated_at, last_prompt_tokens, last_announced_local_date, provider_url, provider_name, session_kind, parent_session_id, background_kind, usage_json, todos_json, share_token, plan_question_json, plan_transition_json, checkpoint_watermark_seq, version)
					 VALUES (:id, :cwd, :model, :persona, :mode, :title, :pinned, :created_at, :updated_at, :last_prompt_tokens, :last_announced_local_date, :provider_url, :provider_name, :session_kind, :parent_session_id, :background_kind, :usage_json, :todos_json, :share_token, :plan_question_json, :plan_transition_json, :checkpoint_watermark_seq, :version)`,
			).run(sessionMetaRow(session));
			const insertRow = db.prepare(
				"INSERT INTO messages (session_id, seq, message_id, role, content_json, in_context, has_tool_calls) VALUES (?, ?, ?, ?, ?, 1, ?)",
			);
			session.messages.forEach((m, seq) => {
				insertRow.run(session.id, seq, randomUUID(), m.role, JSON.stringify(m), isToolCallOnly(m) ? 1 : 0);
			});
		} catch (err) {
			// Skip one malformed file without poisoning the rest. Not logged via
			// console (it would tear the TUI frame) — silent here.
			void err;
			continue;
		}
		existing.add(session.id);
		migrated += 1;
	}
	// Titles became a shared session concern after earlier TUI/run sessions
	// had already been persisted. An explicit clear now stores an empty string,
	// so only NULL represents the legacy state this migration repairs.
	const untitled = db
		.prepare(
			`SELECT s.id, m.content_json
			 FROM sessions s
			 JOIN messages m ON m.session_id = s.id
			 WHERE s.title IS NULL
			   AND m.role = 'user'
			   AND m.seq = (
			     SELECT MIN(first_message.seq)
			     FROM messages first_message
			     WHERE first_message.session_id = s.id AND first_message.role = 'user'
			   )`,
		)
		.all() as Array<{ id: string; content_json: string }>;
	const setTitle = db.prepare("UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL");
	for (const row of untitled) {
		const title = deriveSessionTitle(messageText(JSON.parse(row.content_json) as Message));
		if (title) setTitle.run(title, row.id);
	}
	return migrated;
}

// ============================================================================
// Session summaries — the lightweight view the session picker runs on.
// Direct SQL queries now (no separate mtime-cache index file needed).
// ============================================================================

export interface SessionSummary {
	id: string;
	cwd?: string;
	persona?: string;
	model?: string;
	title?: string;
	pinned?: boolean;
	createdAt?: string;
	updatedAt: string;
	msgCount: number;
	/** First user message text — the list row's description. */
	firstUserMessage: string;
}

/** True for an assistant message that's a pure tool-call step (no visible
 *  reply yet) — one turn can produce several of these before its actual
 *  answer, and they aren't separate exchanges from the user's point of view. */
function isToolCallOnly(m: Message): boolean {
	return "tool_calls" in m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
}

/**
 * Counts conversational turns rather than raw message rows: one for each
 * user message, one for each assistant message that's an actual reply (not
 * a tool-call-only intermediate step). A single turn that takes several
 * tool-call rounds to answer only ever contributes its one final reply here
 * — matches what a user thinks of as "how many messages have we exchanged",
 * not the internal row count (which also includes every tool result and,
 * for full history, every superseded system-prompt/tool-call step).
 */
export function countTurnMessages(messages: Message[]): number {
	let count = 0;
	for (const m of messages) {
		if (m.role === "user") count++;
		else if (m.role === "assistant" && !isToolCallOnly(m)) count++;
	}
	return count;
}

/** Text of a message for indexing: plain string or first text part. */
function messageText(m: { content?: unknown }): string {
	const content = m.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const part = content.find((p: { type?: string }) => p.type === "text") as { text?: string } | undefined;
		return part?.text ?? "";
	}
	return "";
}

/** First user message, newline-flattened — the picker row's description. */
export function getFirstUserMessage(subject: { messages: Message[] }): string {
	const msg = subject.messages.find((m) => m.role === "user");
	return msg ? messageText(msg).replace(NEWLINE_RE_G, " ").trim() : "";
}
/** Shared row → summary mapping for both listSessionSummaries and
 *  searchSessionSummaries. msgCount and firstUserMessage used to be derived
 *  in JS for each session by SELECT-ing every user/assistant row and
 *  JSON.parsing the whole conversation — 218 sessions × up-to-thousands of
 *  rows each, allocating tens of MB and parsing 9000+ JSONs just to compute
 *  two scalar fields. Now aggregated in SQL via covering indexes
 *  (idx_messages_role for user/assistant counts, MIN(seq) index lookup for
 *  the first user message) — two queries per call regardless of history
 *  depth. perf: 218-session DB drops from ~424 ms TTFB to well under 50 ms. */
function buildSummaries(db: DatabaseSync, rows: SessionRow[]): SessionSummary[] {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => r.id);
	const placeholders = ids.map(() => "?").join(",");
	// (user_count, assistant_count) per session — both covered by
	// idx_messages_role (session_id, role, seq). The non-tool-call-only slice
	// is computed in JS below by subtracting the indexed tool-call count.
	const userCountById = new Map<string, number>();
	const asstCountById = new Map<string, number>();
	const userCountStmt = db.prepare(
		`SELECT session_id, COUNT(*) AS c FROM messages
		 WHERE session_id IN (${placeholders}) AND role = 'user'
		 GROUP BY session_id`,
	);
	for (const r of userCountStmt.all(...ids) as Array<{ session_id: string; c: number }>) {
		userCountById.set(r.session_id, r.c);
	}
	const asstCountStmt = db.prepare(
		`SELECT session_id, COUNT(*) AS c FROM messages
		 WHERE session_id IN (${placeholders}) AND role = 'assistant'
		 GROUP BY session_id`,
	);
	for (const r of asstCountStmt.all(...ids) as Array<{ session_id: string; c: number }>) {
		asstCountById.set(r.session_id, r.c);
	}
	// Assistant messages whose content_json.tool_calls is a non-empty array
	// — maintained as a denormalized flag and served by a partial index, so
	// listing never parses message JSON. Subtracting from asstCountById gives
	// the same "exclude intermediate tool-call-only" semantics as
	// countTurnMessages.
	const asstWithToolById = new Map<string, number>();
	const asstWithToolStmt = db.prepare(
		`SELECT session_id, COUNT(*) AS c FROM messages
		 WHERE session_id IN (${placeholders}) AND role = 'assistant'
		   AND has_tool_calls = 1
		 GROUP BY session_id`,
	);
	for (const r of asstWithToolStmt.all(...ids) as Array<{ session_id: string; c: number }>) {
		asstWithToolById.set(r.session_id, r.c);
	}
	// First user message text per session — picked by MIN(seq) (covering
	// index) then a single PK lookup for the content_json. Still O(N)
	// queries, but each is one index read instead of a full history scan.
	const firstUserById = new Map<string, string>();
	const firstUserStmt = db.prepare(
		`SELECT m.session_id, m.content_json FROM messages m
		 JOIN (
		   SELECT session_id, MIN(seq) AS min_seq FROM messages
		   WHERE session_id IN (${placeholders}) AND role = 'user'
		   GROUP BY session_id
		 ) f ON f.session_id = m.session_id AND f.min_seq = m.seq`,
	);
	for (const r of firstUserStmt.all(...ids) as Array<{ session_id: string; content_json: string }>) {
		try {
			const msg = JSON.parse(r.content_json) as Message;
			firstUserById.set(r.session_id, firstUserTextFromMessage(msg));
		} catch {
			// Skip a malformed row rather than crashing the whole list.
		}
	}
	return rows.map((row) => {
		const userCount = userCountById.get(row.id) ?? 0;
		const asstCount = asstCountById.get(row.id) ?? 0;
		const asstWithTool = asstWithToolById.get(row.id) ?? 0;
		return {
			id: row.id,
			...(row.cwd ? { cwd: row.cwd } : {}),
			...(row.persona ? { persona: row.persona } : {}),
			...(row.model ? { model: row.model } : {}),
			...(row.title ? { title: row.title } : {}),
			...(row.pinned === 1 ? { pinned: true } : {}),
			...(row.created_at ? { createdAt: row.created_at } : {}),
			updatedAt: row.updated_at,
			msgCount: userCount + (asstCount - asstWithTool),
			firstUserMessage: firstUserById.get(row.id) ?? "",
		};
	});
}

/** Same shaping as getFirstUserMessage but operates on a single parsed
 *  message — extracted so the new SQL-driven path keeps the same
 *  newline-flatten / trim behavior the picker row's description has had
 *  since the JS-loader era. */
function firstUserTextFromMessage(msg: Message): string {
	return messageText(msg).replace(NEWLINE_RE_G, " ").trim();
}

/** Every session's summary, built from full history (not just the
 *  in-context working set) so a compacted session's picker row still
 *  reflects everything that was ever said in it. */
export function listSessionSummaries(): SessionSummary[] {
	const db = getDb();
	const rows = db
		.prepare(
			"SELECT * FROM sessions WHERE session_kind = 'conversation' OR session_kind IS NULL ORDER BY updated_at DESC",
		)
		.all() as unknown as SessionRow[];
	return buildSummaries(db, rows);
}

/** Turns one word into a safe FTS5 MATCH term: quoted (neutralizes MATCH's
 *  own syntax characters — AND/OR/NOT, "-", "*", ":", ... — so a token
 *  containing them is searched literally instead of parsed as a query
 *  operator) and given a trailing "*" for prefix matching, so a still-being-
 *  typed word ("auth") reaches its finished form ("authentication"). */
function toFtsTerm(token: string): string {
	return `"${token.replace(DOUBLE_QUOTE_RE, '""')}"*`;
}

/**
 * Sessions matching `query`, ranked by relevance — replaces the old approach
 * of shipping every session's full message text to the caller (TUI picker or
 * web sidebar) to score in JS. Two match sources, merged:
 *  - message content, via the messages_fts index (bm25-ranked; lower is
 *    better in SQLite's convention, so ranks compare with plain `<`);
 *  - session metadata (cwd/id/title/persona/model), via LIKE — cheap (one
 *    short row per session, no message text involved) and always outranks a
 *    pure content hit, the same way the old score() made a substring match
 *    on the visible label beat a fuzzy match buried in the body.
 * Empty query returns the unranked full list, same as listSessionSummaries.
 */
export function searchSessionSummaries(query: string): SessionSummary[] {
	const q = query.trim();
	if (!q) return listSessionSummaries();
	const db = getDb();

	const tokens = q.split(WHITESPACE_RE).filter(Boolean);
	// messages_fts has one row per message, not one per session — a combined
	// multi-word MATCH (`"a"* "b"*`) requires every word in the SAME message
	// row, so "привет" and "настроение" typed in different turns of one
	// conversation would never match together even though the session
	// obviously contains both. Querying each word separately and intersecting
	// the matching session_id sets in JS finds a session where the words are
	// scattered across different messages, same as the old single-haystack
	// JS scorer did before this index existed.
	const contentStmt = db.prepare(
		"SELECT session_id, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ?",
	);
	let matchedSessionIds: Set<string> | null = null;
	const bestRankById = new Map<string, number>();
	for (const token of tokens) {
		const rows = contentStmt.all(toFtsTerm(token)) as Array<{ session_id: string; rank: number }>;
		const idsForToken = new Set<string>();
		for (const row of rows) {
			idsForToken.add(row.session_id);
			bestRankById.set(row.session_id, Math.min(bestRankById.get(row.session_id) ?? 0, row.rank));
		}
		if (matchedSessionIds === null) {
			matchedSessionIds = idsForToken;
		} else {
			const next = new Set<string>();
			for (const id of matchedSessionIds) if (idsForToken.has(id)) next.add(id);
			matchedSessionIds = next;
		}
		if (matchedSessionIds.size === 0) break;
	}

	// Escape LIKE's own wildcards so a literal "%" or "_" in the typed query
	// matches itself instead of acting as a pattern character.
	const like = `%${q.replace(SQL_LIKE_SPECIAL_RE, "\\$&")}%`;
	const metaMatches = db
		.prepare(
			"SELECT id FROM sessions WHERE (session_kind = 'conversation' OR session_kind IS NULL) AND (cwd LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR persona LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\')",
		)
		.all(like, like, like, like, like) as Array<{ id: string }>;

	const rankById = new Map<string, number>();
	for (const id of matchedSessionIds ?? []) rankById.set(id, bestRankById.get(id) ?? 0);
	const METADATA_RANK = -1000; // more negative than any real bm25 score → always sorts first
	for (const m of metaMatches) rankById.set(m.id, Math.min(rankById.get(m.id) ?? 0, METADATA_RANK));
	if (rankById.size === 0) return [];

	const ids = [...rankById.keys()];
	const placeholders = ids.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT * FROM sessions WHERE id IN (${placeholders}) AND (session_kind = 'conversation' OR session_kind IS NULL)`,
		)
		.all(...ids) as unknown as SessionRow[];
	const summaries = buildSummaries(db, rows);
	summaries.sort((a, b) => (rankById.get(a.id) ?? 0) - (rankById.get(b.id) ?? 0));
	return summaries;
}

/**
 * Most recently updated session, or null if none are saved yet.
 *
 * When `cwd` is provided, the lookup is scoped to that directory — `cast -c`
 * uses this to make "continue" mean "the most recent session in *this*
 * project", not "the most recent session in any project on this machine".
 * `session.cwd` is stored as an absolute path (see `createSession`), so
 * the caller must pass the same absolute form they used at start time;
 * raw `process.cwd()` is fine because `startup.ts` resolves it. Passing
 * `cwd = undefined` keeps the legacy global behavior for callers that
 * explicitly want it (the `/sessions` picker, for one).
 */
export function getMostRecentSession(cwd?: string): SessionState | null {
	const db = getDb();
	const sql = cwd
		? "SELECT id FROM sessions WHERE cwd = ? AND (session_kind = 'conversation' OR session_kind IS NULL) ORDER BY updated_at DESC LIMIT 1"
		: "SELECT id FROM sessions WHERE session_kind = 'conversation' OR session_kind IS NULL ORDER BY updated_at DESC LIMIT 1";
	const stmt = db.prepare(sql);
	const row = (cwd ? stmt.get(cwd) : stmt.get()) as { id: string } | undefined;
	return row ? loadSession(row.id) : null;
}

function generateSessionId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export interface SessionCreationOptions {
	id?: string;
	title?: string;
	sessionKind?: "conversation" | "background";
	parentSessionId?: string;
	backgroundKind?: "memory-dream" | "memory-distill" | "checkpoint-writer";
}

export function createSession(model: string, cwd: string, options: SessionCreationOptions = {}): SessionState {
	const now = new Date().toISOString();
	const db = getDb();
	// The timestamp+random scheme is astronomically unlikely to collide, but
	// "unlikely" isn't "impossible" and saveSession() would silently merge
	// into an existing session's row with no warning. Regenerating on a hit
	// is nearly free — this loop virtually never runs more than once.
	let id = options.id ?? generateSessionId();
	while (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) {
		if (options.id) throw new Error(`Session ${options.id} already exists`);
		id = generateSessionId();
	}
	return {
		id,
		messages: [],
		model,
		createdAt: now,
		updatedAt: now,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
			subagentTokens: 0,
		},
		cwd: resolve(cwd),
		lastAnnouncedLocalDate: formatLocalDate(),
		title: options.title,
		sessionKind: options.sessionKind ?? "conversation",
		parentSessionId: options.parentSessionId,
		backgroundKind: options.backgroundKind,
	};
}

/** How long a background session's rows are kept.
 *
 * Background sessions are cast's own working snapshots — checkpoint writers,
 * memory dream/distill runs — not user history. They never appear in the
 * sidebar or the picker (listSessions filters them out) and nothing reads
 * them back once the run that created them is done. Nothing deleted them
 * either, so they grew forever: on one real installation 376 of 999 session
 * rows, and 23% of the database's content, were invisible background rows.
 * Same window as telemetry retention. */
const BACKGROUND_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** How many expired background sessions one sweep removes. Capped so the write
 * transaction stays well inside the 5s busy_timeout other connections wait on
 * — a first sweep on a long-neglected store would otherwise hold the lock for
 * a dozen seconds. The backlog clears over the next few daemon starts. */
const BACKGROUND_PRUNE_BATCH = 25;

/** Retention for recorded session events — the same window telemetry uses. */
const SESSION_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes background sessions untouched for longer than the retention window,
 * returning how many rows went. Messages and events go with them through the
 * schema's ON DELETE CASCADE, same as an ordinary deleteSession.
 *
 * Only ever touches `session_kind = 'background'` — a user's own
 * conversations, however old, are never pruned.
 */
export function pruneBackgroundSessions(now: number = Date.now(), limit = BACKGROUND_PRUNE_BATCH): number {
	const db = getDb();
	const cutoff = new Date(now - BACKGROUND_SESSION_RETENTION_MS).toISOString();
	const prune = () => {
		// Must go through the same FTS-clearing path as deleteSession: a plain
		// DELETE here falls back to the per-message AFTER DELETE triggers and
		// takes minutes on a large store, holding the write lock — which, at
		// daemon startup, meant the daemon never finished starting.
		const ids = (
			db
				.prepare("SELECT id FROM sessions WHERE session_kind = 'background' AND updated_at < ? LIMIT ?")
				.all(cutoff, limit) as Array<{ id: string }>
		).map((row) => row.id);
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(", ");
		return withMessageFtsClearedFor(
			db,
			ids,
			() => db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids).changes,
		);
	};
	if (db.isTransaction) return Number(prune());
	db.exec("BEGIN IMMEDIATE");
	try {
		const removed = Number(prune());
		db.exec("COMMIT");
		return removed;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** How far back the client-message-id dedup check looks. A resent submit only
 * ever races the last few messages — a client reconnecting and replaying the
 * one submit it wasn't sure had landed — so the tail is the whole of what
 * needs checking. */
const CLIENT_MESSAGE_ID_WINDOW = 50;

/**
 * Whether a recent message in this session already carries `clientMessageId`
 * — the daemon's idempotency check for a resent submit.
 *
 * Answered by SQL over the tail of the session rather than by loading the
 * transcript: this used to run `getFullHistory()` and JSON.parse every row of
 * the session to test one field, which measured 117-162ms on a 4465-message
 * session, grows linearly with history, and ran on every single message the
 * web UI sends (it always sends an id).
 */
export function hasRecentClientMessageId(
	sessionId: string,
	clientMessageId: string,
	window: number = CLIENT_MESSAGE_ID_WINDOW,
): boolean {
	const db = getDb();
	const row = db
		.prepare(
			`SELECT 1 AS hit FROM (
				SELECT content_json FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?
			) WHERE json_extract(content_json, '$.castClientMessageId') = ? LIMIT 1`,
		)
		.get(sessionId, window, clientMessageId);
	return row !== undefined;
}

/**
 * Deletes recorded session events older than the retention window, returning
 * how many rows went.
 *
 * `session_events` is execution telemetry — tool_start/tool_end/turn_end and
 * friends, reachable only through the events/history endpoint and never part
 * of the conversation. It had no delete path at all beyond the cascade when a
 * session is removed, so it grew about two rows per tool call forever: 8377
 * rows and 60MB of payloads on one real store. Same 7-day window the rest of
 * the telemetry uses.
 */
export function pruneSessionEvents(now: number = Date.now(), retentionMs: number = SESSION_EVENT_RETENTION_MS): number {
	const db = getDb();
	const cutoff = new Date(now - retentionMs).toISOString();
	const prune = () => Number(db.prepare("DELETE FROM session_events WHERE ts < ?").run(cutoff).changes);
	if (db.isTransaction) return prune();
	db.exec("BEGIN IMMEDIATE");
	try {
		const removed = prune();
		db.exec("COMMIT");
		return removed;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

export function listBackgroundSessions(parentSessionId?: string): SessionState[] {
	const db = getDb();
	const rows = parentSessionId
		? (db
				.prepare(
					"SELECT id FROM sessions WHERE session_kind = 'background' AND parent_session_id = ? ORDER BY updated_at DESC",
				)
				.all(parentSessionId) as Array<{ id: string }>)
		: (db
				.prepare("SELECT id FROM sessions WHERE session_kind = 'background' ORDER BY updated_at DESC")
				.all() as Array<{ id: string }>);
	return rows.map(({ id }) => loadSession(id)).filter((session): session is SessionState => session !== null);
}

/**
 * Creates an independent branch from the context currently active in a
 * session. Historical rows omitted by compaction intentionally stay omitted:
 * restoring only part of an old tool turn can produce an invalid provider
 * transcript, while the active context is already the safe continuation.
 */
export function forkSession(source: SessionState): SessionState {
	const fork = createSession(source.model, source.cwd ?? process.cwd());
	fork.messages = JSON.parse(JSON.stringify(source.messages)) as Message[];
	fork.persona = source.persona;
	fork.mode = source.mode;
	fork.providerUrl = source.providerUrl;
	fork.providerName = source.providerName;
	fork.lastAnnouncedLocalDate = source.lastAnnouncedLocalDate;
	fork.reasoning = source.reasoning
		? (JSON.parse(JSON.stringify(source.reasoning)) as Record<number, string>)
		: undefined;
	fork.turnMeta = source.turnMeta
		? (JSON.parse(JSON.stringify(source.turnMeta)) as Record<number, TurnMeta>)
		: undefined;
	fork.todos = source.todos ? (JSON.parse(JSON.stringify(source.todos)) as TodoItem[]) : undefined;
	fork.title = source.title ? `${source.title} (fork)` : undefined;
	saveSession(fork);
	return fork;
}

export function appendMessage(session: SessionState, message: Message): void {
	if (!session.title && message.role === "user" && !session.messages.some((existing) => existing.role === "user")) {
		const title = deriveSessionTitle(messageText(message));
		if (title) session.title = title;
	}
	session.messages.push(message);
}
