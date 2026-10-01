import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A line in ~/.cast/tui-errors.log: what the screen could not show to the person at the time. */
export function logTuiError(what: string, text: string): void {
	try {
		mkdirSync(join(homedir(), ".cast"), { recursive: true });
		appendFileSync(join(homedir(), ".cast", "tui-errors.log"), `${new Date().toISOString()} ${what}: ${text}\n`);
	} catch {
		// Nowhere to write: still better than dying.
	}
}

/**
 * Says why the process is about to end, after the terminal has been handed back: the exit hooks run in the order
 * they were registered, the screen's restore first, so this prints on the normal screen instead of into the
 * alternate one that is thrown away.
 */
export function reportFatal(what: string, error: unknown, hint?: string): void {
	const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
	logTuiError(what, text);
	process.once("exit", () => {
		process.stderr.write(
			`\ncast stopped on an internal error (${what}); details are in ~/.cast/tui-errors.log\n${text}\n`,
		);
		if (hint) process.stderr.write(`${hint}\n`);
	});
}
