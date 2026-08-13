import { MessageQueue } from "./loop.ts";

// ============================================================================
// Agent runner (manages queues and prompt execution)
// ============================================================================

export interface AgentRunner {
	steeringQueue: MessageQueue;
	followUpQueue: MessageQueue;
	/** True while the agent loop is running. */
	isRunning: boolean;
	/** Abort the current run. `reason` reaches the loop as `signal.reason`,
	 * letting it tell a real user-initiated abort apart from e.g. a backend
	 * process shutdown when it decides what to tell the model happened. */
	abort: (reason?: string) => void;
	/** Promise that resolves when the current run finishes. */
	waitForIdle: () => Promise<void>;
	/** Opaque ownership token returned for the active run. */
	startRun: (ac: AbortController) => AgentRunLease;
	/** Mark a run as finished. A stale run cannot finish a newer run. */
	endRun: (lease: AgentRunLease) => void;
}

export interface AgentRunLease {
	readonly id: number;
}

export function createAgentRunner(): AgentRunner {
	let currentAbort: AbortController | null = null;
	let currentLease: AgentRunLease | null = null;
	let nextRunId = 0;
	const idleWaiters = new Set<() => void>();

	const runner: AgentRunner = {
		steeringQueue: new MessageQueue(),
		followUpQueue: new MessageQueue(),
		isRunning: false,

		abort(reason?: string) {
			currentAbort?.abort(reason);
			// Anything queued for this run is moot once it's cancelled —
			// otherwise a /steer or /queue typed just before /abort would
			// silently surface at the start of the next, unrelated prompt.
			runner.steeringQueue.clear();
			runner.followUpQueue.clear();
		},

		waitForIdle() {
			if (!runner.isRunning) return Promise.resolve();
			return new Promise<void>((resolve) => {
				idleWaiters.add(resolve);
			});
		},

		startRun(ac: AbortController) {
			if (runner.isRunning) throw new Error("Agent run already active");
			const lease = Object.freeze({ id: ++nextRunId });
			currentAbort = ac;
			currentLease = lease;
			runner.isRunning = true;
			return lease;
		},
		endRun(lease) {
			if (currentLease?.id !== lease.id) return;
			runner.isRunning = false;
			currentAbort = null;
			currentLease = null;
			for (const resolve of idleWaiters) resolve();
			idleWaiters.clear();
		},
	};

	return runner;
}
