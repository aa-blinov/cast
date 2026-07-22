/**
 * Shared state file for the `cast web` daemon — read by the CLI layer
 * (`src/index.ts`'s start/stop/status) and written by the server process
 * itself (`src/web/index.ts`), once it's actually listening, not by the
 * launcher right after `spawn()`. That ordering is what makes "already
 * running" detection trustworthy: the file only exists when a server is
 * truly bound, never just "a child process was started".
 *
 * Every reader treats a PID whose process is no longer alive as stale and
 * cleans it up automatically — the only way to survive the process being
 * killed out from under `cast web` (crash, OOM, `kill -9`, the user ending
 * the terminal): nothing here can catch SIGKILL, so recovery has to happen
 * on the next read, not via a handler in the dying process.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_FILE = join(homedir(), ".cast", "web.json");

export interface WebDaemonState {
	pid: number;
	port: number;
	host: string;
	startedAt: string;
	/** True for `cast web --foreground` — status/stop can say so, even though the mechanics are identical. */
	foreground: boolean;
}

/** True if a process with this PID exists — not necessarily one this harness started (PID reuse is possible but rare). */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Reads the state file, self-healing a corrupt/unparseable one by treating it as absent rather than throwing. */
export function readWebState(): WebDaemonState | undefined {
	if (!existsSync(STATE_FILE)) return undefined;
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as WebDaemonState;
	} catch {
		return undefined;
	}
}

export function writeWebState(state: WebDaemonState): void {
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function clearWebState(): void {
	try {
		unlinkSync(STATE_FILE);
	} catch {
		/* already gone — fine */
	}
}

/**
 * Reads the state file and tells the caller whether it describes a genuinely
 * live process, cleaning up automatically when it doesn't — the one check
 * every start/stop/status path should go through instead of reading the
 * file directly, so "was this killed out from under us" is handled the same
 * way everywhere.
 */
export function readLiveWebState(): WebDaemonState | undefined {
	const state = readWebState();
	if (!state) return undefined;
	if (isProcessAlive(state.pid)) return state;
	clearWebState(); // stale — the recorded process is gone
	return undefined;
}
