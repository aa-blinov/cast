/**
 * Opening the daemon's log file — the one place a `cast server start` can fail
 * before anything is spawned.
 *
 * The daemon's stdout and stderr are redirected straight into this file, so it
 * has to be openable first. Unguarded, a read-only or unwritable ~/.cast made
 * the command exit with a raw `EACCES: permission denied, open …server.log`
 * and a stack through the minified bundle: it named the log file but never
 * said that the *directory* was the problem, or that the fix was a permission
 * on it.
 */

import { mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

export interface DaemonLogFailure {
	/** Ready to print: what failed, then what to check. */
	lines: string[];
}

export function daemonLogFailureLines(path: string, err: unknown): string[] {
	const reason = err instanceof Error ? err.message : String(err);
	return [
		`[cast server] cannot write its log at ${path}: ${reason}`,
		`[cast server] check that ${dirname(path)} exists and is writable by this user (and that the disk is not full).`,
	];
}

/**
 * Open the log for appending, or return the lines explaining why not. Returns
 * a discriminated result rather than throwing: the caller has to print and
 * exit, and a thrown error here was exactly what produced the unreadable
 * output this module exists to replace.
 */
export function openDaemonLog(path: string): { ok: true; fd: number } | { ok: false; failure: DaemonLogFailure } {
	try {
		// `cast server start` can be the very first cast command on a machine
		// (a fresh install, a container image), and nothing has created ~/.cast
		// yet — settings only make it when they are written. Without this the
		// daemon refused to start with an ENOENT on its own log file and told
		// the user to check a directory that simply did not exist yet.
		mkdirSync(dirname(path), { recursive: true });
		return { ok: true, fd: openSync(path, "a") };
	} catch (err) {
		return { ok: false, failure: { lines: daemonLogFailureLines(path, err) } };
	}
}
