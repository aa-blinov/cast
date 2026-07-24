import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// ============================================================================
// SQLite connection — sessions.db
//
// One process-wide connection, opened lazily so importing this module (or
// session.ts, which imports it) never touches disk until a session is
// actually read or written — matters for tests that redirect HOME per-case.
// node:sqlite is still flagged experimental by Node (confirmed on 22.x —
// works, just emits an ExperimentalWarning on first use); package.json
// already requires node >=22, and avoiding a compiled native dependency
// (e.g. better-sqlite3) matters more for a curl-installed CLI than dodging
// that warning does.
// ============================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT,
  model TEXT,
  persona TEXT,
  mode TEXT,
  title TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_prompt_tokens INTEGER,
  last_announced_local_date TEXT,
  provider_url TEXT,
  usage_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  in_context INTEGER NOT NULL DEFAULT 1,
  reasoning TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(session_id, in_context, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
`;

let instance: DatabaseSync | null = null;
let instancePath: string | null = null;

/** `~/.cast/sessions/sessions.db` unless overridden — CAST_SESSIONS_DB lets
 *  tests (and, in principle, a user) point at an isolated database instead
 *  of the real one, mirroring how the old file-based store used HOME. */
function dbPath(): string {
	if (process.env.CAST_SESSIONS_DB) return process.env.CAST_SESSIONS_DB;
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
	if (instance) instance.close();
	instance = new DatabaseSync(path);
	instancePath = path;
	instance.exec("PRAGMA journal_mode = WAL");
	instance.exec("PRAGMA busy_timeout = 5000");
	instance.exec("PRAGMA foreign_keys = ON");
	instance.exec(SCHEMA);
	return instance;
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
