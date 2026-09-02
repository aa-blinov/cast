import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
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
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return join(dir, "sessions.db");
}

/** The shared connection, opened (and schema-migrated) on first use. Reopens
 *  if CAST_SESSIONS_DB changes between calls — only ever happens in tests,
 *  which each point at their own temp file. */
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
	const db = new DatabaseSync(path);
	try {
		initConnection(db);
	} catch (err) {
		try {
			db.close();
		} catch {
			// Already unusable; the original error is the one worth reporting.
		}
		throw err;
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
	// One-time backfill: an existing sessions.db from before messages_fts
	// existed has years of messages the triggers above never saw. Only the
	// first getDb() after upgrading hits this — an empty fts table with a
	// non-empty messages table is exactly (and only) that situation, since
	// clearing every session's messages also clears every fts row for it.
	const ftsIsEmpty = (instance.prepare("SELECT 1 FROM messages_fts LIMIT 1").get() as unknown) === undefined;
	if (ftsIsEmpty) {
		const hasMessages = (instance.prepare("SELECT 1 FROM messages LIMIT 1").get() as unknown) !== undefined;
		if (hasMessages) {
			instance.exec(`
				INSERT INTO messages_fts(session_id, seq, body)
				SELECT session_id, seq, cast_message_text(content_json)
				FROM messages
				WHERE role IN ('user', 'assistant')
			`);
		}
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
