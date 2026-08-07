import { useCallback, useEffect, useRef, useState } from "react";
// Node 22 has no global EventSource; undici ships one (experimental) that we
// use to receive the daemon's SSE stream. The browser build (esbuild bundle)
// provides a real global EventSource, so this import is Node-only and safe in
// both runtimes.
import { EventSource } from "undici";
import { createCheckpoint } from "../core/checkpoint.ts";
import type { AppConfig } from "../core/config.ts";
import { resolveProvider } from "../core/config.ts";
import { initialAnnouncedLocalDate } from "../core/date-rollover-reminder.ts";
import { hasHooks, runHooksForEvent } from "../core/hooks.ts";
import { describeTurnError, isRetryableStreamError, stripHermesToolCalls } from "../core/llm.ts";
import { type AgentEvent, runAgentLoop } from "../core/loop.ts";
import { formatMcpForPrompt, type McpSetupResult } from "../core/mcp.ts";
import { type PlanQuestion, readActivePlan } from "../core/plan.ts";
import { resolveHooksForCwd } from "../core/project.ts";
import type { AgentRunner } from "../core/runner.ts";
import {
	addUsage,
	appendMessage,
	clearSessionMessages,
	getFullHistory,
	recordCompaction,
	resetSessionContext,
	type SessionState,
	type SessionUsage,
	saveSession,
} from "../core/session.ts";
import { loadSettings, type PermissionMode, updateSettings } from "../core/settings.ts";
import { setLastTurnAborted, setStreamingActive } from "../core/stdin-manager.ts";
import type { BackgroundTaskRegistry, BashBackgroundDeps } from "../core/tools/bash-background.ts";
import { completedToolCallStatus, type ToolCallStatus } from "../core/tools/shared.ts";
import {
	appendTextBlock,
	reduceStreamEvent,
	type StreamBlock,
	type StreamingState,
} from "../web/public/stream-blocks.js";
import { displayWidthCacheFlush } from "./display-width.ts";

export type AgentStatus = "idle" | "running" | "error";

export interface ToolCallEntry {
	id: string;
	name: string;
	args: string;
	status: ToolCallStatus;
	result?: string;
}

/**
 * One ordered block within a single assistant completion. The model streams
 * reasoning, text, and tool calls in some order; a completion can even go
 * text → tool → more text. Keeping them as an ordered list — instead of three
 * fixed lanes (all reasoning, then all text, then all tools) — is what lets
 * the transcript render in the true emission order. Adjacent same-kind chunks
 * (token-by-token text, streamed reasoning) coalesce into one block; a tool
 * call breaks the run so whatever streams after it starts a fresh block.
 */
export type { StreamBlock, StreamingState } from "../web/public/stream-blocks.js";

export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool" | "warning";
	/** Plain text for user/warning/system/tool rows. Assistant rows use `blocks`. */
	content: string;
	/**
	 * Assistant turn rendered as ordered reasoning/text/tool blocks. Carries the
	 * turn's reasoning too, so it stays visible in history instead of vanishing
	 * when the turn ends. Reasoning is not persisted to session.messages, so a
	 * rebuild/resume reconstructs only content + tool blocks (no reasoning, and
	 * no finer interleaving than "text then tools" — the wire format doesn't
	 * record it).
	 */
	blocks?: StreamBlock[];
}

export interface PendingImage {
	id: string;
	dataUrl: string;
}

/** Exported for unit tests. */
export const appendText = appendTextBlock;

/**
 * Splits off already-complete answer lines, leaving only the still-growing
 * partial last line behind. A reasoning run stays intact until a real boundary
 * (content/tool): splitting its paragraphs into static rows makes the TUI
 * repeat its label despite one continuous provider reasoning stream.
 */
/** Exported for unit tests. */
export function splitCompleteLines(block: StreamBlock): { settled: StreamBlock[]; tail: StreamBlock } {
	if (block.kind !== "content") return { settled: [], tail: block };
	const idx = block.text.lastIndexOf("\n");
	if (idx === -1) return { settled: [], tail: block };
	return {
		settled: [{ kind: block.kind, text: block.text.slice(0, idx), continued: block.continued }],
		tail: { kind: block.kind, text: block.text.slice(idx + 1), continued: true },
	};
}

/**
 * How many leading blocks have settled — can't change again, so they're safe to
 * hand to Ink's <Static> (which freezes an item on first render). Streaming only
 * ever grows the trailing block, so any non-trailing text/reasoning block is
 * done; a tool block is done once it's no longer running. Draining these out of
 * the live region as they settle is what keeps that region from growing past the
 * terminal height — where Ink's log-update erase math breaks and frames stack.
 */
export function settledPrefixLength(blocks: StreamBlock[]): number {
	let n = 0;
	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i]!;
		const isLast = i === blocks.length - 1;
		const settled = b.kind === "tool" ? b.call.status !== "running" : !isLast;
		if (!settled) break;
		n++;
	}
	return n;
}

export interface RetryInfo {
	attempt: number;
	reason: string;
}

/**
 * Extract a PlanQuestion from the `question` tool's tool_end result content —
 * the schema execQuestion JSON-stringifies into its result (`{question: true,
 * questions: [...]}`). Returns undefined for anything malformed, in which case
 * the run just continues. Exported for unit tests.
 */
export function parseQuestionToolResult(content: string): PlanQuestion | undefined {
	try {
		const parsed = JSON.parse(content) as { questions?: PlanQuestion["questions"] };
		if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
			return { questions: parsed.questions };
		}
	} catch {
		// malformed JSON — not a question payload
	}
	return undefined;
}

export interface UseAgentSession {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	status: AgentStatus;
	error: string | null;
	retry: RetryInfo | null;
	/** Cumulative totals across every turn in the session, not just the last one. */
	usage: SessionUsage | null;
	/** Usage for the most recently completed turn (cleared at the start of each new turn). */
	lastTurnUsage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		uncachedTokens?: number;
		/** Output tokens/sec for this turn — undefined if nothing ever streamed. */
		tokensPerSecond?: number;
	} | null;
	/**
	 * Steer/follow-up messages queued but not yet injected into the running
	 * turn — stays populated for as long as the message is actually pending
	 * (until the loop drains it, or /abort clears it), not on a timer. A
	 * message can sit here for a while: the loop only re-checks its queues at
	 * a turn boundary, which for a long tool-heavy turn can be much later than
	 * a fixed toast timeout would show it for.
	 */
	pendingSteers: string[];
	pendingQueue: string[];
	submit: (text: string, images?: PendingImage[]) => Promise<void>;
	steer: (text: string) => void;
	followUp: (text: string) => void;
	abort: () => void;
	clearContext: () => void;
	resetContext: () => string | undefined;
	/** Re-reads the on-disk session messages into the in-memory list. */
	refresh: () => void;
	refreshMeta: () => void;
	resetQueue: () => void;
	addDisplayMessage: (message: ChatMessage) => void;
	/**
	 * Pending question from the daemon (thin-client mode). The daemon owns
	 * planState in that mode, so the TUI can't read the question locally the
	 * way the local-loop path does — the schema arrives on the SSE tool_end
	 * event and is stashed here for the App's question picker.
	 */
	pendingQuestion: PlanQuestion | undefined;
	/** Submit answers to the daemon's pending question (thin-client mode). */
	answerQuestion: (values: string[]) => void;
	/** Resolve the daemon's pending plan approval (thin-client mode). */
	approvePlan: () => void;
	/** Reset the daemon session's context for "implement in clean context"
	 * (thin-client mode) — resolves with the original task, if the daemon kept
	 * one, for the reminder prompt. */
	cleanDaemonContext: () => Promise<string | undefined>;
	/**
	 * Whether to render reasoning blocks in the chat. Off by default — the
	 * user can /reasoning-display to toggle for the current session. For
	 * non-reasoning models the toggle is a no-op since no thinking blocks
	 * ever arrive to filter.
	 */
	showReasoning: boolean;
	/** Flip the showReasoning flag and return the new value so callers can
	 * render an accurate notice without chasing the next React batch. */
	toggleReasoning: () => boolean;
	/** Timestamp the current turn started, or null when idle. Changes only at
	 * start/stop — consumers that need a live-ticking display (the status
	 * bar) should tick locally off this instead of re-rendering on it. */
	turnStartedAt: number | null;
	/** Synchronous read of ms elapsed in the current (or last completed)
	 * turn — for one-off snapshots like /current, not for live display. */
	getElapsedMs: () => number;
}

interface UseAgentSessionParams {
	session: SessionState;
	config: AppConfig;
	cwd: string;
	systemPrompt: string;
	runner: AgentRunner;
	/**
	 * When set, the hook runs as a thin client of the `cast web` daemon instead
	 * of owning the agent loop locally: `submit`/`abort`/`steer`/`followUp` go
	 * over HTTP and events arrive via SSE. This is the single-writer daemon model
	 * — the daemon owns runAgentLoop and streams to every surface (TUI + web).
	 * Absent for `cast run --interactive` and headless paths, which keep the
	 * local loop (and for tests, which assert against it).
	 */
	daemonUrl?: string;
	daemonToken?: string;
	/** Background bash task registry for this session — see LoopConfig.backgroundBash's doc comment. */
	backgroundTasks: BackgroundTaskRegistry;
	permissionMode: PermissionMode;
	mcpResult: McpSetupResult;
	confirmBash: (command: string, reason: string) => Promise<boolean>;
	/** Per-turn system prompt rebuild for sticky rules + @-mention. */
	rebuildSystemPrompt?: (context: { userText: string; contextFiles: string[] }) => string;
	/** Available personas for the task tool. */
	personas?: import("../core/personas.ts").Persona[];
	/** Current persona name. */
	currentPersona?: string;
	/** Subagent prompts for the task tool. */
	subagentPrompts?: import("../core/subagents.ts").SubagentPrompt[];
	/** Model override for subagents. */
	subagentModel?: string;
	/** Provider name for the subagent model. */
	subagentModelProvider?: string;
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/** Whether the project cwd is trusted — for subagent AGENTS.md injection. */
	projectTrusted?: boolean;
	/** Parent `--no-skills` — forwarded to task subagents. */
	noSkills?: boolean;
	/** Parent `--skill` paths — forwarded to task subagents. */
	cliSkillPaths?: string[];
	/** Loaded skills — for the skill tool. */
	skills?: import("../core/skills.ts").Skill[];
	/** Configured SSH hosts for the ssh tool. */
	sshHosts?: import("../core/ssh.ts").SshHost[];
	/** Plan mode state — passed to the agent loop for system prompt injection and tool gating. */
	planState?: import("../core/plan.ts").PlanState;
	/** Fires when a plan signal succeeds mid-run: plan_done ("done") or
	 * question ("question"). The App shows the corresponding confirmation
	 * dialog once the run settles — never mid-run, so tool sets stay consistent. */
	onPlanSignal?: (kind: "done" | "question") => void;
	/** Runs the loop on this model instead of session.model — the plan-mode
	 * model override. session.model stays untouched: it is the user's main
	 * model, this is a per-phase substitution. */
	modelOverride?: string;
	/** Provider name for the plan model. */
	planModelProvider?: string;
}

/**
 * Flatten a raw message's content down to display text.
 *
 * Content starts as a plain string, but applyCacheControl (core/llm.ts)
 * rewrites it *in place* to a structured `[{ type: "text", text }, ...]` array
 * to attach cache markers — and those mutations land on the very objects held
 * in session.messages (and get persisted). Image attachments are structured
 * from the start too. Pull the text parts back out instead of collapsing the
 * whole thing to a "[structured content]" placeholder: otherwise a resumed
 * session — or a <Static> repaint after a terminal resize — renders the user's
 * own prompt (and the assistant's replies) as that placeholder.
 */
export function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		let images = 0;
		for (const part of content) {
			if (!part || typeof part !== "object" || !("type" in part)) continue;
			const type = (part as { type: unknown }).type;
			if (type === "text" && typeof (part as { text?: unknown }).text === "string") {
				parts.push((part as { text: string }).text);
			} else if (type === "image_url") {
				images++;
			}
		}
		if (images > 0) parts.push(images === 1 ? "[image]" : `[${images} images]`);
		if (parts.length > 0) return parts.join("\n");
	}
	return "[structured content]";
}

/**
 * Rebuilds a flat display list from the raw OpenAI-shaped messages array.
 * An assistant turn with tool_calls plus the following role:tool results
 * collapses into one ChatMessage with a `toolCalls` array — the raw shape
 * (assistant message, then separate tool messages) leaks provider protocol
 * details into the transcript that the user shouldn't have to read.
 */
export function buildDisplayMessages(sessionMessages: SessionState["messages"]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < sessionMessages.length; i++) {
		const m = sessionMessages[i]!;
		if (m.role === "system") continue;
		if (m.role === "tool") continue;

		if (m.role === "user") {
			const text = messageContentToText(m.content);
			// Extract <system-reminder> blocks and render them as warning
			// messages instead of raw XML. These are internal protocol
			// (compaction, date-rollover, interrupt reminders) injected as
			// role:"user" because the wire format has no dedicated role.
			const reminders: string[] = [];
			const cleaned = text
				.replace(/<system-reminder>([\s\S]*?)<\/system-reminder>/g, (_, body: string) => {
					reminders.push(body.trim());
					return "";
				})
				.trim();
			// Show each reminder as a styled warning message
			for (const body of reminders) {
				if (body) out.push({ role: "warning", content: `[system] ${body}` });
			}
			if (cleaned) out.push({ role: "user", content: cleaned });
			if (!cleaned && reminders.length === 0) out.push({ role: "user", content: text });
			continue;
		}

		if (m.role === "assistant") {
			// Assistant turns are often tool-calls-only with null content — keep
			// those blank; only structured arrays carry extractable text. The wire
			// format records no reasoning and no text/tool interleaving, so the
			// best a rebuild can reconstruct is one content block (if any) followed
			// by the tool blocks in order.
			const content = Array.isArray(m.content) ? messageContentToText(m.content) : (m.content ?? "");
			const blocks: StreamBlock[] = [];
			if (content) blocks.push({ kind: "content", text: content });
			const toolBlocks: Array<Extract<StreamBlock, { kind: "tool" }>> = [];
			if ("tool_calls" in m && m.tool_calls) {
				for (const tc of m.tool_calls) {
					if (tc.type !== "function") continue;
					const block: Extract<StreamBlock, { kind: "tool" }> = {
						kind: "tool",
						call: { id: tc.id, name: tc.function.name, args: tc.function.arguments, status: "ok" },
					};
					toolBlocks.push(block);
					blocks.push(block);
				}
			}
			// Associate following tool result messages with this assistant turn
			let next = i + 1;
			while (next < sessionMessages.length && sessionMessages[next]!.role === "tool") {
				const tr = sessionMessages[next] as {
					role: "tool";
					content: string;
					tool_call_id?: string;
					castIsError?: boolean;
				};
				const target = toolBlocks.find((t) => t.call.id === tr.tool_call_id);
				if (target) {
					target.call.result = String(tr.content).slice(0, 4000);
					target.call.status = completedToolCallStatus(tr.castIsError);
				}
				next++;
			}
			// Advance i past the tool results so the for loop doesn't visit them again
			i = next - 1;
			out.push({ role: "assistant", content: "", blocks: blocks.length > 0 ? blocks : undefined });
		}
	}
	return out;
}

export function useAgentSession(params: UseAgentSessionParams): UseAgentSession {
	const {
		session,
		config,
		cwd,
		systemPrompt,
		runner,
		backgroundTasks,
		permissionMode,
		mcpResult,
		confirmBash,
		rebuildSystemPrompt,
		personas,
		currentPersona,
		subagentPrompts,
		subagentModel,
		subagentModelProvider,
		disabledTools,
		projectTrusted,
		noSkills,
		cliSkillPaths,
		skills,
		planState,
		onPlanSignal,
		modelOverride,
		planModelProvider,
		daemonUrl,
		daemonToken,
	} = params;
	// Thin-client mode: this hook does not own the agent loop; the `cast web`
	// daemon does, and events arrive over SSE. Local path (runner, runAgentLoop)
	// is fully preserved when daemonUrl is unset.
	const isClient = !!daemonUrl;
	const [messages, setMessages] = useState<ChatMessage[]>(() => buildDisplayMessages(getFullHistory(session.id)));
	const [streaming, setStreaming] = useState<StreamingState | null>(null);
	const [status, setStatus] = useState<AgentStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState<RetryInfo | null>(null);
	const [usage, setUsage] = useState<UseAgentSession["usage"]>(() => ({ ...session.usage }));
	const [lastTurnUsage, setLastTurnUsage] = useState<UseAgentSession["lastTurnUsage"]>(null);
	// Live stopwatch: the timestamp the current turn started, or null when
	// idle. Only changes at start/stop (not a per-tick state) — the status
	// bar's elapsed segment ticks itself locally off this value instead of
	// this hook re-rendering App every 200ms (see ElapsedSegment in App.tsx).
	const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
	const turnStartRef = useRef(0);
	// Frozen elapsed time of the last completed turn, for synchronous reads
	// (e.g. /current) once the turn has ended.
	const frozenElapsedRef = useRef(0);
	// classes with no reactivity of their own.
	// Hide reasoning blocks by default — reasoning models (MiniMax-M3, etc.)
	// stream a lot of auxiliary thinking that just clutters the transcript.
	// The /reasoning-display command toggles this for the current session
	// only (no persistent setting); when the model is not configured for
	// reasoning the toggle is a no-op since no thinking blocks ever arrive
	// to filter.
	const [pendingSteers, setPendingSteers] = useState<string[]>([]);
	const [pendingQueue, setPendingQueue] = useState<string[]>([]);
	// Thin-client only: the daemon's pending question, stashed from the SSE
	// tool_end event (see the SSE handler below). The App opens the picker off
	// this instead of the local planState, which the daemon owns in client mode.
	const [pendingQuestion, setPendingQuestion] = useState<PlanQuestion | undefined>(undefined);
	const [showReasoning, setShowReasoning] = useState(() => loadSettings().showReasoning ?? false);
	const showReasoningRef = useRef(loadSettings().showReasoning ?? false);
	const toggleReasoning = useCallback((): boolean => {
		setShowReasoning((prev) => {
			const next = !prev;
			// Stash on a ref so the synchronous caller can read it back
			// without waiting for React's batch — the same value we just
			// committed to the next render.
			showReasoningRef.current = next;
			// Persist across restarts.
			updateSettings({ showReasoning: next });
			return next;
		});
		return showReasoningRef.current;
	}, []);
	const acRef = useRef<AbortController | null>(null);
	// Set when a retry event arrives; cleared on the first streaming event
	// (token/thinking) so the retry banner disappears once new content flows.
	const clearRetryOnNextChunk = useRef(false);
	// Doom-loop warnings queued until turn_end: the blocked tool's block is
	// still in the live streaming region when the doom_loop event fires, so
	// appending the warning to history immediately would print it ABOVE the
	// very tool call it refers to. turn_end promotes the streaming blocks
	// first, then these flush in the right order.
	const pendingDoomWarningsRef = useRef<string[]>([]);
	// Tool names by call id for the current run: tool_end events don't carry
	// the name, and the plan_done notice below needs to know which tool ended.
	const toolNamesByIdRef = useRef(new Map<string, string>());
	// The authoritative "current streaming" value — read and written directly,
	// never through setStreaming's own updater callback. React only guarantees
	// a setState updater function runs by the time of the *next render*, not
	// synchronously at the moment setState is called; it can defer and batch
	// queued updates. Two turn-boundary calls can happen back-to-back with no
	// render in between (turn_end immediately followed by the submit()
	// finally block's safety-net flush) — relying on the updater's own `prev`
	// argument there both read the *pre-update* value, so the second call
	// re-pushed the same completed turn (the actual cause of a duplicate-
	// message bug this once regressed to). streamingRef sidesteps that by
	// never depending on when React gets around to processing the queue.
	const streamingRef = useRef<StreamingState | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Context files (paths from read/write/edit tool calls) accumulated across
	// this session's submits, so a glob rule that latched onto a file read in an
	// earlier message stays attached. Reset when the session itself changes
	// (/new, session switch) via the render-time "reset state on prop change"
	// pattern — an effect would lag one render and trip exhaustive-deps.
	const contextFilesRef = useRef<string[]>([]);
	const contextFilesSessionRef = useRef(session.id);
	if (contextFilesSessionRef.current !== session.id) {
		contextFilesSessionRef.current = session.id;
		contextFilesRef.current = [];
	}

	// Live stopwatch: record the start timestamp when the agent starts
	// running, freeze the elapsed value when it stops. No interval here —
	// ticking lives in the status bar's own component so it doesn't force
	// App (and the composer under it) to re-render every 200ms.
	useEffect(() => {
		if (status === "running") {
			turnStartRef.current = Date.now();
			setTurnStartedAt(turnStartRef.current);
		} else if (turnStartRef.current) {
			frozenElapsedRef.current = Date.now() - turnStartRef.current;
			setTurnStartedAt(null);
		}
	}, [status]);

	const getElapsedMs = useCallback(() => {
		return turnStartRef.current && status === "running"
			? Date.now() - turnStartRef.current
			: frozenElapsedRef.current;
	}, [status]);

	// Flush pending streaming state to React immediately.
	const flushStreaming = useCallback(() => {
		if (flushTimerRef.current !== null) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}
		setStreaming(streamingRef.current);
	}, []);

	// Accumulate streaming updates in the ref and schedule a deferred flush.
	// Rapid per-token events (thinking, token) batch into one React render
	// per ~16 ms frame instead of one per token. Structural changes (tool_start,
	// turn_end, etc.) call flushStreaming() directly for immediate UI feedback.
	const updateStreaming = useCallback(
		(updater: (prev: StreamingState | null) => StreamingState | null, immediate?: boolean) => {
			let next = updater(streamingRef.current);
			// Drain settled blocks (finished reasoning/text/completed tool calls)
			// out of the live region into <Static> history the moment they can't
			// change again, leaving only the actively-streaming tail live. Without
			// this the whole turn accumulates in Ink's live region; once it grows
			// past the terminal height, log-update's erase can't reach the rows
			// that scrolled off and frames stack instead of overwriting (duplicated
			// [reasoning] lines, spinner-per-line). A settle is a structural
			// boundary, so flush the frame immediately when one happens rather than
			// leaving the drained blocks visible in the live region for up to 16ms.
			let settledNow = false;
			if (next && next.blocks.length > 0) {
				const boundarySettled = settledPrefixLength(next.blocks);
				let promoted = next.blocks.slice(0, boundarySettled);
				let rest = next.blocks.slice(boundarySettled);
				// splitCompleteLines preserves reasoning as one logical block; answer
				// lines can still commit incrementally.
				if (rest.length > 0) {
					const { settled: lineSettled, tail } = splitCompleteLines(rest[0]!);
					if (lineSettled.length > 0) {
						promoted = [...promoted, ...lineSettled];
						rest = [tail, ...rest.slice(1)];
					}
				}
				if (promoted.length > 0) {
					next = { blocks: rest };
					setMessages((msgs) => [...msgs, { role: "assistant", content: "", blocks: promoted }]);
					settledNow = true;
				}
			}
			streamingRef.current = next;
			if (immediate || settledNow) {
				flushStreaming();
			} else if (flushTimerRef.current === null) {
				flushTimerRef.current = setTimeout(() => {
					flushTimerRef.current = null;
					setStreaming(streamingRef.current);
				}, 16);
			}
		},
		[flushStreaming],
	);

	/**
	 * Flushes whatever's left in the live region (the trailing block that never
	 * settled while streaming) into permanent history and resets streaming for
	 * the next turn. Most blocks already left the live region as they settled
	 * (see updateStreaming's drain); this just commits the tail. Promoting from
	 * the streaming state — not rebuilding from raw session/wire messages — is
	 * what keeps each tool call's real final status without waiting on a
	 * session rebuild. Rebuilds also restore status via castIsError on
	 * role:"tool" messages (stripped before the provider). Respects Ink's
	 * <Static>, which permanently commits
	 * whatever an index held the first time it renders and never revisits it —
	 * safe here because a tool block only ever leaves streaming once it's no
	 * longer "running" (both here and in the incremental drain).
	 */
	const promoteStreamingToHistory = useCallback(() => {
		const s = streamingRef.current;
		if (s && s.blocks.length > 0) {
			setMessages((msgs) => [...msgs, { role: "assistant", content: "", blocks: s.blocks }]);
		}
		updateStreaming(() => ({ blocks: [] }), true);
	}, [updateStreaming]);

	// Rebuild-from-session must never run mid-turn: <Static> permanently
	// commits items by index and never revisits them, so replacing the
	// incrementally-promoted messages array with a (differently-sized) rebuild
	// desyncs the array from what's already printed. Deps are [session] only —
	// session's identity is stable for the App's lifetime, so the mount effect
	// below fires exactly once; every other call site (compaction, /clear,
	// session switch) invokes refresh() explicitly at a turn boundary.
	const refresh = useCallback(() => {
		setMessages(buildDisplayMessages(getFullHistory(session.id)));
		setUsage({ ...session.usage });
		setLastTurnUsage(null);
	}, [session]);

	/** Lightweight refresh for metadata-only changes (/model, /persona, /provider).
	 *  Skips the full message rebuild since no messages changed. */
	const refreshMeta = useCallback(() => {
		setUsage({ ...session.usage });
		setLastTurnUsage(null);
	}, [session]);

	// Built once (runner/backgroundTasks are stable props) — followUpQueue and
	// isRunning don't depend on `submit` existing, so this can be constructed
	// eagerly; only the "wake an idle session" callback below needs `submit`,
	// wired separately via setOnIdleWake once it's defined.
	const backgroundBashDeps = useRef<BashBackgroundDeps | undefined>(undefined);
	backgroundBashDeps.current ??= {
		registry: backgroundTasks,
		followUpQueue: runner.followUpQueue,
		isRunning: () => runner.isRunning,
	};

	const submit = useCallback(
		async (text: string, images?: PendingImage[]) => {
			if (isClient && daemonUrl) {
				// Thin-client submit: the daemon owns the loop. Enqueue locally if a
				// turn is already running (the daemon serializes concurrent submits),
				// else POST the prompt and let the SSE stream render the turn. We
				// await the POST so a network/daemon error surfaces as `setError`
				// rather than silently dropping the message; the stream carries all
				// token/tool/status updates. Use a long timeout — the daemon may run
				// a long turn, but the HTTP response returns once the turn queue is
				// accepted, not when the turn finishes.
				const running = await fetch(`${daemonUrl}/api/sessions/${session.id}/chat`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
					},
					body: JSON.stringify({
						text,
						images: images?.map((img) => img.dataUrl),
					}),
				}).catch(() => null);
				if (!running || running.status >= 400) {
					setError("Daemon unreachable — is 'cast web' running?");
				}
				return;
			}
			if (!isClient && runner.isRunning) {
				runner.steeringQueue.enqueue({ role: "user", content: text });
				return;
			}
			setError(null);
			setRetry(null);
			setLastTurnUsage(null);
			frozenElapsedRef.current = 0;

			// Re-resolved fresh (not the `hooks` prop captured at startup) so a
			// /hooks enable|disable or an edited hooks.json takes effect on the
			// very next message, matching the web bridge's per-turn resolve.
			const turnHooks = resolveHooksForCwd(cwd, projectTrusted === true);
			if (hasHooks(turnHooks)) {
				const submitResult = await runHooksForEvent(turnHooks, {
					event: "UserPromptSubmit",
					cwd,
					sessionId: session.id,
					payload: { prompt: text },
				});
				if (submitResult.blocked) {
					setError(`Prompt blocked by hook: ${submitResult.reason ?? "no reason given"}`);
					return;
				}
				if (submitResult.reason) text = `${text}\n\n<hook-context>${submitResult.reason}</hook-context>`;
			}

			const chk = createCheckpoint(cwd);
			if (!session.checkpoints) session.checkpoints = [];
			session.checkpoints.push(chk);

			const userContent =
				images && images.length > 0
					? [
							{ type: "text" as const, text },
							...images.map((img) => ({
								type: "image_url" as const,
								image_url: { url: img.dataUrl },
							})),
						]
					: text;
			appendMessage(session, { role: "user", content: userContent });
			// Append directly rather than refresh()'s rebuild-from-session.messages —
			// an aborted or errored run doesn't merge its (possibly partial)
			// assistant turn back into session.messages (see the "aborted" case in
			// loop.ts's runLoop), so a rebuild right after one would produce a
			// *shorter* array than what promoteStreamingToHistory already
			// incrementally appended for that turn. Ink's <Static> never revisits
			// an index once rendered, so overwriting that slot with this new user
			// message here would just never be shown — the next thing appended
			// after it (the new turn's response) would still show up, landing at a
			// higher index, which is exactly the "my message vanished but the
			// reply appeared" bug this fixes.
			setMessages((msgs) => [...msgs, { role: "user", content: messageContentToText(userContent) }]);

			const ac = new AbortController();
			acRef.current = ac;
			runner.startRun(ac);

			const onSigint = () => {
				runner.abort();
			};
			process.on("SIGINT", onSigint);

			const onUncaught = (err: Error) => {
				saveSession(session);
				if (isRetryableStreamError(err)) {
					// Retryable stream errors (mid-flight connection drop, 429 rate
					// limit, 5xx) are transient — save the session and let the process
					// live so the finally block can clean up the run state gracefully.
					// Non-retryable errors (programming bugs, corrupted state) are fatal.
					return;
				}
				console.error(err);
				process.exit(1);
			};
			process.on("uncaughtException", onUncaught);

			setStatus("running");
			// A turn aborted before its turn_end would otherwise leak queued
			// doom-loop warnings into the next turn's flush.
			pendingDoomWarningsRef.current = [];
			toolNamesByIdRef.current.clear();
			updateStreaming(() => ({ blocks: [] }), true);
			setStreamingActive(true);
			setLastTurnAborted(false);

			try {
				if (!session.lastAnnouncedLocalDate) {
					session.lastAnnouncedLocalDate = initialAnnouncedLocalDate(session);
				}
				const announcedLocalDate = {
					get value() {
						return session.lastAnnouncedLocalDate!;
					},
					set value(next: string) {
						session.lastAnnouncedLocalDate = next;
					},
				};
				// Resolve per-slot provider credentials.
				const providers = loadSettings().providers ?? [];
				const activeCreds = { baseURL: config.baseURL, apiKey: config.apiKey };
				const resolvedModelProvider =
					modelOverride && planModelProvider
						? resolveProvider(providers, planModelProvider, activeCreds)
						: undefined;
				const resolvedSubagentProvider = resolveProvider(providers, subagentModelProvider, activeCreds);
				// Keeps the MCP catalog text in sync with what loop.ts's own
				// persona.mcp filtering actually lets this persona call — same
				// lookup bridge.ts's computeSystemPrompt does.
				const activePersonaObj = personas?.find((p) => p.name === currentPersona);
				const result = await runAgentLoop(session.messages, {
					config,
					model: modelOverride ?? session.model,
					modelProvider: resolvedModelProvider,
					subagentModelProvider: resolvedSubagentProvider,
					cwd,
					systemPrompt,
					signal: ac.signal,
					steeringQueue: runner.steeringQueue,
					followUpQueue: runner.followUpQueue,
					confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
					mcpTools: mcpResult.toolDefinitions,
					mcpToolIndex: mcpResult.toolIndex,
					hooks: turnHooks,
					sessionId: session.id,
					permissionMode,
					skills,
					lastPromptTokens: session.lastPromptTokens,
					rebuildSystemPrompt,
					contextFiles: contextFilesRef.current,
					personas,
					currentPersona,
					subagentPrompts,
					subagentModel,
					disabledTools,
					projectTrusted,
					noSkills,
					cliSkillPaths,
					sshHosts: params.sshHosts,
					backgroundBash: backgroundBashDeps.current,
					mcpPromptSuffix: formatMcpForPrompt(mcpResult, activePersonaObj?.mcp),
					planState,
					initialTodos: session.todos,
					announcedLocalDate,
					onCompaction: (full, compacted) => recordCompaction(session, full, compacted),
					// Append straight into the display history: warnings fire mid-run
					// (e.g. vision fallback, before the response streams), so an
					// append lands chronologically right — after the user message and
					// any already-settled blocks, above the live streaming region.
					// The old warnings-state + rebuild-on-refresh approach inserted
					// them below <Static>'s already-rendered index, where they were
					// never printed at all.
					onWarning: (message: string) => setMessages((msgs) => [...msgs, { role: "warning", content: message }]),
					onEvent: (event: AgentEvent) => {
						switch (event.type) {
							case "thinking":
								if (clearRetryOnNextChunk.current) {
									clearRetryOnNextChunk.current = false;
									setRetry(null);
								}
								updateStreaming((s) => (s ? reduceStreamEvent(s, { type: "thinking", text: event.text }) : s));
								break;
							case "token": {
								if (clearRetryOnNextChunk.current) {
									clearRetryOnNextChunk.current = false;
									setRetry(null);
								}
								updateStreaming((s) => {
									if (!s) return s;
									const next = reduceStreamEvent(s, { type: "content", text: event.text });
									const appended = next.blocks;
									// Strip duplicate Hermes XML tool-call blocks as they accumulate.
									// Only strip if we see <tool_call> to avoid accidentally removing
									// user-provided XML that happens to contain <function=.
									const last = appended[appended.length - 1];
									if (last && last.kind === "content" && last.text.includes("<tool_call>")) {
										const stripped = stripHermesToolCalls(last.text);
										if (stripped !== last.text) {
											return {
												blocks: [...appended.slice(0, -1), { kind: "content" as const, text: stripped }],
											};
										}
									}
									return { ...next, blocks: appended };
								});
								break;
							}
							case "tool_start":
								toolNamesByIdRef.current.set(event.id, event.name);
								updateStreaming(
									(s) =>
										s
											? reduceStreamEvent(s, {
													type: "tool_start",
													call: { id: event.id, name: event.name, args: event.args, status: event.status },
												})
											: s,
									true,
								);
								break;
							case "tool_end":
								updateStreaming((s) => {
									if (!s) return s;
									return reduceStreamEvent(s, {
										type: "tool_end",
										id: event.id,
										status: event.status,
										result: event.result.content.slice(0, 4000),
									});
								}, true);
								// Plan signal tools succeeding leave persistent state in the transcript
								// leave a persistent pointer in the transcript (a timed notice
								// would vanish while the user is still reading), and tell the
								// App so it can show the confirmation dialog once the run ends.
								if (!event.result.isError) {
									const endedTool = toolNamesByIdRef.current.get(event.id);
									if (endedTool === "plan_done") {
										// Full path in the transcript so the user can cmd-click it
										// open in their editor — the plan is theirs to review.
										const planPath = planState ? readActivePlan(planState).path : undefined;
										setMessages((msgs) => [
											...msgs,
											{
												role: "warning",
												content: `[Plan ready${planPath ? `: ${planPath}` : ""} — approval dialog opens when the turn ends]`,
											},
										]);
										onPlanSignal?.("done");
									} else if (endedTool === "question") {
										onPlanSignal?.("question");
									}
								}
								break;
							case "steering_injected":
							case "followup_injected": {
								// Promote the turn-so-far first so history reads
								// chronologically (finished response, then the
								// injected message), then show the injected message
								// itself — otherwise a steering/follow-up message
								// typed mid-run never appears in the transcript.
								promoteStreamingToHistory();
								const injected: ChatMessage[] = event.messages.map((m) => ({
									role: "user",
									content: messageContentToText(m.content),
								}));
								setMessages((msgs) => [...msgs, ...injected]);
								setError(null);
								// MessageQueue.drain() hands back one message at a time, so
								// this only ever needs to drop the front entry — sliced by
								// length rather than hardcoding 1 in case that contract
								// ever changes.
								if (event.type === "steering_injected") {
									setPendingSteers((p) => p.slice(event.messages.length));
								} else {
									setPendingQueue((p) => p.slice(event.messages.length));
								}
								break;
							}
							case "turn_end": {
								promoteStreamingToHistory();
								setError(null);
								const doomWarnings = pendingDoomWarningsRef.current;
								if (doomWarnings.length > 0) {
									pendingDoomWarningsRef.current = [];
									setMessages((msgs) => [
										...msgs,
										...doomWarnings.map((content) => ({ role: "warning" as const, content })),
									]);
								}
								break;
							}
							case "compaction":
								refresh();
								break;
							case "compaction_failed":
								break;
							case "doom_loop":
								pendingDoomWarningsRef.current.push(
									`[doom loop] ${event.tool} blocked after ${event.attempts} identical calls`,
								);
								break;
							case "open_work_gate":
								pendingDoomWarningsRef.current.push(
									`[open work] continuing — ${event.openSteps} plan step(s) still open (nudge ${event.fires})`,
								);
								break;
							case "open_work_gate_exhausted":
								pendingDoomWarningsRef.current.push(
									`[open work] stopped after ${event.maxFires} nudge(s) — ${event.openSteps} plan step(s) still open`,
								);
								break;
							case "retry":
								setRetry({ attempt: event.attempt, reason: event.reason });
								clearRetryOnNextChunk.current = true;
								break;
							case "usage": {
								addUsage(session, event.usage, { subagent: event.subagent });
								setUsage({ ...session.usage });
								// A subagent's usage isn't a user-facing turn — don't let it
								// overwrite the main agent's last-turn / tok-s readout.
								if (event.subagent) break;
								const tokensPerSecond =
									event.generationMs && event.generationMs > 0 && event.usage.completionTokens > 0
										? event.usage.completionTokens / (event.generationMs / 1000)
										: undefined;
								setLastTurnUsage({
									promptTokens: event.usage.promptTokens,
									completionTokens: event.usage.completionTokens,
									totalTokens: event.usage.totalTokens,
									cost: event.usage.cost,
									cacheReadTokens: event.usage.cacheReadTokens,
									cacheWriteTokens: event.usage.cacheWriteTokens,
									tokensPerSecond,
								});
								break;
							}
							case "todos_updated":
								session.todos = event.todos;
								break;
							case "end":
								if (event.reason === "aborted") {
									setLastTurnAborted(true);
									setMessages((msgs) => [...msgs, { role: "warning", content: "[aborted]" }]);
								} else if (event.reason === "disconnected") {
									setMessages((msgs) => [...msgs, { role: "warning", content: "[terminated]" }]);
								} else if (event.reason !== "stop" && event.reason !== "error") {
									// "error" reason's own detailed message was already set by
									// the "error" event that fires right before this one —
									// setting it again here would clobber that with just the
									// bare word "error". Anything else (unexpected reason
									// string) still gets shown as a fallback.
									setError(event.reason);
								}
								break;
							case "error":
								setError(event.message);
								break;
						}
					},
				});
				session.messages = result;
			} catch (err) {
				setError(describeTurnError(err));
				setStatus("error");
			} finally {
				// Flush any trailing streamed content that never got a turn_end (e.g.
				// an uncaught mid-stream error) so it isn't silently lost, then force
				// streaming to null (not the blank object promoteStreamingToHistory
				// leaves behind) — ChatLog treats a non-null streaming object as
				// still running and would keep showing a spinner otherwise. No full
				// refresh() here: messages are already accurate from incremental
				// per-turn promotion, and rebuilding from raw session.messages would
				// lose each tool call's real status (see promoteStreamingToHistory).
				promoteStreamingToHistory();
				updateStreaming(() => null, true);
				setStreamingActive(false);
				displayWidthCacheFlush();
				setRetry(null);
				setStatus("idle");
				process.off("SIGINT", onSigint);
				process.off("uncaughtException", onUncaught);
				runner.endRun();
				acRef.current = null;
				saveSession(session);
			}
		},
		[
			runner,
			session,
			config,
			cwd,
			systemPrompt,
			permissionMode,
			mcpResult,
			confirmBash,
			refresh,
			promoteStreamingToHistory,
			updateStreaming,
			rebuildSystemPrompt,
			personas,
			currentPersona,
			subagentPrompts,
			subagentModel,
			disabledTools,
			projectTrusted,
			noSkills,
			cliSkillPaths,
			skills,
			planState,
			onPlanSignal,
			modelOverride,
			planModelProvider,
			subagentModelProvider,
			params.sshHosts,
			isClient,
			daemonUrl,
			daemonToken,
		],
	);

	// `submit` doesn't exist yet at the point backgroundBashDeps is built
	// above (it's defined by the useCallback right here) — wire the "wake an
	// idle session" callback separately, once it does. Re-runs (overwriting,
	// never going stale) whenever `submit`'s identity changes.
	useEffect(() => {
		backgroundTasks.setOnIdleWake((text) => {
			void submit(text);
		});
	}, [submit, backgroundTasks]);

	// Thin-client SSE: subscribe to the daemon's per-session event stream and
	// drive the same React state the local loop would. The daemon is the single
	// writer, so this is the only place events arrive in client mode. Mirrors
	// the WebEvent handling in src/web/public/sse-events.js (the browser path)
	// and the local onEvent below — all three must stay in lockstep on event
	// semantics. An SSE disconnect (daemon stopped via `cast web stop`, or a
	// crash) leaves the session idle; the TUI sees no live turn and can offer
	// reconnect on next submit.
	useEffect(() => {
		if (!isClient || !daemonUrl) return;
		const url = daemonToken
			? `${daemonUrl}/api/sessions/${session.id}/events?token=${encodeURIComponent(daemonToken)}`
			: `${daemonUrl}/api/sessions/${session.id}/events`;
		const source = new EventSource(url);
		source.onmessage = (ev) => {
			let event: import("../web/bridge.ts").WebEvent;
			try {
				event = JSON.parse(ev.data) as import("../web/bridge.ts").WebEvent;
			} catch {
				return;
			}
			switch (event.type) {
				case "user_message":
					setMessages((msgs) => [...msgs, { role: "user", content: messageContentToText(event.message.content) }]);
					break;
				case "status":
					setStatus(event.status);
					if (event.status === "running") {
						setStreamingActive(true);
						setLastTurnAborted(false);
						updateStreaming(() => ({ blocks: [] }), true);
					} else {
						setStreamingActive(false);
					}
					break;
				case "thinking":
					updateStreaming((s) => (s ? reduceStreamEvent(s, { type: "thinking", text: event.text }) : s));
					break;
				case "token":
					updateStreaming((s) => (s ? reduceStreamEvent(s, { type: "content", text: event.text }) : s));
					break;
				case "tool_start":
					updateStreaming(
						(s) =>
							s
								? reduceStreamEvent(s, {
										type: "tool_start",
										call: { id: event.id, name: event.name, args: event.args, status: event.status },
									})
								: s,
						true,
					);
					break;
				case "tool_end": {
					updateStreaming((s) => {
						if (!s) return s;
						return reduceStreamEvent(s, {
							type: "tool_end",
							id: event.id,
							status: event.status,
							result: event.result.content.slice(0, 4000),
						});
					}, true);
					// Mirror the local onEvent path below: plan-signal tools
					// succeeding leave a pointer in the transcript and tell the App
					// to open the approval dialog / question picker once the run
					// settles. The daemon owns planState in client mode, so the
					// question schema is carried by the tool_end event — stash it
					// for the App (same mechanism the web client uses in
					// sse-events.js).
					if (!event.result.isError) {
						if (event.name === "plan_done") {
							const planPath = planState ? readActivePlan(planState).path : undefined;
							setMessages((msgs) => [
								...msgs,
								{
									role: "warning",
									content: `[Plan ready${planPath ? `: ${planPath}` : ""} — approval dialog opens when the turn ends]`,
								},
							]);
							onPlanSignal?.("done");
						} else if (event.name === "question") {
							const question = parseQuestionToolResult(event.result.content);
							if (question) {
								setPendingQuestion(question);
								onPlanSignal?.("question");
							}
						}
					}
					break;
				}
				case "assistant_message":
					promoteStreamingToHistory();
					break;
				case "turn_meta":
					break;
				case "session_end":
					promoteStreamingToHistory();
					updateStreaming(() => null, true);
					setStreamingActive(false);
					setStatus("idle");
					break;
				case "end":
					if (event.reason === "aborted") {
						setLastTurnAborted(true);
						setMessages((msgs) => [...msgs, { role: "warning", content: "[aborted]" }]);
					} else if (event.reason !== "stop" && event.reason !== "error") {
						setError(event.reason);
					}
					break;
				case "error":
					setError(event.message);
					break;
				case "compaction":
					refresh();
					break;
				default:
					break;
			}
		};
		return () => source.close();
	}, [
		isClient,
		daemonUrl,
		daemonToken,
		session.id,
		promoteStreamingToHistory,
		updateStreaming,
		refresh,
		planState,
		onPlanSignal,
	]);

	const steer = useCallback(
		(text: string) => {
			if (isClient && daemonUrl) {
				void fetch(`${daemonUrl}/api/sessions/${session.id}/steer`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
					},
					body: JSON.stringify({ message: text }),
				}).catch(() => {});
				setPendingSteers((p) => [...p, text]);
				return;
			}
			runner.steeringQueue.enqueue({ role: "user", content: text });
			setPendingSteers((p) => [...p, text]);
		},
		[runner, isClient, daemonUrl, daemonToken, session.id],
	);

	const followUp = useCallback(
		(text: string) => {
			if (isClient && daemonUrl) {
				void fetch(`${daemonUrl}/api/sessions/${session.id}/followup`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
					},
					body: JSON.stringify({ message: text }),
				}).catch(() => {});
				setPendingQueue((p) => [...p, text]);
				return;
			}
			runner.followUpQueue.enqueue({ role: "user", content: text });
			setPendingQueue((p) => [...p, text]);
		},
		[runner, isClient, daemonUrl, daemonToken, session.id],
	);

	const abort = useCallback(() => {
		if (isClient && daemonUrl) {
			void fetch(`${daemonUrl}/api/sessions/${session.id}/abort`, {
				method: "POST",
				headers: {
					...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
				},
			}).catch(() => {});
			setPendingSteers([]);
			setPendingQueue([]);
			return;
		}
		runner.abort();
		// runner.abort() clears both queues (anything queued for this run is
		// moot once it's cancelled) — mirror that here so the UI doesn't keep
		// showing pending steer/follow-up entries that were just wiped.
		setPendingSteers([]);
		setPendingQueue([]);
	}, [runner, isClient, daemonUrl, daemonToken, session.id]);

	// Thin-client plan-decision plumbing: the daemon owns planState, so the
	// answer to its pending question (and the plan approval) must go back over
	// HTTP instead of mutating a local planState the way the local-loop path
	// does. No-ops in local mode — the App branches on daemonUrl and keeps the
	// planState path there.
	const answerQuestion = useCallback(
		(values: string[]) => {
			if (isClient && daemonUrl) {
				void fetch(`${daemonUrl}/api/sessions/${session.id}/question`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
					},
					body: JSON.stringify({ values }),
				}).catch(() => {});
				setPendingQuestion(undefined);
			}
		},
		[isClient, daemonUrl, daemonToken, session.id],
	);

	const approvePlan = useCallback(() => {
		if (isClient && daemonUrl) {
			void fetch(`${daemonUrl}/api/sessions/${session.id}/plan-transition`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
				},
				body: JSON.stringify({ kind: "done" }),
			}).catch(() => {});
		}
	}, [isClient, daemonUrl, daemonToken, session.id]);

	const cleanDaemonContext = useCallback(async (): Promise<string | undefined> => {
		if (!isClient || !daemonUrl) return undefined;
		try {
			const res = await fetch(`${daemonUrl}/api/sessions/${session.id}/clean-context`, {
				method: "POST",
				headers: {
					...(daemonToken ? { Authorization: `Bearer ${daemonToken}` } : {}),
				},
			});
			const data = (await res.json()) as { originalTask?: string };
			return data.originalTask;
		} catch {
			return undefined;
		}
	}, [isClient, daemonUrl, daemonToken, session.id]);

	const clearContext = useCallback(() => {
		clearSessionMessages(session);
		// The authoritative context-size signal must reset with the context it
		// measured — otherwise shouldCompact still sees the pre-clear size and
		// the first turn after clearing a long session (e.g. the "clear context,
		// then implement" plan approval) runs a pointless compaction pass over
		// an almost-empty conversation.
		session.lastPromptTokens = undefined;
		saveSession(session);
		// Static-rendered history is permanently committed to the terminal's own
		// scrollback (see ChatLog.tsx) — resetting the messages array doesn't
		// erase what's already printed. Clear screen + scrollback so /clear
		// actually looks cleared instead of just starting a fresh transcript
		// underneath the old one.
		process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
		refresh();
	}, [session, refresh]);

	const resetContext = useCallback(() => {
		const originalTask = resetSessionContext(session);
		saveSession(session);
		return originalTask;
	}, [session]);

	const resetQueue = useCallback(() => {
		runner.followUpQueue.clear();
		runner.steeringQueue.clear();
		setPendingQueue([]);
		setPendingSteers([]);
	}, [runner]);

	const addDisplayMessage = useCallback((message: ChatMessage) => {
		setMessages((msgs) => [...msgs, message]);
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	// Flush pending streaming updates on unmount so the final frame is accurate.
	useEffect(() => {
		return () => {
			if (flushTimerRef.current !== null) {
				clearTimeout(flushTimerRef.current);
				flushTimerRef.current = null;
			}
		};
	}, []);

	return {
		messages,
		streaming,
		status,
		error,
		retry,
		usage,
		lastTurnUsage,
		pendingSteers,
		pendingQueue,
		submit,
		steer,
		followUp,
		abort,
		clearContext,
		resetContext,
		refresh,
		refreshMeta,
		resetQueue,
		addDisplayMessage,
		pendingQuestion,
		answerQuestion,
		approvePlan,
		cleanDaemonContext,
		showReasoning,
		toggleReasoning,
		turnStartedAt,
		getElapsedMs,
	};
}
