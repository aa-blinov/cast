/**
 * ACP adapter — owns one `AgentRunner` per session, translates `AgentEvent`
 * stream into SDK `sessionUpdate` notifications, and converts inbound SDK
 * requests (`prompt` / `cancel` / `set_session_mode`, etc.) into the
 * corresponding `runAgentLoop` / `AgentRunner` operations.
 */

import type * as acpSdk from "@agentclientprotocol/sdk";
import { SLASH_COMMANDS } from "../../ui/commands.ts";
import type { AgentEvent } from "../loop.ts";
import { runAgentLoop } from "../loop.ts";
import {
	closeMcpConnections,
	connectMcpServers,
	formatMcpForPrompt,
	type McpServerConfig,
	type McpSetupResult,
} from "../mcp.ts";
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
	/** MCP servers the editor passed in `session/new.mcpServers`. Filled
	 * lazily on the first prompt of a session; tools are merged with
	 * startup's MCP pool for the duration of the run. Connections are
	 * closed when the session ends. */
	clientMcpResult: McpSetupResult | null;
	/** Set after the first `available_commands_update` notification has
	 * been sent for this session. The slash command list is stable across
	 * prompts within a session, so we only need to ship it once —
	 * emitting on every prompt would burn a frame every turn. */
	commandsEmitted: boolean;
}

// ---------------------------------------------------------------------------
// Active client connections per session (used for plan-picker notifications).
// ---------------------------------------------------------------------------
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
	newSession(
		startup: StartupResult,
		opts: AcpAdapterOptions,
		mcpServers?: Array<{
			name: string;
			type?: string;
			url?: string;
			headers?: Array<{ name: string; value: string }>;
		}>,
	): Promise<AcpAdapterSession>;
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
				// We accept http + sse MCP servers passed via session/new.
				// stdio and the experimental "acp" variant are rejected —
				// spawning local processes from a remote editor is a
				// security risk we don't want to enable by default.
				mcpCapabilities: { http: true, sse: true },
				// `fork` and `resume` are intentionally omitted — cast has no
				// fork semantics, and session/resume is implemented as a
				// synonym of session/load on the SDK handler side, so listing
				// it as a distinct capability would mislead the editor into
				// showing it as a separate UI affordance.
				sessionCapabilities: { close: {}, list: {} },
			},
			agentInfo: { name: "cast", version },
		}),

		newSession: async (startup, _opts, mcpServers): Promise<AcpAdapterSession> => {
			const session = startup.session;
			const runner: AgentRunner = createAgentRunner();
			// Connect client-provided MCP servers in parallel with session
			// setup. Anything that fails to connect (network error, bad URL)
			// is logged in diagnostics and skipped — the session still starts
			// with whatever did succeed. The connections live for the lifetime
			// of this session and are torn down on close.
			let clientMcpResult: McpSetupResult | null = null;
			if (mcpServers && mcpServers.length > 0) {
				const config = mcpServersToConfig(mcpServers);
				clientMcpResult = await connectMcpServers(config);
			}
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
				clientMcpResult,
				commandsEmitted: false,
			};
		},

		loadSession: (sessionId: string, _startup, _opts, client): AcpAdapterSession | null => {
			const state = loadSession(sessionId);
			if (!state) return null;
			const runner: AgentRunner = createAgentRunner();
			// Mirror the newSession's planState wiring — without onChange,
			// plan pickers would silently fail in resumed sessions because
			// createPlanState can only notify the editor via the callback.
			const planState = createPlanState(state.cwd ?? "", state.id, {
				onChange: (question, transition) => {
					state.planQuestion = question;
					state.planTransition = transition;
					if (question) {
						client
							?.notify("request_question", {
								sessionId: state.id,
								questions: question.questions.map((q) => ({
									question: q.question,
									options: q.options,
								})),
							})
							.catch(() => {});
					}
					if (transition) {
						client
							?.notify("request_plan_approval", {
								sessionId: state.id,
								kind: transition.kind,
							})
							.catch(() => {});
					}
				},
			});
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
				clientMcpResult: null,
				commandsEmitted: false,
			};
		},

		closeSession(sessionId: string, sessions: Map<string, AcpAdapterSession>): Promise<void> {
			const s = sessions.get(sessionId);
			if (s) {
				s.runner.abort("acp close");
				// MCP cleanup runs in try/finally so even if deleteSession below
				// throws (DB error mid-shutdown), the connections are torn down
				// — otherwise we'd leak file descriptors / subprocess handles.
				try {
					closeMcpConnections(s.startup.mcpResult.connections);
					if (s.clientMcpResult) {
						closeMcpConnections(s.clientMcpResult.connections);
					}
				} finally {
					// Drop any open-document buffers. The adapter session is
					// about to be destroyed; a subsequent session/load with
					// the same id would otherwise see stale buffers in the
					// cache (the Map is per-session, but the test setup
					// reuses `session` objects).
					s.openDocuments.clear();
					sessions.delete(sessionId);
				}
			}
			try {
				deleteSession(sessionId);
			} catch {
				// Best-effort — DB delete failure shouldn't abort the rest of
				// teardown. The session row may persist as an orphan on disk
				// but the MCP connections are already closed.
			}
			// Wait for the runner to settle before returning so the editor can
			// assume the session is fully torn down on close — no straggling
			// `session/update` events arriving after the response. `waitForIdle`
			// resolves immediately when `isRunning` is already false, so the
			// happy path stays cheap.
			return s ? s.runner.waitForIdle() : Promise.resolve();
		},

		listSessions: (params?: { cursor?: string | null; cwd?: string | null; limit?: number }) => {
			const all = listSessions();
			// Exact match on cwd — `startsWith` would over-include (e.g. a
			// filter for /proj would match /projects/a). Editors asking for
			// "sessions for this exact project" want the sessionId back, not
			// every session whose cwd happens to share a prefix.
			const filtered = params?.cwd ? all.filter((s) => s.cwd === params.cwd) : all;
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
			if (modeId !== "plan" && modeId !== "build") {
				// Surface unknown modes as JSON-RPC -32602 (InvalidParams) so
				// the editor's UI can show a meaningful error instead of
				// silently accepting a no-op. The SDK converts this thrown
				// error into the wire-format `error` response automatically.
				throw new Error(`Invalid session mode '${modeId}' — expected 'plan' or 'build'`);
			}
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
		},

		submitPrompt: async (sessionId, promptContent, session, client, opts) => {
			sessionClients.set(session.state.id, client);
			// Slash command list is stable across prompts — only ship it on the
			// first prompt of each session. Subsequent prompts re-use the
			// already-emitted list; the editor keeps it in its own UI state.
			if (!session.commandsEmitted) {
				emitAvailableCommands(session, client);
				session.commandsEmitted = true;
			}
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
			mcpTools: mergedMcpTools(session),
			mcpToolIndex: mergedMcpToolIndex(session),
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
			mcpPromptSuffix: formatMcpForPrompt(mergedMcp(session)),
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

/** Minimal runtime validator for ACP `RequestPermissionResponse` — keeps
 * the bridge from crashing if the editor sends a malformed payload.
 * The SDK's zod schema does this for typed requests, but we receive
 * the response as `unknown` via the generic `request(method, params)`
 * overload, so we re-validate here. */
function isPermissionResponse(x: unknown): x is { outcome: { outcome: string; optionId?: string } } {
	if (typeof x !== "object" || x === null) return false;
	const o = (x as { outcome?: unknown }).outcome;
	if (typeof o !== "object" || o === null) return false;
	const inner = (o as { outcome?: unknown }).outcome;
	if (typeof inner !== "string") return false;
	const optId = (o as { optionId?: unknown }).optionId;
	if (optId !== undefined && typeof optId !== "string") return false;
	return true;
}

/** Build a unique request ID for permission round-trips. Shared helper so
 * bash and write flows format IDs identically (useful for log grep). */
function makePermissionRequestId(): string {
	return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
	const requestId = makePermissionRequestId();
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
		if (!isPermissionResponse(outcome)) return false;
		if (outcome.outcome.outcome !== "selected") return false;
		const opt = outcome.outcome.optionId;
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
	const requestId = makePermissionRequestId();
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
		if (!isPermissionResponse(outcome)) return false;
		if (outcome.outcome.outcome !== "selected") return false;
		const opt = outcome.outcome.optionId;
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
	// Typed update sender — captures the spec's `SessionUpdate` union so
	// command sites get full type checking instead of having to `as never`
	// past the SDK's generic notify. The wider `parameters` field at
	// the call site carries the session-id baggage every update needs.
	const notify = (update: acpSdk.SessionUpdate) =>
		client
			.notify("session/update", { sessionId: session.state.id, update } as unknown as {
				sessionId: string;
				update: acpSdk.SessionUpdate;
			})
			.catch(() => {});

	switch (event.type) {
		case "token":
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } });
			return;
		case "thinking":
			notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } });
			return;
		case "tool_start":
			notify({ sessionUpdate: "tool_call", ...toAcpTool(event) } as unknown as acpSdk.SessionUpdate);
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
				// node in the tool result. Cast's `read` tool returns
				// `imageDataUrl` for image files; surface that as an image
				// chunk alongside the text so vision-capable editors (and
				// future image-aware LLM clients) see the rendered image.
				const chunks: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
					{ type: "text", text: event.result.content },
				];
				if (event.result.imageDataUrl) {
					chunks.push({ type: "image", image_url: { url: event.result.imageDataUrl } });
				}
				payload.content = chunks;
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
 * tagged user message so the next LLM call sees them in context. Editors
 * using `embeddedContext: true` send `document/didOpen` for every file
 * the user has open in their buffer; without this injection the model
 * would only know about files it has explicitly `read`.
 *
 * The message carries `_castSkipReplay: true` so `replaySessionHistory`
 * (called from `session/load`) drops it — the editor should not render
 * system context as "the user said". Cast's LLM sanitizer
 * (`llm.ts:sanitizeMessages`) drops the same field before it reaches
 * the provider, so the wire marker never leaks to the model either.
 *
 * Implementation detail: we replace (rather than append) any previous
 * reminder so the message array doesn't grow unboundedly with each
 * prompt. The latest snapshot always wins. */
const OPEN_DOC_REMINDER_MARKER = "_castOpenDocsReminder";
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
	for (let i = state.messages.length - 1; i >= 0; i--) {
		const m = state.messages[i] as unknown as Record<string, unknown> | undefined;
		if (m && typeof m === "object" && m[OPEN_DOC_REMINDER_MARKER] === true) {
			state.messages.splice(i, 1);
		}
	}
	state.messages.push({
		role: "user",
		content: reminder,
		// Cast-only marker — replay drops it, LLM sanitizer drops it. See
		// the function comment for why we use `user` role rather than a
		// dedicated system role.
		[OPEN_DOC_REMINDER_MARKER]: true,
	} as unknown as (typeof state.messages)[number]);
}

/** Merge the startup MCP pool with any client-provided servers the
 * editor passed to `session/new`. The two pools are kept distinct
 * (separate `connections` arrays) so cleanup is straightforward —
 * startup's connections are torn down at process exit, client
 * connections on `session/close`.
 *
 * Returning the merged object (rather than mutating) means a single
 * McpSetupResult per session — loop's `formatMcpForPrompt` and
 * `mcpToolIndex` only need to look at one source of truth. */
function mergedMcp(session: AcpAdapterSession): McpSetupResult {
	const startup = session.startup.mcpResult;
	const client = session.clientMcpResult;
	if (!client) return startup;
	return {
		toolDefinitions: [...startup.toolDefinitions, ...client.toolDefinitions],
		toolIndex: new Map([...startup.toolIndex, ...client.toolIndex]),
		connections: [...startup.connections, ...client.connections],
		diagnostics: [...startup.diagnostics, ...client.diagnostics],
		allServerNames: [...startup.allServerNames, ...client.allServerNames],
		serverSources: { ...startup.serverSources, ...client.serverSources },
	};
}

function mergedMcpTools(session: AcpAdapterSession) {
	return mergedMcp(session).toolDefinitions;
}

function mergedMcpToolIndex(session: AcpAdapterSession) {
	return mergedMcp(session).toolIndex;
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

/** Convert ACP `McpServer` shape (the wire protocol — http/sse/acp/stdio
 * variants) into the `McpServerConfig` shape cast's MCP layer expects.
 * http + sse round-trip cleanly (url + headers); stdio is rejected
 * outright because spawning a local process from a remote editor is
 * a security risk we don't want to enable by default. The "acp"
 * experimental variant isn't supported by cast's MCP code path yet. */
function mcpServersToConfig(
	servers: NonNullable<Parameters<AcpAdapter["newSession"]>[2]>,
): Record<string, McpServerConfig> {
	const out: Record<string, McpServerConfig> = {};
	for (const server of servers) {
		const name = server.name;
		if (!name) continue;
		const t = server.type;
		if (t === "http" || t === "sse" || t === undefined) {
			if (!server.url) continue;
			// ACP sends headers as [{name, value}] pairs; cast's MCP layer
			// wants a plain object. Skip the array-of-objects conversion
			// when there are no headers — the empty array is the wire
			// default, not a meaningful "send nothing" signal.
			const headers: Record<string, string> | undefined = server.headers
				? Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
				: undefined;
			out[name] = {
				url: server.url,
				headers,
			};
		}
		// stdio + acp variants: silently dropped. Editors asking for stdio
		// should be told via a no-op (we don't error) — the editor can see
		// the connection succeeded but the tool never showed up.
	}
	return out;
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
 * - `audio`/`resource_link`/`resource` → silently dropped (no model
 *   ingestion path yet).
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
	// Audio / resource_link / resource blocks are silently dropped — cast has
	// no audio or tool-result ingestion path through ACP yet, and there's
	// no useful signal to leak back to the editor (the alternative — a
	// "[ACP: dropped audio block]" marker — would just be noise in the
	// model's context). If the editor needs to know, the absence of audio
	// in the model's responses is its own feedback.
	void sessionId;
	const parts: ContentPart[] = [];
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
		}
		// audio / resource_link / resource / unknown: drop silently.
	}
	return { role: "user", content: parts };
}

/**
 * Replay `state.messages` to the client as `session/update` notifications.
 * Cast's `SessionState` only persists user/assistant text messages (not the
 * tool_call events), so the replay is a straight chronological dump:
 * - user message → `user_message_chunk`
 * - assistant message → `agent_message_chunk` (no `isFinal` — replay is
 *   atomic, not streaming)
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
		// Drop cast-only markers (open-document reminders, image-source
		// tags) — they were injected by the bridge for model-side context
		// and have no business in the editor's UI.
		const m = message as unknown as Record<string, unknown> | undefined;
		if (m && typeof m === "object" && m[OPEN_DOC_REMINDER_MARKER] === true) continue;
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
						// No `isFinal` here — replay is historical, not a live
						// stream. The flag is meaningful only when the agent
						// is actively streaming chunks and the final one
						// closes the turn; replay's chunks are atomic.
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
