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
// works, just emits an ExperimentalWarning on first use). package.json
// already requires Node 22; the launchers suppress that known runtime notice
// while keeping application warnings visible, avoiding a compiled native
// dependency such as better-sqlite3 for a curl-installed CLI.
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
  usage_json TEXT NOT NULL,
  todos_json TEXT,
  share_token TEXT,
  plan_question_json TEXT,
  plan_transition_json TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  in_context INTEGER NOT NULL DEFAULT 1,
  reasoning TEXT,
  turn_meta TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(session_id, in_context, seq);
-- Backs getHistoryPage's "30th most recent user message" boundary lookup and
-- the "is there a previous turn?" existence check (see core/session.ts). Both
-- filter on (session_id, role) and order by seq; without this index SQLite
-- has to walk the whole session in seq order, reading every full row
-- (content_json included) just to find user rows. For a long agentic session
-- that is a multi-MB scan per thread-open.
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);

-- Undo checkpoints: metadata + shadow-file backups for the /undo command.
-- A separate table (not a sessions column) so a long session's growing
-- checkpoint list doesn't get rewritten on every saveSession — rows are
-- appended at turn start and deleted on /undo only.
CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

-- Subagent (task tool) transcripts. The child run used to be in-memory only —
-- lost on process death. Each completed task tool call stores its full
-- message chain here, keyed by the parent session, so the work survives.
CREATE TABLE IF NOT EXISTS subagent_runs (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool_call_id TEXT NOT NULL,
  persona TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  end_reason TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
`;

/** Same text-extraction rule as session.ts's messageText() — plain string
 *  content, or the first `type: "text"` part of a content-block array.
 *  Duplicated here (not imported) because it must be registered as a SQL
 *  scalar function before SCHEMA's triggers run, and session.ts imports
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

/**
 * Full-text index over user/assistant message bodies, kept in sync purely by
 * triggers — every INSERT/DELETE on `messages` updates it automatically, so
 * no call site in session.ts (saveSession, recordCompaction, the legacy
 * migration, clearSessionMessages) needs to remember to maintain it
 * separately. content_json is never UPDATEd after insert (only reasoning/
 * turn_meta are), so no AFTER UPDATE trigger is needed for the indexed body.
 * Replaces the old approach of JSON.parsing every user/assistant message on
 * every session listing just to build a throwaway search string in JS.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  seq UNINDEXED,
  body,
  tokenize = 'unicode61'
);

CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'assistant')
BEGIN
  INSERT INTO messages_fts(session_id, seq, body) VALUES (NEW.session_id, NEW.seq, cast_message_text(NEW.content_json));
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE session_id = OLD.session_id AND seq = OLD.seq;
END;
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
	// Must exist before FTS_SCHEMA below — CREATE TRIGGER doesn't resolve the
	// function name until the trigger actually fires, but every getDb() call
	// re-opens a fresh DatabaseSync (see the reopen branch above), so it has
	// to be re-registered on this connection every time regardless.
	instance.function("cast_message_text", { deterministic: true }, extractMessageText);
	instance.exec(SCHEMA);
	// `CREATE TABLE IF NOT EXISTS` only creates the table on a first run — an
	// existing sessions.db from before todos_json existed needs the column
	// added explicitly. SQLite has no `ADD COLUMN IF NOT EXISTS`, hence the
	// pragma check first.
	const columns = instance.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
	if (!columns.some((c) => c.name === "todos_json")) {
		instance.exec("ALTER TABLE sessions ADD COLUMN todos_json TEXT");
	}
	if (!columns.some((c) => c.name === "share_token")) {
		instance.exec("ALTER TABLE sessions ADD COLUMN share_token TEXT");
	}
	if (!columns.some((c) => c.name === "plan_question_json")) {
		instance.exec("ALTER TABLE sessions ADD COLUMN plan_question_json TEXT");
	}
	if (!columns.some((c) => c.name === "plan_transition_json")) {
		instance.exec("ALTER TABLE sessions ADD COLUMN plan_transition_json TEXT");
	}
	const messageColumns = instance.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
	if (!messageColumns.some((c) => c.name === "turn_meta")) {
		instance.exec("ALTER TABLE messages ADD COLUMN turn_meta TEXT");
	}
	// Created after the column migration above, not inside SCHEMA — an
	// existing DB predating share_token would otherwise fail this index's
	// CREATE with "no such column" the moment SCHEMA runs, before the ALTER
	// TABLE ever gets a chance to add it.
	instance.exec(
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL",
	);
	instance.exec(FTS_SCHEMA);
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
