import {
	closeSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * A cross-process lock around a short synchronous read-modify-write of a file. The lock is a file holding the
 * owner's pid: a holder that died is detected by its pid and taken over at once, so a crash never blocks a
 * later write for longer than the wait below. A live holder past that wait is an error, not a silent unlocked
 * write: the write it would have lost is a token or a checkpoint that cannot be redone.
 */
const LOCK_WAIT_MS = 5_000;
/** A lock file with no pid in it (its holder died between create and write) is judged by its age. */
const EMPTY_LOCK_GRACE_MS = 5_000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Exclusive create with our pid in it. False when the lock already exists. */
function createLock(path: string, owner: string): boolean {
	try {
		const fd = openSync(path, "wx");
		try {
			writeSync(fd, owner);
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/**
 * Takes over a lock whose owner is gone. The file is moved aside before it is judged, so a fresh lock a peer
 * created in the meantime is never the one deleted: a live one that was moved goes back.
 */
function reclaimIfDead(path: string, owner: string): void {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return;
	}
	const holder = Number(raw);
	const dead =
		Number.isInteger(holder) && holder > 0
			? !isAlive(holder)
			: Date.now() - statSync(path).mtimeMs > EMPTY_LOCK_GRACE_MS;
	if (!dead) return;
	const aside = `${path}.${owner}.${Date.now()}.stale`;
	try {
		renameSync(path, aside);
	} catch {
		return;
	}
	try {
		if (readFileSync(aside, "utf-8") !== raw) {
			try {
				linkSync(aside, path);
			} catch {
				// A newer lock already sits at the path; it wins.
			}
		}
		unlinkSync(aside);
	} catch {
		// The moved copy vanished; nothing here is ours to clear.
	}
}

/** One attempt: takes the lock if it is free or its owner is dead. False when a live holder has it. */
export function tryAcquireLock(path: string): boolean {
	mkdirSync(dirname(path), { recursive: true });
	const owner = String(process.pid);
	if (createLock(path, owner)) return true;
	reclaimIfDead(path, owner);
	return createLock(path, owner);
}

/** Releases the lock only when this process still holds it: a lock taken over after a stall is not ours to remove. */
export function releaseLock(path: string): void {
	try {
		if (readFileSync(path, "utf-8") === String(process.pid)) unlinkSync(path);
	} catch {
		// Already gone.
	}
}

/** Runs `work` holding the lock at `path`. Throws when a live holder keeps it past the wait. */
export function withFileLock<T>(path: string, work: () => T, waitMs = LOCK_WAIT_MS): T {
	const deadline = Date.now() + waitMs;
	while (!tryAcquireLock(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for the lock on ${path}`);
		Atomics.wait(SLEEP_CELL, 0, 0, 10);
	}
	try {
		return work();
	} finally {
		releaseLock(path);
	}
}
