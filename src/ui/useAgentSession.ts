import { randomUUID } from "node:crypto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// Node 22 has no global EventSource; undici ships one (experimental) that we
// use to receive the daemon's SSE stream. The browser build (esbuild bundle)
// provides a real global EventSource, so this import is Node-only and safe in
// both runtimes.
import { EventSource } from "undici";
import { subscribeAgentActorNotifications } from "../core/actor-events.ts";
import { backupFileForCheckpoint, createCheckpoint } from "../core/checkpoint.ts";
import type { AppConfig } from "../core/config.ts";
import { resolveProvider } from "../core/config.ts";
import { initialAnnouncedLocalDate } from "../core/date-rollover-reminder.ts";
import { hasHooks, runHooksForEvent } from "../core/hooks.ts";
import { describeTurnError, isRetryableStreamError, type Message, stripHermesToolCalls } from "../core/llm.ts";
import { type AgentEvent, runAgentLoop } from "../core/loop.ts";
import { formatMcpForPrompt, type McpSetupResult } from "../core/mcp.ts";
import type { Persona } from "../core/personas.ts";
import { type PlanQuestion, type PlanTransition, readActivePlan } from "../core/plan.ts";
import { resolveHooksForCwd } from "../core/project.ts";
import type { AgentRunner } from "../core/runner.ts";
import {
	addUsage,
	appendCheckpoint,
	appendMessage,
	clearSessionMessages,
	forkSession,
	getHistoryPage,
	type HistoryPage,
	recordCompaction,
	resetSessionContext,
	type SessionState,
	type SessionUsage,
	saveSession,
	updateLastCheckpoint,
} from "../core/session.ts";
import { loadSettings, type PermissionMode, updateSettings } from "../core/settings.ts";
import { setLastTurnAborted, setStreamingActive } from "../core/stdin-manager.ts";
import type { BackgroundTaskRegistry, BashBackgroundDeps } from "../core/tools/bash-background.ts";
import { completedToolCallStatus, type ToolCallStatus } from "../core/tools/shared.ts";
import {
	abortServerSession,
	answerServerQuestion,
	ensureServerClient,
	followUpServerSession,
	forkServerSession,
	getServerSession,
	resolveServerPlanTransition,
	runServerCommand,
	type ServerClient,
	serverFetch,
	setServerMode,
	steerServerSession,
	submitServerChat,
} from "../server/client.ts";
import {
	appendTextBlock,
	reduceStreamEvent,
	type StreamBlock,
	type StreamingState,
} from "../server/public/stream-blocks.js";
import { displayWidthCacheFlush } from "./display-width.ts";

export type AgentStatus = "idle" | "running" | "error";

// How many turns of history the TUI loads at once. Deliberately small (the
// web client pages by 30): a single turn can contain dozens of tool messages,
// and a handful of turns must still fit inside a typical terminal scrollback.
// Older turns are fetched on demand via loadOlder (/older, PageUp).
export const TUI_HISTORY_PAGE_TURNS = 5;

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
export type { StreamBlock, StreamingState } from "../server/public/stream-blocks.js";

export interface ChatMessage {
	role: "user" | "assistant" | "system" | "tool" | "warning";
	/** Plain text for user/warning/system/tool rows. Assistant rows use `blocks`. */
	content: string;
	clientMessageId?: string;
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

/** Extract persisted decision state from the daemon's session response. */
export function parseDaemonPendingState(state: Record<string, unknown>): {
	question: PlanQuestion | undefined;
	planTransition: PlanTransition | undefined;
	status: AgentStatus | undefined;
} {
	const question = state.question;
	const planTransition = state.planTransition;
	const status = state.status;
	return {
		question:
			question && typeof question === "object" && Array.isArray((question as { questions?: unknown }).questions)
				? (question as PlanQuestion)
				: undefined,
		planTransition:
			planTransition && typeof planTransition === "object" && (planTransition as { kind?: unknown }).kind === "done"
				? { kind: "done" }
				: undefined,
		status: status === "idle" || status === "running" || status === "error" ? status : undefined,
	};
}

/** A local loop has no daemon transport to gate; thin-client sends require its SSE proof. */
export function canSendToDaemon(isClient: boolean, connected: boolean): boolean {
	return !isClient || connected;
}

/** Fetch the daemon-owned decision state that predates this client's SSE stream. */
export async function loadDaemonPendingState(client: ServerClient, sessionId: string) {
	return parseDaemonPendingState(await getServerSession(client, sessionId));
}

/**
 * Commit a turn-ending error to the transcript and clear the live sticky error.
 * The loop fires `error` (which stashes the message) then `end` reason "error";
 * the latter calls this. Without it a 4xx stayed in ChatLog's live region above
 * the composer forever — it never entered the chronological history and never
 * cleared (the local path only cleared on turn_end, which an error turn never
 * reaches; the daemon SSE path never cleared at all).
 */
export function commitTurnError(
	errorRef: { current: string | null },
	setError: (value: string | null) => void,
	setMessages: (updater: (msgs: ChatMessage[]) => ChatMessage[]) => void,
): void {
	const message = errorRef.current;
	errorRef.current = null;
	setError(null);
	if (message) setMessages((msgs) => [...msgs, { role: "warning", content: `[${message}]` }]);
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
	/** Fork the current safe context; daemon mode performs the copy on the daemon. */
	forkSession: () => Promise<SessionState | undefined>;
	resetContext: () => string | undefined;
	/** Re-reads the on-disk session messages into the in-memory list. */
	refresh: () => void;
	refreshMeta: () => void;
	/** True when the session has older turns beyond the loaded history page.
	 *  The TUI only loads the most recent page on resume; loadOlder pages back
	 *  through the rest on demand. */
	hasOlder: boolean;
	/**
	 * Prepend the previous page of history to the transcript. Returns true when
	 * a page was loaded. Prepending shifts every index the <Static> already
	 * committed, so the caller must trigger a full replay (clear + bump the
	 * <Static> key) right after — same machinery as a theme change.
	 */
	loadOlder: () => boolean;
	resetQueue: () => void;
	addDisplayMessage: (message: ChatMessage) => void;
	/**
	 * Pending question from the daemon (thin-client mode). The daemon owns
	 * planState in that mode, so the TUI can't read the question locally the
	 * way the local-loop path does — the schema arrives on the SSE tool_end
	 * event and is stashed here for the App's question picker.
	 */
	pendingQuestion: PlanQuestion | undefined;
	/** Pending plan approval restored from the daemon on reconnect. */
	pendingPlanTransition: PlanTransition | undefined;
	/** Submit answers to the daemon's pending question (thin-client mode). */
	answerQuestion: (values: string[]) => void;
	/** Resolve the daemon's pending plan approval (thin-client mode). */
	approvePlan: () => void;
	/** Sync the session's plan/build mode to the daemon (thin-client mode). */
	setMode: (mode: "plan" | "build") => void;
	/** True only while the thin-client daemon's SSE stream is open. */
	daemonConnected: boolean;
	/** True when commands must be executed by the shared daemon rather than locally. */
	daemonMode: boolean;
	/** Execute a daemon-owned slash command; throws when running locally. */
	runCommand: (command: string) => Promise<unknown>;
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
	 * When set, the hook runs as a thin client of the `cast server` daemon instead
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
	/** Re-read persona overrides before a new turn so chat-created changes apply immediately. */
	refreshPersonasForTurn?: () => Promise<{ persona: Persona; personas: Persona[]; systemPrompt: string }>;
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
			const clientMessageId = (m as Message & { castClientMessageId?: string }).castClientMessageId;
			if (cleaned) out.push({ role: "user", content: cleaned, ...(clientMessageId ? { clientMessageId } : {}) });
			if (!cleaned && reminders.length === 0)
				out.push({ role: "user", content: text, ...(clientMessageId ? { clientMessageId } : {}) });
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
		refreshPersonasForTurn,
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
	// Thin-client mode: this hook does not own the agent loop; the `cast server`
	// daemon does, and events arrive over SSE. Local path (runner, runAgentLoop)
	// is fully preserved when daemonUrl is unset.
	//
	// The daemon is a live process that can be replaced under this TUI (crash,
	// `cast server stop`, upgrade restarting it). daemonOverride is set when a
	// submit discovers the original daemon is gone and a new one has taken over
	// — it redirects the SSE stream and all server calls to the new URL while
	// the session id (owned centrally by the daemon's shared store) is unchanged,
	// so the conversation survives the swap.
	const [daemonOverride, setDaemonOverride] = useState<{ url: string; token?: string } | undefined>(undefined);
	const effectiveDaemonUrl = daemonOverride?.url ?? daemonUrl;
	const effectiveDaemonToken = daemonOverride?.token ?? daemonToken;
	const isClient = !!effectiveDaemonUrl;
	const [daemonConnected, setDaemonConnected] = useState(!isClient);
	const daemonConnectedRef = useRef(daemonConnected);
	daemonConnectedRef.current = daemonConnected;
	// Shared HTTP client for the daemon (thin-client mode). Used by all the
	// server calls below — same wire layer as `cast run`/JSONL (server/client.ts),
	// so the TUI and headless paths speak to the daemon identically.
	const serverClient = useMemo(
		() => (effectiveDaemonUrl ? { baseUrl: effectiveDaemonUrl, token: effectiveDaemonToken } : undefined),
		[effectiveDaemonUrl, effectiveDaemonToken],
	);
	const pendingServerMessagesRef = useRef(
		new Map<string, { text: string; images?: string[]; clientMessageId: string; sending: boolean }>(),
	);
	// Load only the most recent page of history on resume. Loading the full
	// history (getFullHistory) dumped thousands of lines into the terminal's
	// scrollback at once, pushing the viewport to the bottom and past the
	// scrollback buffer limit — the start of a long session became unreachable.
	// Older turns are fetched on demand via loadOlder (the /older command /
	// PageUp), one page at a time. The page is deliberately small (a few turns,
	// not the web client's 30): a turn can carry dozens of tool messages, and
	// even a handful of turns must fit inside a typical terminal scrollback.
	const initialPageRef = useRef<HistoryPage | null>(null);
	if (initialPageRef.current === null) {
		initialPageRef.current = getHistoryPage(session.id, undefined, TUI_HISTORY_PAGE_TURNS);
	}
	const [messages, setMessages] = useState<ChatMessage[]>(() =>
		buildDisplayMessages(initialPageRef.current!.messages),
	);
	useEffect(() => {
		if (isClient) return;
		return subscribeAgentActorNotifications((actor) => {
			if (actor.parentSessionId !== session.id) return;
			const status = actor.status === "success" ? "completed" : actor.status;
			setMessages((msgs) => [...msgs, { role: "warning", content: `${actor.agent} ${status}` }]);
		});
	}, [isClient, session.id]);
	const [hasOlder, setHasOlder] = useState(() => initialPageRef.current!.hasMore);
	const oldestSeqRef = useRef<number | undefined>(initialPageRef.current!.oldestSeq);
	const [streaming, setStreaming] = useState<StreamingState | null>(null);
	const [status, setStatus] = useState<AgentStatus>("idle");
	const [error, setError] = useState<string | null>(null);
	// Latest error message, held outside React state so the "end" event handler
	// (a stale closure over `error`) can commit it to the transcript and clear
	// the live sticky error — see commitTurnError.
	const errorRef = useRef<string | null>(null);
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
	const [pendingPlanTransition, setPendingPlanTransition] = useState<PlanTransition | undefined>(undefined);
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
		const page = getHistoryPage(session.id, undefined, TUI_HISTORY_PAGE_TURNS);
		const rebuilt = buildDisplayMessages(page.messages);
		const known = new Set(rebuilt.map((message) => message.clientMessageId).filter(Boolean));
		for (const pending of pendingServerMessagesRef.current.values()) {
			if (!known.has(pending.clientMessageId)) {
				rebuilt.push({
					role: "user",
					content: pending.text,
					clientMessageId: pending.clientMessageId,
				});
			}
		}
		setMessages(rebuilt);
		oldestSeqRef.current = page.oldestSeq;
		setHasOlder(page.hasMore);
		setUsage({ ...session.usage });
		setLastTurnUsage(null);
	}, [session]);

	// Loads the page of history older than the currently-loaded window and
	// prepends it to the transcript. Returned boolean: true when more history
	// was loaded (and may still remain), false when there's nothing older.
	// Prepending to the messages array shifts every index <Static> already
	// committed (see ChatLog) — callers must follow up with a full replay via
	// the repaint-key bump that a theme change uses, or the shifted tail would
	// render as duplicates in the terminal's scrollback.
	const loadOlder = useCallback((): boolean => {
		const beforeSeq = oldestSeqRef.current;
		if (beforeSeq === undefined) return false;
		const page = getHistoryPage(session.id, beforeSeq, TUI_HISTORY_PAGE_TURNS);
		if (page.messages.length === 0) return false;
		setMessages((msgs) => [...buildDisplayMessages(page.messages), ...msgs]);
		oldestSeqRef.current = page.oldestSeq;
		setHasOlder(page.hasMore);
		return true;
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
			if (isClient && effectiveDaemonUrl) {
				// Thin-client submit: the daemon owns the loop. Enqueue locally if a
				// turn is already running (the daemon serializes concurrent submits),
				// else POST the prompt and let the SSE stream render the turn. We
				// await the POST so a network/daemon error surfaces as `setError`
				// rather than silently dropping the message; the stream carries all
				// token/tool/status updates. The request is acknowledged when the turn
				// enters the daemon queue, not when the turn finishes.
				if (!serverClient || !canSendToDaemon(isClient, daemonConnectedRef.current)) {
					setError("Daemon disconnected — message kept in the composer until it reconnects.");
					return;
				}
				const clientMessageId = randomUUID();
				pendingServerMessagesRef.current.set(clientMessageId, {
					text,
					images: images?.map((img) => img.dataUrl),
					clientMessageId,
					sending: true,
				});
				setMessages((msgs) => [...msgs, { role: "user", content: text, clientMessageId }]);
				const attempt = async (client: ServerClient): Promise<boolean> => {
					try {
						await submitServerChat(
							client,
							session.id,
							text,
							images?.map((img) => img.dataUrl),
							clientMessageId,
						);
						pendingServerMessagesRef.current.delete(clientMessageId);
						return true;
					} catch {
						const pending = pendingServerMessagesRef.current.get(clientMessageId);
						if (pending) pending.sending = false;
						return false;
					}
				};
				const reconnectAndWait = async (): Promise<boolean> => {
					setError("Reconnecting to daemon…");
					try {
						const live = await ensureServerClient();
						if (!live) return false;
						if (live.baseUrl !== effectiveDaemonUrl || live.token !== effectiveDaemonToken) {
							setDaemonOverride({ url: live.baseUrl, token: live.token });
						}
						// Do not POST from the recovery path. The SSE `onopen` handler is
						// the commit point: it proves the stream is live and retries the
						// pending request with the same clientMessageId exactly once.
						return false;
					} catch {
						return false;
					}
				};
				if (!(await attempt(serverClient))) {
					await reconnectAndWait();
					setError("Daemon unavailable — message kept until the daemon reconnects.");
				} else {
					setError(null);
				}
				return;
			}
			if (!isClient && runner.isRunning) {
				runner.steeringQueue.enqueue({ role: "user", content: text });
				return;
			}
			const ac = new AbortController();
			acRef.current = ac;
			const lease = runner.startRun(ac);
			const automaticMemoryMaintenance = session.messages.length === 0;
			const automaticMemoryMessages = session.messages.slice();
			let chk: ReturnType<typeof createCheckpoint>;
			let activeSystemPrompt = systemPrompt;
			let activePersonas = personas;
			let activePersonaName = currentPersona;
			let turnHooks: ReturnType<typeof resolveHooksForCwd>;
			const failSetup = (error: unknown): void => {
				ac.abort(error instanceof Error ? error.message : String(error));
				runner.endRun(lease);
				setError(error instanceof Error ? error.message : String(error));
				const queued = runner.steeringQueue.drain();
				if (queued.length > 0)
					void submit(queued.map((message) => messageContentToText(message.content)).join("\n\n"));
			};
			setError(null);
			if (refreshPersonasForTurn) {
				let refreshed: Awaited<ReturnType<NonNullable<typeof refreshPersonasForTurn>>>;
				try {
					refreshed = await refreshPersonasForTurn();
				} catch (error) {
					failSetup(error);
					return;
				}
				activeSystemPrompt = refreshed.systemPrompt;
				activePersonas = refreshed.personas;
				activePersonaName = refreshed.persona.name;
			}
			setRetry(null);
			setLastTurnUsage(null);
			frozenElapsedRef.current = 0;

			// Re-resolved fresh (not the `hooks` prop captured at startup) so a
			// /hooks enable|disable or an edited hooks.json takes effect on the
			// very next message, matching the web bridge's per-turn resolve.
			turnHooks = resolveHooksForCwd(cwd, projectTrusted === true);
			if (hasHooks(turnHooks)) {
				let submitResult: Awaited<ReturnType<typeof runHooksForEvent>>;
				try {
					submitResult = await runHooksForEvent(turnHooks, {
						event: "UserPromptSubmit",
						cwd,
						sessionId: session.id,
						payload: { prompt: text },
					});
				} catch (error) {
					failSetup(error);
					return;
				}
				if (submitResult.blocked) {
					setError(`Prompt blocked by hook: ${submitResult.reason ?? "no reason given"}`);
					ac.abort("Prompt blocked by hook");
					runner.endRun(lease);
					return;
				}
				if (submitResult.reason) text = `${text}\n\n<hook-context>${submitResult.reason}</hook-context>`;
			}

			// Ensure the session row exists before appending its checkpoint
			// (session_checkpoints has an FK to sessions) — the first turn of a
			// fresh session has no row yet otherwise.
			saveSession(session);
			chk = createCheckpoint(cwd);
			if (!session.checkpoints) session.checkpoints = [];
			session.checkpoints.push(chk);
			// Persist alongside the in-memory array (session.checkpoints isn't in
			// the session row — see session.ts) so /undo survives a restart.
			appendCheckpoint(session.id, chk);

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
			let completed = false;

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
				const activePersonaObj = activePersonas?.find((p) => p.name === activePersonaName);
				const result = await runAgentLoop(session.messages, {
					config,
					model: modelOverride ?? session.model,
					modelProvider: resolvedModelProvider,
					subagentModelProvider: resolvedSubagentProvider,
					cwd,
					systemPrompt: activeSystemPrompt,
					memory: { sessionId: session.id },
					automaticMemoryMaintenance,
					automaticMemoryMessages,
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
					personas: activePersonas,
					currentPersona: activePersonaName,
					subagentPrompts,
					subagentModel,
					disabledTools,
					projectTrusted,
					noSkills,
					cliSkillPaths,
					sshHosts: params.sshHosts,
					backgroundBash: backgroundBashDeps.current,
					mcpPromptSuffix: formatMcpForPrompt(mcpResult, activePersonaObj?.mcp),
					beforeFileWrite: (path) => {
						backupFileForCheckpoint(chk, path);
						updateLastCheckpoint(session.id, chk);
					},
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
								addUsage(session, event.usage, { subagent: event.subagent, background: event.background });
								setUsage({ ...session.usage });
								// A subagent's usage isn't a user-facing turn — don't let it
								// overwrite the main agent's last-turn / tok-s readout.
								if (event.subagent || event.background) break;
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
								} else if (event.reason === "error") {
									// Turn-level error: commit to the transcript (it belongs
									// in the chronology, like [aborted]/[terminated]) and drop
									// the live sticky error that would otherwise sit above the
									// composer until the next successful turn_end.
									commitTurnError(errorRef, setError, setMessages);
								} else if (event.reason !== "stop") {
									// "error" reason's own detailed message was already set by
									// the "error" event that fires right before this one —
									// setting it again here would clobber that with just the
									// bare word "error". Anything else (unexpected reason
									// string) still gets shown as a fallback.
									setError(event.reason);
								}
								break;
							case "error":
								errorRef.current = event.message;
								setError(event.message);
								break;
						}
					},
				});
				session.messages = result;
				completed = true;
			} catch (err) {
				// No "end" event follows an unexpected throw from runAgentLoop — commit
				// the error to the transcript directly so it doesn't stay stuck live.
				errorRef.current = describeTurnError(err);
				commitTurnError(errorRef, setError, setMessages);
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
				runner.endRun(lease);
				acRef.current = null;
				saveSession(session);

				// A follow-up can arrive after the loop's final queue drain but before
				// this cleanup runs. Re-submit that late batch now that the runner is
				// idle, otherwise the local TUI would leave it displayed as Queued.
				const lateFollowUps = completed ? runner.followUpQueue.drain() : [];
				if (lateFollowUps.length > 0) {
					const followUpText = lateFollowUps
						.map((message) => messageContentToText(message.content))
						.filter(Boolean)
						.join("\n\n");
					setPendingQueue((pending) => pending.slice(lateFollowUps.length));
					void submit(followUpText);
				}
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
			refreshPersonasForTurn,
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
			effectiveDaemonUrl,
			effectiveDaemonToken,
			serverClient,
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

	// SSE only carries events emitted after this client attaches. Rehydrate
	// decisions already persisted by the daemon so reconnecting does not lose
	// a question or plan-approval picker that was waiting before the TUI opened.
	useEffect(() => {
		if (!isClient || !serverClient) return;
		let disposed = false;
		void loadDaemonPendingState(serverClient, session.id)
			.then((pending) => {
				if (disposed) return;
				setPendingQuestion(pending.question);
				setPendingPlanTransition(pending.planTransition);
				if (pending.status) setStatus(pending.status);
			})
			.catch(() => {});
		return () => {
			disposed = true;
		};
	}, [isClient, serverClient, session.id]);

	// Thin-client SSE: subscribe to the daemon's per-session event stream and
	// drive the same React state the local loop would. The daemon is the single
	// writer, so this is the only place events arrive in client mode. Mirrors
	// the WebEvent handling in src/server/public/sse-events.js (the browser path)
	// and the local onEvent below — all three must stay in lockstep on event
	// semantics. An SSE disconnect (daemon stopped via `cast server stop`, or a
	// crash) is surfaced immediately and triggers daemon re-selection; the stream
	// hydrates persisted session state after it reconnects.
	useEffect(() => {
		if (!isClient || !effectiveDaemonUrl) {
			setDaemonConnected(true);
			return;
		}
		setDaemonConnected(false);
		const url = effectiveDaemonToken
			? `${effectiveDaemonUrl}/api/sessions/${session.id}/events?token=${encodeURIComponent(effectiveDaemonToken)}`
			: `${effectiveDaemonUrl}/api/sessions/${session.id}/events`;
		const source = new EventSource(url);
		let opened = false;
		let recoveryStarted = false;
		let disposed = false;
		const retryPending = async () => {
			const client = serverClient ?? { baseUrl: effectiveDaemonUrl, token: effectiveDaemonToken };
			for (const pending of pendingServerMessagesRef.current.values()) {
				if (pending.sending) continue;
				pending.sending = true;
				try {
					// Preserve send order: a retried older prompt must reach the daemon
					// before a later one from the same session.
					// biome-ignore lint/performance/noAwaitInLoops: outgoing messages are ordered
					await submitServerChat(client, session.id, pending.text, pending.images, pending.clientMessageId);
					pendingServerMessagesRef.current.delete(pending.clientMessageId);
				} catch {
					pending.sending = false;
				}
			}
		};
		const hydrate = () => {
			void refresh();
			if (serverClient) {
				void loadDaemonPendingState(serverClient, session.id)
					.then((pending) => {
						if (disposed) return;
						setPendingQuestion(pending.question);
						setPendingPlanTransition(pending.planTransition);
						if (pending.status) setStatus(pending.status);
					})
					.catch(() => {});
			}
		};
		source.onopen = () => {
			setDaemonConnected(true);
			setError(null);
			void retryPending();
			if (!opened) {
				opened = true;
				if (daemonOverride) hydrate();
				return;
			}
			hydrate();
		};
		source.onerror = () => {
			if (disposed) return;
			setDaemonConnected(false);
			setError("Daemon connection lost — reconnecting…");
			if (recoveryStarted) return;
			recoveryStarted = true;
			void ensureServerClient()
				.then((live) => {
					if (disposed || !live) return;
					// Replace the EventSource even when the daemon came back on the
					// same URL. A CLOSED source is not guaranteed to retry after a
					// restart; the new open is also the commit point for pending sends.
					setDaemonOverride({ url: live.baseUrl, token: live.token });
				})
				.catch(() => {});
		};
		source.onmessage = (ev) => {
			let event: import("../server/bridge.ts").WebEvent;
			try {
				event = JSON.parse(ev.data) as import("../server/bridge.ts").WebEvent;
			} catch {
				return;
			}
			switch (event.type) {
				case "user_message":
					setMessages((msgs) => {
						const clientMessageId = event.message.clientMessageId;
						if (clientMessageId) {
							pendingServerMessagesRef.current.delete(clientMessageId);
							// The message is already in the transcript (appended on
							// submit); just drop the pending-server entry. If it's not
							// there (e.g. history reload raced the append), fall
							// through and add it.
							const existing = msgs.findIndex((message) => message.clientMessageId === clientMessageId);
							if (existing >= 0) return msgs;
						}
						return [
							...msgs,
							{
								role: "user",
								content: messageContentToText(event.message.content),
								...(clientMessageId ? { clientMessageId } : {}),
							},
						];
					});
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
				case "decision_state":
					setPendingQuestion(event.question);
					setPendingPlanTransition(event.planTransition);
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
				case "agent_actor": {
					const status = event.actor.status === "success" ? "completed" : event.actor.status;
					setMessages((msgs) => [...msgs, { role: "warning", content: `${event.actor.agent} ${status}` }]);
					break;
				}
				case "assistant_message":
					promoteStreamingToHistory();
					break;
				case "steering_injected":
				case "followup_injected": {
					// The daemon owns the queue in thin-client mode. Mirror the local
					// loop's injection handling so the queued prompt appears in history
					// and its pending UI entry is removed when the daemon accepts it.
					promoteStreamingToHistory();
					setMessages((msgs) => {
						const injected = event.messages
							.filter((message) => {
								const clientMessageId = (message as Message & { castClientMessageId?: string })
									.castClientMessageId;
								if (!clientMessageId) return true;
								pendingServerMessagesRef.current.delete(clientMessageId);
								return !msgs.some((existing) => existing.clientMessageId === clientMessageId);
							})
							.map((message) => ({
								role: "user" as const,
								content: messageContentToText(message.content),
								clientMessageId: (message as Message & { castClientMessageId?: string }).castClientMessageId,
							}));
						return [...msgs, ...injected];
					});
					setError(null);
					if (event.type === "steering_injected") {
						setPendingSteers((pending) => pending.slice(event.messages.length));
					} else {
						setPendingQueue((pending) => pending.slice(event.messages.length));
					}
					break;
				}
				case "turn_meta":
					break;
				case "session_end":
					promoteStreamingToHistory();
					updateStreaming(() => null, true);
					setStreamingActive(false);
					setStatus("idle");
					// Daemon path never clears the live error on its own — a normal
					// completion must drop any stale one (compaction-failed, etc.).
					errorRef.current = null;
					setError(null);
					break;
				case "end":
					if (event.reason === "aborted") {
						setLastTurnAborted(true);
						setMessages((msgs) => [...msgs, { role: "warning", content: "[aborted]" }]);
					} else if (event.reason === "error") {
						// Turn-level error belongs in the transcript chronology, not as a
						// live sticky above the composer that never clears.
						commitTurnError(errorRef, setError, setMessages);
					} else if (event.reason !== "stop") {
						setError(event.reason);
					}
					break;
				case "error":
					errorRef.current = event.message;
					setError(event.message);
					break;
				case "compaction":
					refresh();
					break;
				default:
					break;
			}
		};
		return () => {
			disposed = true;
			source.close();
		};
	}, [
		isClient,
		effectiveDaemonUrl,
		effectiveDaemonToken,
		daemonOverride,
		session.id,
		promoteStreamingToHistory,
		updateStreaming,
		refresh,
		planState,
		onPlanSignal,
		serverClient,
	]);

	const steer = useCallback(
		(text: string) => {
			if (isClient && effectiveDaemonUrl) {
				if (!serverClient) return;
				void steerServerSession(serverClient, session.id, text)
					.then(() => setPendingSteers((p) => [...p, text]))
					.catch((err) => setError(err instanceof Error ? err.message : "Could not steer the daemon"));
				return;
			}
			runner.steeringQueue.enqueue({ role: "user", content: text });
			setPendingSteers((p) => [...p, text]);
		},
		[runner, isClient, effectiveDaemonUrl, session.id, serverClient],
	);

	const followUp = useCallback(
		(text: string) => {
			if (isClient && effectiveDaemonUrl) {
				if (!serverClient) return;
				void followUpServerSession(serverClient, session.id, text)
					.then(() => setPendingQueue((p) => [...p, text]))
					.catch((err) => setError(err instanceof Error ? err.message : "Could not queue follow-up"));
				return;
			}
			runner.followUpQueue.enqueue({ role: "user", content: text });
			setPendingQueue((p) => [...p, text]);
			// Do not rely only on the loop's final drain: a follow-up can arrive
			// between that drain and cleanup. The runner's idle promise is the
			// authoritative handoff point for the local TUI.
			void runner.waitForIdle().then(() => {
				if (runner.isRunning || !runner.followUpQueue.hasItems()) return;
				const queued = runner.followUpQueue.drain();
				const queuedText = queued
					.map((message) => messageContentToText(message.content))
					.filter(Boolean)
					.join("\n\n");
				setPendingQueue((pending) => pending.slice(queued.length));
				void submit(queuedText);
			});
		},
		[runner, isClient, effectiveDaemonUrl, session.id, serverClient, submit],
	);

	const abort = useCallback(() => {
		if (isClient && effectiveDaemonUrl) {
			if (!serverClient) return;
			void abortServerSession(serverClient, session.id)
				.then(() => {
					setPendingSteers([]);
					setPendingQueue([]);
				})
				.catch((err) => setError(err instanceof Error ? err.message : "Could not abort the daemon"));
			return;
		}
		runner.abort();
		// runner.abort() clears both queues (anything queued for this run is
		// moot once it's cancelled) — mirror that here so the UI doesn't keep
		// showing pending steer/follow-up entries that were just wiped.
		setPendingSteers([]);
		setPendingQueue([]);
	}, [runner, isClient, effectiveDaemonUrl, session.id, serverClient]);

	// Thin-client plan-decision plumbing: the daemon owns planState, so the
	// answer to its pending question (and the plan approval) must go back over
	// HTTP instead of mutating a local planState the way the local-loop path
	// does. No-ops in local mode — the App branches on daemonUrl and keeps the
	// planState path there.
	const answerQuestion = useCallback(
		(values: string[]) => {
			if (isClient && effectiveDaemonUrl) {
				if (!serverClient) return;
				void answerServerQuestion(serverClient, session.id, values)
					.then(() => setPendingQuestion(undefined))
					.catch((err) => setError(err instanceof Error ? err.message : "Could not answer the question"));
			}
		},
		[isClient, effectiveDaemonUrl, session.id, serverClient],
	);

	const approvePlan = useCallback(() => {
		if (isClient && effectiveDaemonUrl) {
			if (!serverClient) return;
			void resolveServerPlanTransition(serverClient, session.id)
				.then(() => setPendingPlanTransition(undefined))
				.catch((err) => setError(err instanceof Error ? err.message : "Could not approve the plan"));
		}
	}, [isClient, effectiveDaemonUrl, session.id, serverClient]);

	const setMode = useCallback(
		(mode: "plan" | "build") => {
			if (isClient && effectiveDaemonUrl) {
				if (!serverClient) return;
				void setServerMode(serverClient, session.id, mode).catch((err) =>
					setError(err instanceof Error ? err.message : "Could not change mode"),
				);
			}
		},
		[isClient, effectiveDaemonUrl, session.id, serverClient],
	);

	const cleanDaemonContext = useCallback(async (): Promise<string | undefined> => {
		if (!isClient || !effectiveDaemonUrl || !serverClient) return undefined;
		try {
			// clean-context returns the original task for the clean handoff.
			const { status, data } = await serverFetch(serverClient, `/api/sessions/${session.id}/clean-context`, {
				method: "POST",
			});
			if (status >= 400) return undefined;
			return (data as { originalTask?: string })?.originalTask;
		} catch {
			return undefined;
		}
	}, [isClient, effectiveDaemonUrl, session.id, serverClient]);

	const runCommand = useCallback(
		async (command: string): Promise<unknown> => {
			if (!isClient || !serverClient) throw new Error("No daemon is attached");
			return runServerCommand(serverClient, session.id, command);
		},
		[isClient, serverClient, session.id],
	);

	const forkCurrentSession = useCallback(async (): Promise<SessionState | undefined> => {
		if (isClient && effectiveDaemonUrl) {
			if (!serverClient) return undefined;
			return forkServerSession(serverClient, session.id);
		}
		return forkSession(session);
	}, [isClient, effectiveDaemonUrl, serverClient, session]);

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
		forkSession: forkCurrentSession,
		resetContext,
		refresh,
		refreshMeta,
		hasOlder,
		loadOlder,
		resetQueue,
		addDisplayMessage,
		pendingQuestion,
		pendingPlanTransition,
		answerQuestion,
		approvePlan,
		cleanDaemonContext,
		setMode,
		daemonConnected,
		daemonMode: isClient,
		runCommand,
		showReasoning,
		toggleReasoning,
		turnStartedAt,
		getElapsedMs,
	};
}
