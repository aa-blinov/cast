/**
 * For a promise nobody awaits (waking an idle session, a queued follow-up, a
 * slash command that starts a turn). A rejection nobody handles ends the whole
 * process, and here that is every session in the daemon: a background job
 * finishing after its session was closed threw "Session not found" from a pty
 * exit handler and took the daemon down. The failure is logged instead.
 */
export function runDetached(promise: Promise<unknown>, what: string): void {
	promise.catch((error: unknown) => {
		console.error(`[cast server] ${what} failed: ${error instanceof Error ? error.message : String(error)}`);
	});
}
