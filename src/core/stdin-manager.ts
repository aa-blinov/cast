/**
 * Hands the terminal to a callback for a moment (repainting outside the frame,
 * an external editor): the front end registers a hook that stops drawing and
 * gives the terminal back around the callback.
 *
 * It does not hand stdin to a child process: `bash` runs with stdin at EOF on
 * purpose (see tools/bash.ts), so a command that waits for input exits instead
 * of hanging the session.
 */

/** The hook must await the callback before returning. */
type SuspendHook = (callback: () => Promise<void>) => Promise<void>;
let suspendHook: SuspendHook | null = null;

export function setSuspendHook(hook: SuspendHook | null): void {
	suspendHook = hook;
}

/**
 * Runs the callback with the terminal suspended and returns its value. With no
 * hook (non-interactive mode) it just runs the callback.
 */
export async function suspendAndRun<T>(callback: () => Promise<T>): Promise<T> {
	if (!suspendHook) return callback();
	let result: T;
	// A hook that refuses to suspend (already suspended by a parallel call) must
	// not run the callback twice when the callback itself is what failed.
	let callbackStarted = false;
	try {
		await suspendHook(async () => {
			callbackStarted = true;
			result = await callback();
		});
	} catch (error) {
		if (callbackStarted) throw error;
		result = await callback();
	}
	return result!;
}
