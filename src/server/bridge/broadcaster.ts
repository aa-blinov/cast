/**
 * Broadcast primitives used everywhere inside the bridge: in-process listener
 * fan-out, sidebar-wide event distribution, the `lastActivityAt` heartbeat,
 * and the hook notifications that fire when an agent turn finishes or asks
 * for input.
 *
 * Moved out of server/bridge.ts as one of three planned extractions
 * (broadcaster / fs-watcher / idle) — these are the most cross-cutting
 * inner closures with no internal dependencies on each other in their
 * own logic (broadcaster has none, fs-watcher and idle consume broadcast
 * and stopFsWatcher respectively). Keeping them in their own modules
 * makes the closure wiring explicit instead of implicit.
 *
 * The factory takes shared state (sessions map, listener set, the
 * mutable lastActivityAtRef, cwd fallback, plus two local helpers from
 * the bridge closure — trustForSessionCwd and summaryFor) and returns
 * the five methods that used to live inline inside createServerBridge.
 * Behaviour is unchanged: same order of operations, same try/catch
 * semantics, same hook dispatch.
 */
import { runHooksForEvent } from "../../core/hooks.ts";
import type { PlanQuestion } from "../../core/plan.ts";
import { resolveHooksForCwd } from "../../core/project.ts";
import type { SessionState } from "../../core/session.ts";
import { saveSession } from "../../core/session.ts";
import type { SessionSummary, WebAgentSession, WebAgentStatus, WebEvent } from "../bridge.ts";

export interface BroadcasterDeps {
	sessions: Map<string, WebAgentSession>;
	sessionListListeners: Set<(event: WebEvent) => void>;
	/** Mutable container — broadcaster.noteActivity updates it; the public
	 * ServerBridge.lastActivityAt() getter reads it. */
	lastActivityAtRef: { value: number };
	cwd: string;
	trustForSessionCwd: (sessionCwd: string) => boolean;
	summaryFor: (session: SessionState, status: WebAgentStatus) => SessionSummary;
}

export interface Broadcaster {
	noteActivity: () => void;
	broadcast: (ws: WebAgentSession, event: WebEvent) => void;
	broadcastSessionUpdate: (ws: WebAgentSession) => void;
	fireNotificationHook: (ws: WebAgentSession, type: "turn_complete" | "input_needed", message: string) => void;
	persistDecisionState: (
		ws: WebAgentSession,
		question: PlanQuestion | undefined,
		planTransition: { kind: "done" } | undefined,
	) => void;
}

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
	function noteActivity(): void {
		deps.lastActivityAtRef.value = Date.now();
	}

	function broadcast(ws: WebAgentSession, event: WebEvent): void {
		noteActivity();
		for (const listener of ws.listeners) {
			try {
				listener(event);
			} catch {
				// Listener threw — remove it to avoid poisoning the set.
			}
		}
	}

	/** Fires the `Notification` hook — the "the agent wants your attention"
	 *  event. It was declared and matcher-aware but dispatched from nowhere, so
	 *  a hook written to ring a bell, post to Slack or flash a window never ran.
	 *  Deliberately only the two moments that actually warrant interrupting
	 *  someone: a turn finished, or the agent is blocked on the user. */
	function fireNotificationHook(ws: WebAgentSession, type: "turn_complete" | "input_needed", message: string): void {
		const hooks = resolveHooksForCwd(ws.session.cwd ?? deps.cwd, deps.trustForSessionCwd(ws.session.cwd ?? deps.cwd));
		if (!hooks.Notification?.length) return;
		void runHooksForEvent(hooks, {
			event: "Notification",
			cwd: ws.session.cwd ?? deps.cwd,
			sessionId: ws.id,
			payload: { notification_type: type, message, title: ws.session.title ?? "" },
		});
	}

	function persistDecisionState(
		ws: WebAgentSession,
		question: PlanQuestion | undefined,
		planTransition: { kind: "done" } | undefined,
	): void {
		ws.session.planQuestion = question;
		ws.session.planTransition = planTransition;
		saveSession(ws.session);
		broadcast(ws, { type: "decision_state", question, planTransition });
		// Only when something new is being asked — clearing a resolved
		// question calls this too, and that is not a notification.
		if (question) fireNotificationHook(ws, "input_needed", question.questions[0]?.question ?? "Input needed");
		else if (planTransition) fireNotificationHook(ws, "input_needed", "A plan is waiting for approval");
	}

	/** Pushes a sidebar-friendly snapshot so every connected client (including
	 *  tabs that didn't initiate the turn) can update their session list
	 *  without a full refetch. */
	function broadcastSessionUpdate(ws: WebAgentSession): void {
		try {
			const event: WebEvent = { type: "session_update", session: deps.summaryFor(ws.session, ws.status) };
			broadcast(ws, event);
			for (const listener of deps.sessionListListeners) {
				try {
					listener(event);
				} catch {
					// Listener threw — remove it to avoid poisoning the set.
				}
			}
		} catch {
			// Defensive: summaryFor reads session.messages.length — if the run
			// left messages in an unexpected state, don't crash the broadcast.
		}
	}

	return { noteActivity, broadcast, broadcastSessionUpdate, fireNotificationHook, persistDecisionState };
}
