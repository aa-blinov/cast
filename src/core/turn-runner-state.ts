/**
 * Per-session turn-runner state — a sentinel file in `~/.cast/sessions/` that
 * tells cross-process readers (the web UI, in particular) whether a session
 * is *currently* being driven by *some* live process. The DB stores content;
 * this file stores ephemeral runtime: "session X is being worked on right now
 * by process pid=N, since timestamp T".
 *
 * Why a file and not a DB column:
 *   - Status is intrinsic to the lifetime of the running process. It must
 *     self-heal on crash (process dies → file becomes stale → readers see
 *     idle). A DB column can only be cleared by a writer that may itself be
 *     dead.
 *   - No schema migration, no busy timeout, no GC pass. Disk write in
 *     runLoop's try/finally, disk read in coldSummary's per-session path.
 *   - The DB and the file have disjoint responsibilities: the file is true
 *     "only while the process lives"; the DB is true "forever". Mixing them
 *     is what made the previous DB-staleness design fragile.
 *
 * Safety:
 *   - `clearTurnRunner` only deletes a file whose recorded pid matches our own.
 *     Two TUIs racing on the same session can therefore write overlapping
 *     files without one of them accidentally clobbering the other's signal.
 *   - `effectiveStatusFromFile` requires BOTH the pid to be alive AND the
 *     startedAt to be recent. The double check protects against PID reuse
 *     by the OS after a process dies.
 *   - All filesystem failures degrade to "idle" rather than crashing the
 *     read path — a missing or malformed file is the same as "no runner".
 */

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function stateDir(): string {
	return join(homedir(), ".cast", "sessions");
}

/** Ensure the parent directory exists before any write. Mirrors the pattern
 *  in core/db.ts's dbPath() — on a fresh machine the .cast/sessions directory
 *  may not exist yet, and a silent writeFileSync ENOENT here would mean the
 *  sentinel is never created, leaving the web UI stuck on "idle" forever. */
function ensureDir(): void {
	const dir = stateDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Past this age *without a heartbeat*, even a live PID is treated as stale —
 *  protects against OS PID reuse after a process's death, and against a live
 *  process that is wedged rather than working. */
const STALE_THRESHOLD_MS = 60_000;

/** How often a running turn refreshes its lock and sentinel. Comfortably under
 *  STALE_THRESHOLD_MS so a missed tick (a blocked event loop, a slow disk)
 *  doesn't hand the session to someone else. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface TurnRunnerState {
	pid: number;
	startedAt: number;
}

/** True if a process with the given PID exists. POSIX-style probe via
 *  signal 0. Throws are caught because the only way this fails is
 *  ESRCH (process gone) or EPERM (no permission, which still means
 *  the process exists for our purposes). We treat both as "not alive"
 *  to be conservative — if we cannot prove it alive, do not claim it. */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Path to the per-session sentinel file. Kept private to this module. */
function statePath(sessionId: string): string {
	return join(stateDir(), `.running-${sessionId}.json`);
}

function lockPath(sessionId: string): string {
	return join(stateDir(), `.lock-${sessionId}.json`);
}

/** Atomically claims the right to start a session turn across processes. */
export function acquireTurnRunner(sessionId: string, pid: number): boolean {
	ensureDir();
	const path = lockPath(sessionId);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, JSON.stringify({ pid, startedAt: Date.now() }), { encoding: "utf-8", flag: "wx" });
			return true;
		} catch {
			try {
				const state = JSON.parse(readFileSync(path, "utf-8")) as TurnRunnerState;
				const stale = !isProcessAlive(state.pid) || Date.now() - state.startedAt > STALE_THRESHOLD_MS;
				if (!stale) return false;
			} catch {
				try {
					if (Date.now() - statSync(path).mtimeMs <= STALE_THRESHOLD_MS) return false;
				} catch {
					continue;
				}
			}
			try {
				unlinkSync(path);
			} catch {
				return false;
			}
		}
	}
	return false;
}

/**
 * Refresh the timestamps on the lock and sentinel we own.
 *
 * Without this, `startedAt` was written once at acquire time, so every turn
 * lasting over a minute — which is ordinary, and guaranteed under a goal —
 * looked stale to `acquireTurnRunner`: a second process would steal the lock
 * from a live, working one and both would drive the same session. The same
 * staleness made `effectiveStatusFromFile` report a long, healthy turn as
 * idle. With a heartbeat, "stale" means what it was meant to mean — the owner
 * stopped reporting, because it died or wedged.
 *
 * Returns false when the lock is gone or now belongs to someone else. It does
 * NOT reclaim it: two processes both writing their own pid is the very race
 * this guards against, so a loser stays a loser and the caller decides.
 */
export function heartbeatTurnRunner(sessionId: string, pid: number): boolean {
	let owned = false;
	try {
		const state = JSON.parse(readFileSync(lockPath(sessionId), "utf-8")) as TurnRunnerState;
		if (state.pid !== pid) return false;
		writeFileSync(lockPath(sessionId), JSON.stringify({ pid, startedAt: Date.now() }), "utf-8");
		owned = true;
	} catch {
		// No lock file at all: nothing to refresh. A caller that skipped the
		// lock (a nested run) is the normal case here.
		return false;
	}
	try {
		const raw = readFileSync(statePath(sessionId), "utf-8");
		const { pid: writerPid } = JSON.parse(raw) as TurnRunnerState;
		if (writerPid === pid) markTurnRunner(sessionId, pid);
	} catch {
		/* sentinel missing or malformed — the lock is the part that matters */
	}
	return owned;
}

/** Releases only the lock owned by this pid. */
export function releaseTurnRunner(sessionId: string, pid: number): void {
	try {
		const state = JSON.parse(readFileSync(lockPath(sessionId), "utf-8")) as TurnRunnerState;
		if (state.pid === pid) unlinkSync(lockPath(sessionId));
	} catch {
		/* ENOENT, EACCES, or malformed JSON — nothing to clean up */
	}
}

/** Writes (or overwrites) the sentinel. Called by TUI at turn start.
 *  Tolerates filesystem failure silently — if `~/.cast/sessions/` is
 *  read-only, the worst that happens is web readers see "idle" for this
 *  session, which is the same outcome as if no TUI were running. */
export function markTurnRunner(sessionId: string, pid: number): void {
	try {
		ensureDir();
		writeFileSync(statePath(sessionId), JSON.stringify({ pid, startedAt: Date.now() }), "utf-8");
	} catch {
		/* read-only fs / EACCES — sidebar readers will fall back to idle, which is the safe default */
	}
}

/** Removes the sentinel, but only if it was ours. Self-defensive against
 *  two TUIs racing on the same session: if TUI A writes the file and
 *  TUI B overwrites it, TUI A's finally will see pid != own and leave
 *  it alone. */
export function clearTurnRunner(sessionId: string, pid: number): void {
	try {
		const raw = readFileSync(statePath(sessionId), "utf-8");
		const { pid: writerPid } = JSON.parse(raw) as TurnRunnerState;
		if (writerPid !== pid) return; // someone else's file — leave it
		unlinkSync(statePath(sessionId));
	} catch {
		/* ENOENT, EACCES, or malformed JSON — nothing to clean up */
	}
}

/** Reads the sentinel and returns whether a turn is plausibly running
 *  for that session right now. Returns "running" only when both:
 *    1. the recorded PID is still alive, and
 *    2. the file is younger than STALE_THRESHOLD_MS.
 *  Self-healing on parse failure and on dead PID — neither is fatal. */
export function effectiveStatusFromFile(sessionId: string): "running" | "idle" {
	if (!existsSync(statePath(sessionId))) return "idle";
	let state: TurnRunnerState;
	try {
		state = JSON.parse(readFileSync(statePath(sessionId), "utf-8")) as TurnRunnerState;
	} catch {
		return "idle";
	}
	if (!isProcessAlive(state.pid)) return "idle";
	if (Date.now() - state.startedAt > STALE_THRESHOLD_MS) return "idle";
	return "running";
}
