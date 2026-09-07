import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.ts";

// ============================================================================
// SQLite connection — sessions.db
//
// One process-wide connection, opened lazily so importing this module (or
// session.ts, which imports it) never touches disk until a session is
// actually read or written — matters for tests that redirect HOME per-case.
// node:sqlite is still flagged experimental by Node (confirmed on 22.x —
// works, just emits an ExperimentalWarning on first use). package.json
// already requires Node 22; the launchers suppress that known runtime notice
// while keeping application warnings visible, avoiding a compiled native
// dependency such as better-sqlite3 for a curl-installed CLI.
//
// The schema lives in src/core/migrations.ts (versioned, Flyway-style); this
// module only opens the connection and runs pending migrations. Kept in a
// separate module so tests can migrate a throwaway DB via runMigrations.
// ============================================================================

/** Same text-extraction rule as session.ts's messageText() — plain string
 *  content, or the first `type: "text"` part of a content-block array.
 *  Duplicated here (not imported) because it must be registered as a SQL
 *  scalar function before the FTS triggers run, and session.ts imports
 *  this module, not the other way around. */
function extractMessageText(contentJson: unknown): string {
	try {
		const m = JSON.parse(String(contentJson)) as { content?: unknown };
		const content = m.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const part = content.find((p: { type?: string }) => p?.type === "text") as { text?: string } | undefined;
			return part?.text ?? "";
		}
	} catch {
		// Malformed content_json (shouldn't happen — session.ts always writes
		// JSON.stringify'd messages) — index nothing rather than throw inside
		// a trigger and abort the write it's attached to.
	}
	return "";
}

let instance: DatabaseSync | null = null;
let instancePath: string | null = null;

/** `~/.cast/sessions/sessions.db` unless overridden — CAST_SESSIONS_DB lets
 *  tests (and, in principle, a user) point at an isolated database instead
 *  of the real one, mirroring how the old file-based store used HOME. */
function dbPath(): string {
	const configuredPath = process.env.CAST_SESSIONS_DB;
	if (configuredPath) {
		if (configuredPath !== ":memory:") mkdirSync(dirname(configuredPath), { recursive: true });
		return configuredPath;
	}
	const dir = join(homedir(), ".cast", "sessions");
	// Under vitest, refuse a database outside the temp dir rather than writing
	// to it. Tests set CAST_SESSIONS_DB per test, but fire-and-forget work (a
	// checkpoint writer, say) can outlive the test that started it and reach
	// getDb() after afterEach has already restored the variable — which
	// silently accumulated hundreds of rows in the developer's own
	// ~/.cast/sessions/sessions.db. Failing loudly points at the leak instead.
	// Scoped to paths outside tmpdir, so the tests that spawn a real daemon
	// under an isolated HOME (which inherits VITEST) still work.
	if (process.env.VITEST && !dir.startsWith(tmpdir())) {
		throw new Error(
			"Refusing to open the real sessions.db from a test — set CAST_SESSIONS_DB, and make sure no background work outlives the test that started it.",
		);
	}
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "sessions.db");
}

/** The shared connection, opened (and schema-migrated) on first use. Reopens
 *  if CAST_SESSIONS_DB changes between calls — only ever happens in tests,
 *  which each point at their own temp file. */
const DAMAGED_STORE_RE = /not a database|file is encrypted|database disk image is malformed/i;
const UNOPENABLE_STORE_RE = /unable to open database file/i;

/**
 * Turn SQLite's own wording into something actionable.
 *
 * A truncated or overwritten store made cast exit with `Error: file is not a
 * database` and a stack through the minified bundle — nothing naming the file
 * and nothing saying what to do about it. The file is never touched
 * automatically: it may be the only copy of the user's history, and a wrong
 * guess here would delete it.
 */
function describeStoreFailure(err: unknown, path: string): Error {
	const code = (err as { errcode?: number } | undefined)?.errcode;
	const message = err instanceof Error ? err.message : String(err);
	// 26 = SQLITE_NOTADB, 11 = SQLITE_CORRUPT.
	const damaged = code === 26 || code === 11 || DAMAGED_STORE_RE.test(message);
	if (damaged) {
		return new Error(
			`Session store at ${path} is not a readable SQLite database (${message}). Nothing was changed. Move it aside (e.g. \`mv ${path} ${path}.broken\`) and cast will create a fresh store — the sessions in the old file stay in it, recoverable with sqlite tooling.`,
		);
	}
	if (code === 14 || UNOPENABLE_STORE_RE.test(message)) {
		return new Error(
			`Cannot open the session store at ${path} (${message}). Check that the directory exists and is writable by this user, and that the filesystem is not full or read-only.`,
		);
	}
	return err instanceof Error ? err : new Error(message);
}

export function getDb(): DatabaseSync {
	const path = dbPath();
	if (instance && instancePath === path) return instance;
	if (instance) {
		instance.close();
		// Cleared before the reopen, not after: if `new DatabaseSync` below
		// throws, leaving the closed handle in place made every later call
		// throw on close() instead of retrying the open.
		instance = null;
		instancePath = null;
	}
	// Published to the module singleton only once fully initialised. Assigning
	// first meant a failed migration (two processes racing an upgrade, say)
	// left every later getDb() early-returning a partially-migrated handle
	// from the check above, with no retry — the real cause then surfaced much
	// later as a confusing "no such column".
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path);
	} catch (err) {
		throw describeStoreFailure(err, path);
	}
	try {
		initConnection(db);
	} catch (err) {
		try {
			db.close();
		} catch {
			// Already unusable; the original error is the one worth reporting.
		}
		throw describeStoreFailure(err, path);
	}
	instance = db;
	instancePath = path;
	return instance;
}

function initConnection(instance: DatabaseSync): void {
	instance.exec("PRAGMA journal_mode = WAL");
	instance.exec("PRAGMA busy_timeout = 5000");
	instance.exec("PRAGMA foreign_keys = ON");
	// Must exist before the FTS triggers run — CREATE TRIGGER doesn't resolve
	// the function name until the trigger actually fires, but every getDb()
	// call re-opens a fresh DatabaseSync (see the reopen branch above), so it
	// has to be re-registered on this connection every time regardless.
	instance.function("cast_message_text", { deterministic: true }, extractMessageText);
	runMigrations(instance);
	// One-time backfill: an existing sessions.db from before the search index
	// existed has years of messages the triggers above never saw. Only the
	// first getDb() after upgrading hits this — an empty index with a non-empty
	// messages table is exactly (and only) that situation, since clearing every
	// session's messages also clears every index row for it.
	const ftsIsEmpty = (instance.prepare("SELECT 1 FROM session_history_fts LIMIT 1").get() as unknown) === undefined;
	if (ftsIsEmpty) {
		const hasMessages = (instance.prepare("SELECT 1 FROM messages LIMIT 1").get() as unknown) !== undefined;
		if (hasMessages) {
			instance.exec(`
				INSERT INTO session_history_fts(session_id, seq, role, body)
				SELECT session_id, seq, role, cast_message_text(content_json)
				FROM messages
				WHERE role IN ('user', 'assistant', 'tool')
			`);
		}
	}
	reclaimFreePages(instance);
}

/**
 * Reclaim the free pages that deletes leave behind.
 *
 * SQLite never shrinks a file on its own, and `auto_vacuum` is off (its
 * incremental mode cannot be switched on for an existing database without a
 * full VACUUM anyway). Sessions, events and background runs are all pruned on
 * a retention policy, so the space is genuinely freed — it just stays claimed
 * by the file. Measured on a real store: 547MB on disk of which 219MB (40%)
 * were free pages, and a VACUUM took 2.0s to bring it to 324MB.
 *
 * Thresholds keep it rare: a fifth of the file *and* at least 64MB, so the
 * common case never pays, and a store that has just been pruned hard does.
 * VACUUM holds a write lock for its duration, which is why this runs once per
 * process at open — before anything is serving — rather than mid-session.
 */
const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024;
const VACUUM_MIN_FREE_SHARE = 0.2;

/** @internal exported so a test can drive it with small thresholds */
export function reclaimFreePages(
	instance: DatabaseSync,
	opts: { minFreeBytes?: number; minFreeShare?: number; quiet?: boolean } = {},
): boolean {
	const minFreeBytes = opts.minFreeBytes ?? VACUUM_MIN_FREE_BYTES;
	const minFreeShare = opts.minFreeShare ?? VACUUM_MIN_FREE_SHARE;
	try {
		const value = (sql: string): number => {
			const row = instance.prepare(sql).get() as Record<string, unknown> | undefined;
			const first = row ? Object.values(row)[0] : undefined;
			return typeof first === "number" ? first : 0;
		};
		const pageSize = value("PRAGMA page_size");
		const pageCount = value("PRAGMA page_count");
		const freeCount = value("PRAGMA freelist_count");
		if (pageSize <= 0 || pageCount <= 0) return false;
		const freeBytes = pageSize * freeCount;
		if (freeBytes < minFreeBytes || freeCount / pageCount < minFreeShare) return false;
		const startedAt = Date.now();
		instance.exec("VACUUM");
		// Without this the space is not returned, only moved: in WAL mode a
		// VACUUM writes the whole rebuilt database into the write-ahead log,
		// and nothing truncates it on its own. Measured on the real store —
		// 547MB became a 324MB database plus a 326MB WAL, i.e. no saving at
		// all until the checkpoint ran.
		try {
			instance.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
		} catch {
			// A reader holding the WAL open makes this a no-op for now; the
			// next checkpoint (or the next open) picks it up.
		}
		if (!opts.quiet) {
			console.error(
				`[cast] compacted sessions.db — reclaimed ${(freeBytes / 1048576).toFixed(0)}MB of free pages in ${Date.now() - startedAt}ms.`,
			);
		}
		return true;
	} catch {
		// A VACUUM that cannot run (no temp space, a concurrent writer holding
		// the lock) must never stop the process from opening its database — the
		// free pages are reusable either way, this only returns them to the
		// filesystem.
		return false;
	}
}

/** Test-only: force the next getDb() to reopen (a fresh temp path per test
 *  otherwise reuses the previous test's now-invalid closed handle). */
export function resetDbConnectionForTests(): void {
	if (instance) {
		try {
			instance.close();
		} catch {
			// Already closed — fine.
		}
	}
	instance = null;
	instancePath = null;
}
