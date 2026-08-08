/**
 * Shared state file for the `cast server` daemon — read by the CLI layer
 * (`src/index.ts`'s start/stop/status) and written by the server process
 * itself (`src/server/index.ts`), once it's actually listening, not by the
 * launcher right after `spawn()`. That ordering is what makes "already
 * running" detection trustworthy: the file only exists when a server is
 * truly bound, never just "a child process was started".
 *
 * Every reader treats a PID whose process is no longer alive as stale and
 * cleans it up automatically — the only way to survive the process being
 * killed out from under `cast server` (crash, OOM, `kill -9`, the user ending
 * the terminal): nothing here can catch SIGKILL, so recovery has to happen
 * on the next read, not via a handler in the dying process.
 */

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolved at call time (not module load) so tests can point HOME at a
// per-test tmp dir before the first read; a top-level const would freeze
// on whatever homedir() returned when the module was first imported.
function stateFile(): string {
	return join(homedir(), ".cast", "server.json");
}

/** The pre-rename state file, migrated from automatically. */
function legacyStateFile(): string {
	return join(homedir(), ".cast", "web.json");
}

export interface ServerDaemonState {
	pid: number;
	port: number;
	host: string;
	startedAt: string;
	/** True for `cast server --foreground` — status/stop can say so, even though the mechanics are identical. */
	foreground: boolean;
	/**
	 * Local-only auth token for TUI clients connecting to a loopback daemon.
	 * Never sent over the network by the daemon; the TUI reads it from this
	 * state file (same machine, same user) so it can POST/GET without the
	 * interactive login flow the browser gets. Absent when the daemon binds a
	 * non-loopback host (then the TUI must auth like any other client).
	 */
	token?: string;
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
export function readServerState(): ServerDaemonState | undefined {
	const path = stateFile();
	if (!existsSync(path)) {
		// Pre-rename location (web.json) — migrate it to server.json so a
		// running daemon recorded by the old name keeps being found (and a
		// stale one keeps being cleaned up) after the rename.
		const legacy = legacyStateFile();
		if (existsSync(legacy)) {
			try {
				const migrated = JSON.parse(readFileSync(legacy, "utf-8")) as ServerDaemonState;
				writeFileSync(path, JSON.stringify(migrated, null, 2), "utf-8");
				unlinkSync(legacy);
				return migrated;
			} catch {
				/* corrupt/legacy — treat as absent */
			}
		}
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ServerDaemonState;
	} catch {
		return undefined;
	}
}

export function writeServerState(state: ServerDaemonState): void {
	writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf-8");
}

export function clearServerState(): void {
	try {
		unlinkSync(stateFile());
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
export function readLiveServerState(): ServerDaemonState | undefined {
	const state = readServerState();
	if (!state) return undefined;
	if (isProcessAlive(state.pid)) return state;
	clearServerState(); // stale — the recorded process is gone
	return undefined;
}

function startLockPath(): string {
	return join(homedir(), ".cast", "server-start.lock");
}

// The daemon-start race: two `cast` invocations starting at once both see an
// empty state file (the first daemon hasn't written it yet — it writes only
// once actually listening) and each spawns its own daemon. The last writer
// wins server.json, the other daemon survives as an unregistered orphan that
// a TUI already pointed at keeps talking to until it dies. An exclusive lock
// file serializes the spawn: exactly one caller runs `server start` while the
// others wait and then reuse whatever the winner recorded. The lock records
// its holder's pid so a crashed holder (who never released) can be detected
// and taken over instead of wedging every later start forever.
export function acquireStartLock(): boolean {
	const path = startLockPath();
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, String(process.pid));
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		try {
			const holder = Number(readFileSync(path, "utf-8"));
			if (!isProcessAlive(holder)) {
				unlinkSync(path);
				const fd = openSync(path, "wx");
				try {
					writeSync(fd, String(process.pid));
				} finally {
					closeSync(fd);
				}
				return true;
			}
		} catch {
			// Unreadable/corrupt lock — treat as held rather than risk a
			// duplicate daemon; the holder (if real) writes state soon and
			// the caller's readLiveServerState loop picks it up.
		}
		return false;
	}
}

export function releaseStartLock(): void {
	const path = startLockPath();
	try {
		const holder = Number(readFileSync(path, "utf-8"));
		if (holder === process.pid) unlinkSync(path);
	} catch {
		/* already gone — fine */
	}
}
