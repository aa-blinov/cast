/**
 * Idle-session lifecycle: the eviction timer that drops a session from
 * memory once it's been idle, has no SSE listeners, and has no
 * background bash tasks running; and the `isFullyIdle` check that the
 * daemon shutdown handler uses to decide whether it's safe to exit.
 *
 * Moved out of server/bridge.ts as the third of three planned extractions
 * (broadcaster / fs-watcher / idle). idle consumes fs-watcher.stopFsWatcher
 * to release the chokidar handle when evicting, and the bridge's
 * releaseProjectMcpForCwd + countTurnMessages + saveSession helpers as
 * deps. fsWatcher.syncFsWatcher calls into idle via the onIdle callback
 * so the original "every session-state transition triggers both fs
 * toggling and idle eviction" semantics is preserved without coupling
 * the two factories.
 */

import type { Message } from "../../core/llm.ts";
import type { SessionState } from "../../core/session.ts";
import type { WebAgentSession } from "../bridge.ts";

export interface IdleEvictorDeps {
	sessions: Map<string, WebAgentSession>;
	idleSessionEvictions: Map<string, ReturnType<typeof setTimeout>>;
	idleSessionEvictionMs: number;
	cwd: string;
	countTurnMessages: (messages: Message[]) => number;
	saveSession: (session: SessionState) => void;
	releaseProjectMcpForCwd: (sessionCwd: string) => void;
	stopFsWatcher: (sessionId: string) => void;
}

export interface IdleEvictor {
	syncIdleSessionEviction: (ws: WebAgentSession) => void;
}

export function createIdleEvictor(deps: IdleEvictorDeps): IdleEvictor {
	function syncIdleSessionEviction(ws: WebAgentSession): void {
		const existing = deps.idleSessionEvictions.get(ws.id);
		const canEvict = ws.status === "idle" && ws.listeners.size === 0 && !ws.backgroundBash.registry.hasRunning();
		if (!canEvict) {
			if (existing) clearTimeout(existing);
			deps.idleSessionEvictions.delete(ws.id);
			return;
		}
		if (existing) return;
		const timer = setTimeout(() => {
			deps.idleSessionEvictions.delete(ws.id);
			const live = deps.sessions.get(ws.id);
			if (
				!live ||
				live !== ws ||
				live.status !== "idle" ||
				live.listeners.size > 0 ||
				live.backgroundBash.registry.hasRunning()
			) {
				return;
			}
			if (deps.countTurnMessages(live.session.messages) > 0) deps.saveSession(live.session);
			deps.stopFsWatcher(live.id);
			deps.sessions.delete(live.id);
			deps.releaseProjectMcpForCwd(live.session.cwd ?? deps.cwd);
		}, deps.idleSessionEvictionMs);
		timer.unref();
		deps.idleSessionEvictions.set(ws.id, timer);
	}

	return { syncIdleSessionEviction };
}
