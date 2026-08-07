/**
 * ACP adapter — owns one `AgentRunner` per session, translates `AgentEvent`
 * stream into SDK `sessionUpdate` notifications, and converts inbound SDK
 * requests (`prompt` / `cancel` / `set_session_mode`, etc.) into the
 * corresponding `runAgentLoop` / `AgentRunner` operations.
 */

import { SLASH_COMMANDS } from "../../ui/commands.ts";
import type { AgentEvent } from "../loop.ts";
import { runAgentLoop } from "../loop.ts";
import { closeMcpConnections, formatMcpForPrompt } from "../mcp.ts";
import { createPlanState, type PlanState, resolvePlanQuestion, resolvePlanTransition } from "../plan.ts";
import type { AgentRunner } from "../runner.ts";
import { createAgentRunner } from "../runner.ts";
import type { SessionState } from "../session.ts";
import { deleteSession, listSessions, loadSession, recordCompaction } from "../session.ts";
import type { StartupResult } from "../startup.ts";

// ---------------------------------------------------------------------------
// Adapter session
// ---------------------------------------------------------------------------

export interface AcpAdapterSession {
	state: SessionState;
	startup: StartupResult;
	runner: AgentRunner;
	planState: PlanState;
	/** Cumulative session cost in USD, accumulated across `usage` events. */
	totalCost: number;
	/** Last seen `usage` event payload. Re-emitted on mid-turn prompts so the
	 * editor's running-cost indicator updates even when the current turn
	 * hasn't finished and the next `usage` event is still pending. */
	lastUsage: { used: number; size: number } | null;
	/** Last `end` reason emitted by the loop (filled by translateEvent so the
	 * bridge can return the correct ACP stopReason on the PromptResponse). */
	lastEndReason: "stop" | "aborted" | "error" | "disconnected" | null;
	/** Open documents shared by the editor via `document/didOpen`. The
	 * contents are injected as a system-reminder block on every prompt so
	 * the model can see what's currently in the editor's buffer without
	 * having to call the `read` tool. Keyed by document URI (which editors
	 * usually use as `file://` URLs or absolute paths). */
	openDocuments: Map<string, { content: string; language?: string }>;
}

// ---------------------------------------------------------------------------
// Pending permissions
// ---------------------------------------------------------------------------

const _permissionResolvers = new Map<string, (granted: boolean) => void>();

// Active client connections per session (used for plan-picker notifications).
const sessionClients = new Map<string, { notify(method: string, params: unknown): Promise<void> }>();

// ---------------------------------------------------------------------------
// Adapter API
// ---------------------------------------------------------------------------

export interface AcpAdapterOptions {
	version: string;
	permissionMode: "bypass" | "default";
}

export interface AcpAdapter {
	initialize(params: unknown): {
		protocolVersion: number;
		agentCapabilities: unknown;
		agentInfo: { name: string; version: string };
	};
	newSession(startup: StartupResult, opts: AcpAdapterOptions): AcpAdapterSession;
	loadSession(
		sessionId: string,
		startup: StartupResult,
		opts: AcpAdapterOptions,
		client: { notify(method: string, params: unknown): Promise<void> },
	): AcpAdapterSession | null;
	closeSession(sessionId: string, sessions: Map<string, AcpAdapterSession>): Promise<void>;
	listSessions(params?: { cursor?: string | null; cwd?: string | null; limit?: number }): {
		sessions: Array<{ sessionId: string; cwd: string; title?: string }>;
		nextCursor?: string;
	};
	setSessionMode(
		modeId: string,
		session: AcpAdapterSession,
		client?: { notify(method: string, params: unknown): Promise<void> },
	): Record<string, never>;
	submitPrompt(
		sessionId: string,
		prompt: Array<{ type: string; text?: string | null; data?: string | null; mimeType?: string | null }>,
		session: AcpAdapterSession,
		client: {
			notify(method: string, params: unknown): Promise<void>;
			request(method: string, params: unknown): Promise<unknown>;
		},
		opts: AcpAdapterOptions,
	): Promise<{ stopReason: string; usage?: unknown }>;
	cancel(session: AcpAdapterSession): void;
	/** Record an editor buffer shared via `document/didOpen`. Replaces any
	 * prior entry for the same URI — editors typically send one
	 * `didChange` per keystroke and we'd otherwise churn the Map. */
	openDocument(session: AcpAdapterSession, uri: string, content: string, language?: string): void;
	/** Editor reports a buffer update via `document/didChange`. */
	updateDocument(session: AcpAdapterSession, uri: string, content: string): void;
	/** Editor reports a buffer closed via `document/didClose`. */
	closeDocument(session: AcpAdapterSession, uri: string): void;
	/** User answered a plan question the bridge surfaced via `request_question`. */
	answerQuestion(
		sessionId: string,
		answers: string[],
		session: AcpAdapterSession,
		client: {
			notify(method: string, params: unknown): Promise<void>;
			request(method: string, params: unknown): Promise<unknown>;
		},
	): Promise<void>;
	/** User reviewed the plan transition the bridge surfaced via `request_plan_approval`. */
	planReview(sessionId: string, choice: "continue" | "retry" | "clean", session: AcpAdapterSession): Promise<void>;
}

export function createAcpAdapter(options: AcpAdapterOptions): AcpAdapter {
	const { version } = options;

	return {
		initialize: () => ({
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { audio: false, embeddedContext: true, image: true },
				mcpCapabilities: { http: false, sse: false },
				// `fork` and `resume` are intentionally omitted — cast has no
				// fork semantics, and session/resume is implemented as a
				// synonym of session/load on the SDK handler side, so listing
				// it as a distinct capability would mislead the editor into
				// showing it as a separate UI affordance.
				sessionCapabilities: { close: {}, list: {} },
			},
			agentInfo: { name: "cast", version },
		}),

		newSession: (startup, _opts): AcpAdapterSession => {
			const session = startup.session;
			const runner: AgentRunner = createAgentRunner();
			const planState = createPlanState(startup.cwd, session.id, {
				onChange: (question, transition) => {
					startup.session.planQuestion = question;
					startup.session.planTransition = transition;
					const acpClient = sessionClients.get(startup.session.id);
					if (question) {
						acpClient
							?.notify("request_question", {
								sessionId: startup.session.id,
								questions: question.questions.map((q) => ({
									question: q.question,
									options: q.options,
								})),
							})
							.catch(() => {});
					}
					if (transition) {
						acpClient
							?.notify("request_plan_approval", {
								sessionId: startup.session.id,
								kind: transition.kind,
							})
							.catch(() => {});
					}
				},
			});
			return {
				state: session,
				startup,
				runner,
				planState,
				totalCost: 0,
				lastUsage: null,
				lastEndReason: null,
				openDocuments: new Map(),
			};
		},

		loadSession: (sessionId: string, _startup, _opts, client): AcpAdapterSession | null => {
			const state = loadSession(sessionId);
			if (!state) return null;
			const runner: AgentRunner = createAgentRunner();
			const planState = createPlanState(state.cwd ?? "", state.id);
			// ACP v1 spec: agents should replay prior history as `session/update`
			// notifications so the editor sees the conversation when the
			// session opens. We only have text-only user/assistant messages in
			// `state.messages` (cast doesn't persist tool_call events) so the
			// replay is a flat stream of `user_message_chunk` /
			// `agent_message_chunk` updates in chronological order.
			void replaySessionHistory(state, client);
			return {
				state,
				startup: _startup,
				runner,
				planState,
				totalCost: 0,
				lastUsage: null,
				lastEndReason: null,
				openDocuments: new Map(),
			};
		},

		closeSession(sessionId: string, sessions: Map<string, AcpAdapterSession>): Promise<void> {
			const s = sessions.get(sessionId);
			if (s) {
				s.runner.abort("acp close");
				closeMcpConnections(s.startup.mcpResult.connections);
				sessions.delete(sessionId);
			}
			deleteSession(sessionId);
			// Wait for the runner to settle before returning so the editor can
			// assume the session is fully torn down on close — no straggling
			// `session/update` events arriving after the response. `waitForIdle`
			// resolves immediately when `isRunning` is already false, so the
			// happy path stays cheap.
			return s ? s.runner.waitForIdle() : Promise.resolve();
		},

		listSessions: (params?: { cursor?: string | null; cwd?: string | null; limit?: number }) => {
			const all = listSessions();
			// Optional cwd filter — a strict prefix match is enough since cast
			// sessions store the cwd they were created with.
			const filtered = params?.cwd ? all.filter((s) => (s.cwd ?? "").startsWith(params.cwd!)) : all;
			// Cursor encodes the next offset as the sessionId at that index.
			// Using sessionId (not numeric offset) is stable across re-sorts.
			// Cursor is the sessionId at the start of the next page — the
			// editor passes back whatever sessionId we gave it as the previous
			// nextCursor. Stable across re-sorts (we don't re-sort here) and
			// across listSessions() calls because sessionId is unique.
			const limit = params?.limit ?? 100;
			const startIndex = params?.cursor ? filtered.findIndex((s) => s.id === params.cursor) : 0;
			const page = startIndex >= 0 ? filtered.slice(startIndex, startIndex + limit) : [];
			const next = filtered.length > startIndex + limit ? filtered[startIndex + limit]?.id : undefined;
			return {
				sessions: page.map((s) => ({
					sessionId: s.id,
					cwd: s.cwd ?? "",
					title: s.cwd ?? s.id.substring(0, 16),
				})),
				...(next ? { nextCursor: next } : {}),
			};
		},

		setSessionMode: (modeId: string, session, client) => {
			const { state, planState } = session;
			if (modeId === "plan" || modeId === "build") {
				planState.enabled = modeId === "plan";
				if (state.mode && modeId !== state.mode) {
					state.planQuestion = undefined;
					state.planTransition = undefined;
				}
				state.mode = modeId;
				// Tell the editor the mode flipped — UI controls (mode picker,
				// toolset visibility) re-render without waiting for the next
				// tool call. Best-effort: a notification failure shouldn't
				// fail the request itself.
				client
					?.notify("session/update", {
						sessionId: session.state.id,
						update: { sessionUpdate: "current_mode_update", modeId },
					})
					.catch(() => {});
				return {};
			}
			return {};
		},

		submitPrompt: async (sessionId, promptContent, session, client, opts) => {
			sessionClients.set(session.state.id, client);
			emitAvailableCommands(session, client);
			const { runner } = session;
			const text = promptContentToText(promptContent);
			const message = promptContentToMessage(sessionId, promptContent);

			if (text.trim() === "/abort") {
				runner.abort("acp /abort");
				return { stopReason: "cancelled" };
			}
			if (runner.isRunning) {
				runner.followUpQueue.enqueue(message);
				// Re-emit the last usage snapshot so the editor's running-cost
				// indicator advances even though no new model call has run yet.
				if (session.lastUsage) {
					client
						.notify("session/update", {
							sessionId: session.state.id,
							update: {
								sessionUpdate: "usage_update",
								used: session.lastUsage.used,
								size: session.lastUsage.size,
								cost: { amount: session.totalCost, currency: "USD" },
							},
						})
						.catch(() => {});
				}
				return { stopReason: "end_turn" };
			}
			injectOpenDocumentsAsContext(session);
			session.lastEndReason = null;
			await runPromptInner(session, opts.permissionMode, message, client);
			return { stopReason: loopReasonToStopReason(session.lastEndReason) };
		},

		cancel: (session): void => {
			session.runner.abort("acp cancel");
		},

		openDocument: (session, uri, content, language) => {
			session.openDocuments.set(uri, { content, language });
		},

		updateDocument: (session, uri, content) => {
			const existing = session.openDocuments.get(uri);
			if (!existing) {
				// Editor sent didChange for a file we never saw didOpen for —
				// accept it anyway. This handles editor reconnects that
				// re-send state without a prior open.
				session.openDocuments.set(uri, { content });
				return;
			}
			existing.content = content;
		},

		closeDocument: (session, uri) => {
			session.openDocuments.delete(uri);
		},

		answerQuestion: async (_sessionId, answers, session) => {
			const { state, planState } = session;
			if (!state.planQuestion) return;
			const questions = state.planQuestion.questions;
			const selected = questions.map((item, index) =>
				item.options.find((option) => option.value === answers[index]),
			);
			if (selected.some((option) => !option)) return;
			resolvePlanQuestion(planState);
			state.planQuestion = undefined;
			const body = questions
				.map((item, index) => `Question: ${item.question} Answer: ${selected[index]!.label}`)
				.join("\n");
			session.runner.steeringQueue.enqueue({ role: "user", content: body });
		},

		planReview: async (_sessionId, choice, session) => {
			const { state, planState } = session;
			if (!state.planTransition) return;
			resolvePlanTransition(planState);
			state.planTransition = undefined;
			state.planQuestion = undefined;
			if (choice === "retry") return;
			if (choice === "clean") {
				state.todos = [];
				state.messages = [];
			}
			state.mode = "build";
			planState.enabled = false;
			const reminder =
				choice === "clean"
					? "<system-reminder>Clean build context.</system-reminder>\n\nThe plan is approved. Implement it step by step."
					: "The plan is approved. Implement it step by step.";
			session.runner.steeringQueue.enqueue({ role: "user", content: reminder });
		},
	};
}

// ---------------------------------------------------------------------------
// runAgentLoop wrapper
// ---------------------------------------------------------------------------

async function runPromptInner(
	session: AcpAdapterSession,
	permissionMode: "bypass" | "default",
	promptMessage: { role: "user"; content: unknown },
	client: {
		notify(method: string, params: unknown): Promise<void>;
		request(method: string, params: unknown): Promise<unknown>;
	},
): Promise<void> {
	const { startup, runner, state, planState } = session;
	const { appendMessage, saveSession } = await import("../session.ts");
	// Pre-loop: append the user prompt and persist before runAgentLoop — the
	// loop reads `state.messages` directly and pushes the assistant/tool
	// messages into the same array, so the user's turn must be present
	// before the LLM call starts (otherwise the first request goes out with
	// an empty prompt and the provider rejects it).
	appendMessage(state, promptMessage as Parameters<typeof appendMessage>[1]);
	saveSession(state);
	const ac = new AbortController();
	runner.startRun(ac);
	try {
		const finalMessages = await runAgentLoop(state.messages, {
			config: startup.config,
			model: state.model,
			cwd: state.cwd ?? startup.cwd,
			systemPrompt: startup.systemPrompt,
			signal: ac.signal,
			steeringQueue: runner.steeringQueue,
			followUpQueue: runner.followUpQueue,
			confirmBash:
				permissionMode === "bypass"
					? undefined
					: (command: string, reason: string) => requestPermissionViaBridge(client, command, reason),
			confirmWrite:
				permissionMode === "bypass"
					? undefined
					: (tool: string, path: string, reason: string) =>
							requestWritePermissionViaBridge(client, tool, path, reason),
			mcpTools: startup.mcpResult.toolDefinitions,
			mcpToolIndex: startup.mcpResult.toolIndex,
			hooks: startup.hooks,
			sessionId: state.id,
			permissionMode: startup.permissionMode,
			skills: startup.skills,
			lastPromptTokens: state.lastPromptTokens,
			personas: startup.personas,
			currentPersona: startup.persona.name,
			subagentPrompts: startup.subagentPrompts,
			subagentModel: startup.subagentModel,
			planState,
			mcpPromptSuffix: formatMcpForPrompt(startup.mcpResult),
			initialTodos: state.todos,
			onCompaction: (full, compacted) => recordCompaction(state, full, compacted),
			onEvent: (event) => translateEvent(event, client, session),
		});
		// runAgentLoop returns the final messages array (assistant + tool
		// turns appended). Reassign so the next session/load replay sees
		// the full conversation, then persist.
		state.messages = finalMessages;
		saveSession(state);
	} finally {
		runner.endRun();
	}
}

export async function requestPermissionViaBridge(
	client: {
		request(method: string, params: unknown): Promise<unknown>;
	},
	command: string,
	reason: string,
): Promise<boolean> {
	// Session-scoped memory: if the user previously said "allow always" or
	// "reject always" for the same command + reason pair, reuse that verdict
	// without bothering the editor. Cleared when the session is closed.
	const memo = alwaysVerdict.get(client);
	if (memo) {
		const verdict = memo.get(`${command}\u0000${reason}`);
		if (verdict !== undefined) return verdict;
	}
	const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const TIMEOUT_MS = 60_000;
	try {
		const outcome: unknown = await Promise.race([
			client.request("session/request_permission", {
				toolCall: {
					toolCallId: requestId,
					title: "bash",
					kind: "execute",
					status: "pending",
					rawInput: { command },
				},
				options: [
					{ kind: "allow_once", name: "Allow once", optionId: "allow_once" },
					{ kind: "allow_always", name: "Allow for this session", optionId: "allow_always" },
					{ kind: "reject_once", name: "Reject", optionId: "reject_once" },
					{ kind: "reject_always", name: "Reject for this session", optionId: "reject_always" },
				],
			}),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS)),
		]);
		if (outcome === "timeout") return false;
		const response = outcome as { outcome: { outcome: string; optionId?: string } };
		if (response.outcome.outcome !== "selected") return false;
		const opt = response.outcome.optionId;
		const granted = opt === "allow_once" || opt === "allow_always";
		if (opt === "allow_always" || opt === "reject_always") {
			const store = alwaysVerdict.get(client) ?? new Map<string, boolean>();
			store.set(`${command}\u0000${reason}`, granted);
			alwaysVerdict.set(client, store);
		}
		return granted;
	} catch {
		return false;
	}
}

// Per-client memoization of "allow always" / "reject always" decisions.
// Keyed by the client object identity so a fresh connection starts empty.
const alwaysVerdict = new WeakMap<
	{ request(method: string, params: unknown): Promise<unknown> },
	Map<string, boolean>
>();

/** Permission flow for destructive file tools. Same shape as the bash flow:
 *  emit a typed `session/request_permission` request with four options and a
 *  60 s timeout, then interpret the verdict. We share the
 *  `alwaysVerdict` memo across bash and write decisions — anything the user
 *  said "always" to applies for the rest of the session. */
export async function requestWritePermissionViaBridge(
	client: { request(method: string, params: unknown): Promise<unknown> },
	tool: string,
	path: string,
	reason: string,
): Promise<boolean> {
	const memo = alwaysVerdict.get(client);
	if (memo) {
		const verdict = memo.get(`${tool}\u0000${path}\u0000${reason}`);
		if (verdict !== undefined) return verdict;
	}
	const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const TIMEOUT_MS = 60_000;
	try {
		const outcome: unknown = await Promise.race([
			client.request("session/request_permission", {
				toolCall: {
					toolCallId: requestId,
					title: tool,
					kind: "edit",
					status: "pending",
					rawInput: { path },
				},
				options: [
					{ kind: "allow_once", name: "Allow once", optionId: "allow_once" },
					{ kind: "allow_always", name: "Allow for this session", optionId: "allow_always" },
					{ kind: "reject_once", name: "Reject", optionId: "reject_once" },
					{ kind: "reject_always", name: "Reject for this session", optionId: "reject_always" },
				],
			}),
			new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), TIMEOUT_MS)),
		]);
		if (outcome === "timeout") return false;
		const response = outcome as { outcome: { outcome: string; optionId?: string } };
		if (response.outcome.outcome !== "selected") return false;
		const opt = response.outcome.optionId;
		const granted = opt === "allow_once" || opt === "allow_always";
		if (opt === "allow_always" || opt === "reject_always") {
			const store = alwaysVerdict.get(client) ?? new Map<string, boolean>();
			store.set(`${tool}\u0000${path}\u0000${reason}`, granted);
			alwaysVerdict.set(client, store);
		}
		return granted;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

export function translateEvent(
	event: AgentEvent,
	client: { notify(method: string, params: unknown): Promise<void> },
	session: AcpAdapterSession,
): void {
	const notify = (update: Record<string, unknown>) =>
		client.notify("session/update", { sessionId: session.state.id, update }).catch(() => {});

	switch (event.type) {
		case "token":
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
			return;
		case "thinking":
			notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
			return;
		case "tool_start":
			notify({ sessionUpdate: "tool_call", ...toAcpTool(event) } as never);
			return;
		case "tool_end": {
			const payload: Record<string, unknown> = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.id,
				status: event.result.isError ? "failed" : "completed",
			};
			if (event.result.isError) {
				payload.error = event.result.content;
			} else {
				// ACP v1 ContentChunk — the editor renders each chunk as a
				// node in the tool result. Cast's loop returns a single text
				// blob for now; future tool results with image content
				// (vision-capable tools) would emit multiple chunks here.
				payload.content = [{ type: "text", text: event.result.content }];
			}
			client.notify("session/update", { sessionId: session.state.id, update: payload }).catch(() => {});
			return;
		}
		case "assistant_message":
			notify({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: event.content },
				isFinal: true,
			} as never);
			return;
		case "usage": {
			const used = event.usage.totalTokens;
			const size = session.startup.config.contextWindow;
			session.totalCost += event.usage.cost ?? 0;
			session.lastUsage = { used, size };
			notify({
				sessionUpdate: "usage_update",
				used,
				size,
				cost: { amount: session.totalCost, currency: "USD" },
			} as never);
			return;
		}
		case "end": {
			// The AgentEvent union declares `reason: string` even though every
			// site in loop.ts emits one of these four literals; cast through
			// unknown to preserve the wider upstream type without forcing
			// loop.ts to tighten its own union.
			session.lastEndReason = event.reason as "stop" | "aborted" | "error" | "disconnected";
			notify({ sessionUpdate: "session_end", reason: event.reason } as never);
			return;
		}
		case "error":
			notify({ sessionUpdate: "session_error", message: event.message } as never);
			return;
		case "turn_end":
			notify({ sessionUpdate: "turn_end", toolResults: event.toolResults } as never);
			return;
		case "compaction":
			notify({
				sessionUpdate: "info",
				kind: "compaction",
				messagesCompacted: event.messagesCompacted,
				tokensBefore: event.tokensBefore,
			} as never);
			return;
		case "compaction_failed":
			notify({ sessionUpdate: "info", kind: "compaction_failed", reason: event.reason } as never);
			return;
		case "interrupt_reminder":
			notify({ sessionUpdate: "info", kind: "interrupt_reminder" } as never);
			return;
		case "todos_updated":
			notify({ sessionUpdate: "info", kind: "todos_updated", todos: event.todos } as never);
			return;
		case "date_rollover":
			notify({ sessionUpdate: "info", kind: "date_rollover", date: event.date } as never);
			return;
		case "retry":
			notify({ sessionUpdate: "info", kind: "retry", attempt: event.attempt, reason: event.reason } as never);
			return;
		case "doom_loop":
			notify({ sessionUpdate: "info", kind: "doom_loop", tool: event.tool, attempts: event.attempts } as never);
			return;
		case "open_work_gate":
		case "open_work_gate_exhausted":
		case "tool_result_truncated":
		case "steering_injected":
		case "followup_injected":
			return;
		default:
			return;
	}
}

function toAcpTool(event: Extract<AgentEvent, { type: "tool_start" }>) {
	let summary: string | undefined;
	let input: Record<string, unknown> | undefined;
	try {
		input = JSON.parse(event.args) as Record<string, unknown>;
	} catch {
		summary = event.name;
	}
	if (input) {
		const keys = Object.keys(input).slice(0, 3);
		summary = [event.name, ...keys.map((k) => `${k}=…`)].join(" ");
	}
	// ACP kind constants: "read", "edit", "execute", "search", "delete"
	const kindMap: Record<string, string> = {
		bash: "execute",
		read: "read",
		write: "edit",
		edit: "edit",
		grep: "search",
		glob: "search",
		web_fetch: "search",
		web_search: "search",
		patch: "edit",
	};
	// Title normalizer — editors use the title in the tool-call pill UI.
	// The raw tool name is a verb (`bash`, `read`) but the title should
	// read as a noun phrase that describes what the user sees happening.
	const titleMap: Record<string, string> = {
		bash: "Run bash command",
		read: "Read file",
		write: "Write file",
		edit: "Edit file",
		patch: "Apply patch",
		grep: "Search in files",
		glob: "Find files",
		web_fetch: "Fetch URL",
		web_search: "Web search",
	};
	// Path-shaped tools get `locations` so editors can highlight or jump to
	// the file being touched. Different tools use different key names.
	const pathKeys = ["path", "file_path", "target_path", "filepath"];
	const toolPath = input ? pathKeys.map((k) => input[k]).find((v) => typeof v === "string") : undefined;
	const locations = typeof toolPath === "string" ? [{ path: toolPath }] : undefined;
	return {
		toolCallId: event.id,
		title: titleMap[event.name] ?? event.name,
		kind: kindMap[event.name] ?? event.name,
		summary,
		status: "pending" as const,
		rawInput: input ?? {},
		...(locations ? { locations } : {}),
	};
}

// Strip leading `/` — ACP `name` is a verb like `compact`, not `/compact`.
const SLASH_PREFIX_RE = /^\//;

function emitAvailableCommands(
	session: AcpAdapterSession,
	client: { notify(method: string, params: unknown): Promise<void> },
): void {
	const availableCommands = SLASH_COMMANDS.map((cmd) => {
		// Strip leading `/` — ACP `name` is a verb like `compact`, not `/compact`.
		const name = cmd.name.replace(SLASH_PREFIX_RE, "");
		// Subcommand variants like `/hooks disable` get exposed as parent command
		// entries whose description hints the subcommand form — clients that
		// understand `input.hint` use it as a placeholder text.
		return {
			name,
			description: cmd.description,
			input: cmd.takesArgs
				? { hint: name === "hooks" ? "disable <id>" : name === "mcp" ? "disable <name>" : "args" }
				: null,
		};
	});
	client
		.notify("session/update", {
			sessionId: session.state.id,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands,
			},
		})
		.catch(() => {});
}

/** Push the editor's open-document contents into `state.messages` as a
 * system-reminder so the next LLM call sees them in context. Editors
 * using `embeddedContext: true` send `document/didOpen` for every file
 * the user has open in their buffer; without this injection the model
 * would only know about files it has explicitly `read`.
 *
 * Implementation detail: we replace (rather than append) any previous
 * reminder so the message array doesn't grow unboundedly with each
 * prompt. The latest snapshot always wins. */
function injectOpenDocumentsAsContext(session: AcpAdapterSession): void {
	if (session.openDocuments.size === 0) return;
	const docs = [...session.openDocuments.entries()];
	const reminder = [
		"<system-reminder>",
		"The following files are currently open in the editor. Treat their contents as part of the conversation context.",
		"",
		...docs.map(([uri, doc]) => {
			const lang = doc.language ? ` (${doc.language})` : "";
			return `### ${uri}${lang}\n\`\`\`\n${doc.content}\n\`\`\``;
		}),
		"</system-reminder>",
	].join("\n");
	// Drop any previous open-doc reminder we injected — only the latest
	// snapshot is useful, and we don't want stale buffers leaking into
	// later turns after the user closes a file.
	const { state } = session;
	const last = state.messages[state.messages.length - 1];
	if (
		last &&
		last.role === "user" &&
		typeof last.content === "string" &&
		last.content.startsWith("<system-reminder>") &&
		last.content.includes("currently open in the editor")
	) {
		state.messages.pop();
	}
	state.messages.push({ role: "user", content: reminder });
}

function promptContentToText(content: Array<{ type: string; text?: string | null }>): string {
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text" && part.text) parts.push(part.text);
	}
	return parts.join("\n");
}

/** Map the loop's internal `end` reason to the ACP `StopReason` union.
 * `null` (no end event yet — mid-turn enqueue or loop exited cleanly
 * without emitting `end`) defaults to `end_turn` since the bridge
 * can't tell otherwise. */
function loopReasonToStopReason(
	reason: AcpAdapterSession["lastEndReason"],
): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" {
	switch (reason) {
		case "stop":
			return "end_turn";
		case "aborted":
		case "disconnected":
			return "cancelled";
		case "error":
			return "refusal";
		default:
			return "end_turn";
	}
}

/**
 * Convert ACP `PromptRequest.prompt[]` content blocks into a single
 * `Message` (OpenAI `ChatCompletionMessageParam`) suitable for
 * `runAgentLoop` / `appendMessage`. ACP v1 allows text + image + audio +
 * embedded resources; cast's `runAgentLoop` understands `text` and
 * `image_url` parts (the loop already strips image_url from messages when
 * the model doesn't support vision — see `loop.ts:1173`).
 *
 * - `text` → string content parts (concatenated).
 * - `image` (base64 + mimeType) → `image_url` data URL.
 * - `audio`/`resource_link`/`resource` → currently ignored with a no-op text
 *   marker so the model at least knows something was dropped; cast has no
 *   audio/tool-result ingestion path through ACP yet.
 */
type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

function promptContentToMessage(
	sessionId: string,
	content: Array<{
		type: string;
		text?: string | null;
		data?: string | null;
		mimeType?: string | null;
	}>,
): { role: "user"; content: ContentPart[] } {
	const parts: ContentPart[] = [];
	const dropped: string[] = [];
	for (const block of content) {
		if (block.type === "text") {
			if (block.text) parts.push({ type: "text", text: block.text });
			continue;
		}
		if (block.type === "image" && block.data && block.mimeType) {
			parts.push({
				type: "image_url",
				image_url: { url: `data:${block.mimeType};base64,${block.data}` },
			});
			continue;
		}
		dropped.push(block.type);
	}
	if (dropped.length > 0) {
		parts.push({
			type: "text",
			text: `[ACP: dropped unsupported content blocks for session ${sessionId}: ${dropped.join(", ")}]`,
		});
	}
	return { role: "user", content: parts };
}

/**
 * Replay `state.messages` to the client as `session/update` notifications.
 * Cast's `SessionState` only persists user/assistant text messages (not the
 * tool_call events), so the replay is a straight chronological dump:
 * - user message → `user_message_chunk`
 * - assistant message → `agent_message_chunk` (with `isFinal: true`)
 *
 * Fire-and-forget — the SDK buffers notifications on the duplex stream and
 * the client renders them as they arrive. Errors are swallowed: the
 * `session/load` response must not be blocked by replay failures.
 */
async function replaySessionHistory(
	state: SessionState,
	client: { notify(method: string, params: unknown): Promise<void> },
): Promise<void> {
	for (const message of state.messages) {
		try {
			if (message.role === "user") {
				const content = normalizeMessageContent(message.content);
				if (!content) continue;
				// Sequential notify is intentional — replay must restore
				// messages in chronological order; parallel emits would
				// interleave and break the editor's UI rendering.
				// biome-ignore lint/performance/noAwaitInLoops: see above.
				await client.notify("session/update", {
					sessionId: state.id,
					update: {
						sessionUpdate: "user_message_chunk",
						content: { type: "text", text: content },
					},
				});
			} else if (message.role === "assistant") {
				const content = normalizeMessageContent(message.content);
				if (!content) continue;
				await client.notify("session/update", {
					sessionId: state.id,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: content },
						isFinal: true,
					},
				});
			}
		} catch {
			// Swallow — replay is best-effort; the session/load response is
			// what the editor is waiting on.
		}
	}
}

function normalizeMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) => {
			if (p && typeof p === "object" && "type" in p && p.type === "text" && "text" in p) {
				return typeof p.text === "string" ? p.text : "";
			}
			// Other content part types (image_url, refusal, etc.) aren't sent
			// through ACP text replays — the editor only has streaming text.
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

export { closeMcpConnections };
