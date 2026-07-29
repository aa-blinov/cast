import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig } from "./config.ts";
import { formatLocalDate } from "./date-rollover-reminder.ts";
import { getDb } from "./db.ts";
import type { Message, Usage } from "./llm.ts";
import type { TodoItem } from "./todo.ts";

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
	/** Cumulative token/cost usage across every turn in this session. */
	usage: SessionUsage;
	/** promptTokens from the most recent API response — the authoritative
	 * measure of current context size. undefined before the first call or
	 * when a session is loaded from disk with no prior API data. */
	lastPromptTokens?: number;
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
}

/** Fold one turn's usage into the session's running totals. When `opts.subagent`
 * is set, the tokens are also accumulated into `subagentTokens` (still part of the
 * grand total) and the context-size tracker is left untouched — a subagent's
 * prompt size says nothing about the main session's context. */
const safe = (v: number | undefined) => Math.max(0, v ?? 0);

export function addUsage(session: SessionState, usage: Usage, opts?: { subagent?: boolean }): void {
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
	const readMatch = text.match(/<read-files>\n([\s\S]*?)\n<\/read-files>/);
	const modifiedMatch = text.match(/<modified-files>\n([\s\S]*?)\n<\/modified-files>/);
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

	// Split: 60% old, 40% recent, snapped back to a safe boundary (see
	// safeCutIndex) so "recent" never opens on an orphaned tool result.
	const { personaMessages: system, previousSummary } = extractPreviousCompaction(
		messages.filter((m) => m.role === "system"),
	);
	const nonSystem = messages.filter((m) => m.role !== "system");
	const splitIdx = safeCutIndex(nonSystem, Math.floor(nonSystem.length * 0.6));
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

	const summary = (await summarizeFn(oldText, previousSummary)) + formatFileOps(readFiles, modifiedFiles);

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
		last_announced_local_date: session.lastAnnouncedLocalDate ?? null,
		provider_url: session.providerUrl ?? null,
		usage_json: JSON.stringify(session.usage),
		todos_json: session.todos ? JSON.stringify(session.todos) : null,
		share_token: session.shareToken ?? null,
	};
}

export function saveSession(session: SessionState): void {
	session.updatedAt = new Date().toISOString();
	const db = getDb();
	const meta = sessionMetaRow(session);
	db.prepare(
		`INSERT INTO sessions (id, cwd, model, persona, mode, title, pinned, created_at, updated_at, last_prompt_tokens, last_announced_local_date, provider_url, usage_json, todos_json, share_token)
		 VALUES (:id, :cwd, :model, :persona, :mode, :title, :pinned, :created_at, :updated_at, :last_prompt_tokens, :last_announced_local_date, :provider_url, :usage_json, :todos_json, :share_token)
		 ON CONFLICT(id) DO UPDATE SET
		   cwd = excluded.cwd, model = excluded.model, persona = excluded.persona, mode = excluded.mode,
		   title = excluded.title, pinned = excluded.pinned, updated_at = excluded.updated_at,
		   last_prompt_tokens = excluded.last_prompt_tokens, last_announced_local_date = excluded.last_announced_local_date,
		   provider_url = excluded.provider_url, usage_json = excluded.usage_json, todos_json = excluded.todos_json,
		   share_token = excluded.share_token`,
	).run(meta);

	const insertRow = db.prepare(
		"INSERT INTO messages (session_id, seq, role, content_json, in_context, reasoning, turn_meta) VALUES (?, ?, ?, ?, 1, ?, ?)",
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
				messageSeq.set(m, current.seq);
				return;
			}
			deactivateOldSystemRows.run(session.id, `%${COMPACTION_MARKER_PREFIX}%`);
		}
		insertRow.run(session.id, seq, m.role, JSON.stringify(m), reasoning, turnMetaJson);
		messageSeq.set(m, seq);
		seq++;
	});
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
export function recordCompaction(
	session: SessionState,
	fullHistoryBeforeCompaction: Message[],
	compacted: Message[],
): void {
	const db = getDb();
	const kept = new Set(compacted);
	const insertRow = db.prepare(
		"INSERT INTO messages (session_id, seq, role, content_json, in_context) VALUES (?, ?, ?, ?, ?)",
	);
	const flipOut = db.prepare("UPDATE messages SET in_context = 0 WHERE session_id = ? AND seq = ?");

	let seq = nextSeqFor(session.id);
	for (const m of fullHistoryBeforeCompaction) {
		const existing = messageSeq.get(m);
		if (existing !== undefined) {
			if (!kept.has(m)) flipOut.run(session.id, existing);
			continue;
		}
		insertRow.run(session.id, seq, m.role, JSON.stringify(m), kept.has(m) ? 1 : 0);
		messageSeq.set(m, seq);
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
			for (const m of compacted) {
				if (m === marker) continue;
				const s = messageSeq.get(m);
				if (s !== undefined && s >= insertAt) messageSeq.set(m, s + 1);
			}
		}
		insertRow.run(session.id, insertAt, marker.role, JSON.stringify(marker), 1);
		messageSeq.set(marker, insertAt);
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
	const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
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
	getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);
	session.messages = [];
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
	last_announced_local_date: string | null;
	provider_url: string | null;
	usage_json: string;
	todos_json: string | null;
	share_token: string | null;
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
		lastAnnouncedLocalDate: row.last_announced_local_date ?? undefined,
		providerUrl: row.provider_url ?? undefined,
		usage: withUsageDefault(JSON.parse(row.usage_json)),
		todos: row.todos_json ? JSON.parse(row.todos_json) : undefined,
		shareToken: row.share_token ?? undefined,
	};
}

/** Loads the in-context working set (`in_context = 1`) into
 *  `SessionState.messages`, seeding messageSeq for every row read so a
 *  later saveSession/recordCompaction on this object recognizes them as
 *  already-persisted. */
export function loadSession(id: string): SessionState | null {
	return loadSessionByRow(getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined);
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
	return session;
}

/** Delete a saved session entirely — cascades to its message rows. Returns
 *  false if it wasn't found. */
export function deleteSession(id: string): boolean {
	const result = getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
	return result.changes > 0;
}

export function listSessions(): SessionState[] {
	const db = getDb();
	const rows = db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
	const sessions: SessionState[] = [];
	for (const { id } of rows) {
		const s = loadSession(id);
		if (s) sessions.push(s);
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
		const jsonlPath = filePath.replace(/\.json$/, JSONL_EXT);
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
		if (!session || existing.has(session.id)) continue;
		db.prepare(
			`INSERT INTO sessions (id, cwd, model, persona, mode, title, pinned, created_at, updated_at, last_prompt_tokens, last_announced_local_date, provider_url, usage_json, todos_json, share_token)
			 VALUES (:id, :cwd, :model, :persona, :mode, :title, :pinned, :created_at, :updated_at, :last_prompt_tokens, :last_announced_local_date, :provider_url, :usage_json, :todos_json, :share_token)`,
		).run(sessionMetaRow(session));
		const insertRow = db.prepare(
			"INSERT INTO messages (session_id, seq, role, content_json, in_context) VALUES (?, ?, ?, ?, 1)",
		);
		session.messages.forEach((m, seq) => {
			insertRow.run(session.id, seq, m.role, JSON.stringify(m));
		});
		existing.add(session.id);
		migrated++;
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
	return msg ? messageText(msg).replace(/\n/g, " ").trim() : "";
}

/** Shared row → summary mapping for both listSessionSummaries and
 *  searchSessionSummaries — msgCount/firstUserMessage only ever look at
 *  user/assistant text (see getFirstUserMessage), so filtering role at the
 *  SQL level, not after loading, matters a lot in practice: tool-result rows
 *  (file reads, grep output, ...) are typically the overwhelming majority of
 *  a session's stored bytes. */
function buildSummaries(db: ReturnType<typeof getDb>, rows: SessionRow[]): SessionSummary[] {
	const conversationOnly = db.prepare(
		"SELECT content_json FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY seq",
	);
	return rows.map((row) => {
		const messages = (conversationOnly.all(row.id) as Array<{ content_json: string }>).map(
			(r) => JSON.parse(r.content_json) as Message,
		);
		const subject = { messages };
		return {
			id: row.id,
			...(row.cwd ? { cwd: row.cwd } : {}),
			...(row.persona ? { persona: row.persona } : {}),
			...(row.model ? { model: row.model } : {}),
			...(row.title ? { title: row.title } : {}),
			...(row.pinned === 1 ? { pinned: true } : {}),
			...(row.created_at ? { createdAt: row.created_at } : {}),
			updatedAt: row.updated_at,
			msgCount: countTurnMessages(messages),
			firstUserMessage: getFirstUserMessage(subject),
		};
	});
}

/** Every session's summary, built from full history (not just the
 *  in-context working set) so a compacted session's picker row still
 *  reflects everything that was ever said in it. */
export function listSessionSummaries(): SessionSummary[] {
	const db = getDb();
	const rows = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as unknown as SessionRow[];
	return buildSummaries(db, rows);
}

/** Turns one word into a safe FTS5 MATCH term: quoted (neutralizes MATCH's
 *  own syntax characters — AND/OR/NOT, "-", "*", ":", ... — so a token
 *  containing them is searched literally instead of parsed as a query
 *  operator) and given a trailing "*" for prefix matching, so a still-being-
 *  typed word ("auth") reaches its finished form ("authentication"). */
function toFtsTerm(token: string): string {
	return `"${token.replace(/"/g, '""')}"*`;
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

	const tokens = q.split(/\s+/).filter(Boolean);
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
	const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
	const metaMatches = db
		.prepare(
			"SELECT id FROM sessions WHERE cwd LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR persona LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\'",
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
		.prepare(`SELECT * FROM sessions WHERE id IN (${placeholders})`)
		.all(...ids) as unknown as SessionRow[];
	const summaries = buildSummaries(db, rows);
	summaries.sort((a, b) => (rankById.get(a.id) ?? 0) - (rankById.get(b.id) ?? 0));
	return summaries;
}

/** Most recently updated session, or null if none are saved yet. */
export function getMostRecentSession(): SessionState | null {
	const db = getDb();
	const row = db.prepare("SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1").get() as
		| { id: string }
		| undefined;
	return row ? loadSession(row.id) : null;
}

function generateSessionId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function createSession(model: string, cwd: string): SessionState {
	const now = new Date().toISOString();
	const db = getDb();
	// The timestamp+random scheme is astronomically unlikely to collide, but
	// "unlikely" isn't "impossible" and saveSession() would silently merge
	// into an existing session's row with no warning. Regenerating on a hit
	// is nearly free — this loop virtually never runs more than once.
	let id = generateSessionId();
	while (db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id)) {
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
	};
}

export function appendMessage(session: SessionState, message: Message): void {
	session.messages.push(message);
}
