import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned schema migrations — the standard pattern (Flyway-style): an
 * ordered, named list of idempotent steps applied exactly once, tracked in
 * `schema_migrations`. `getDb()` runs any pending migrations before the first
 * query, inside a transaction per migration.
 *
 * Two tiers:
 * - version 1 is the baseline: for a BRAND-NEW database it creates the whole
 *   current schema; for a pre-migrations database (tables exist, no
 *   `schema_migrations` row) it is skipped as a no-op "already at this state"
 *   baseline — `getDb` detects that case and seeds the row instead of running
 *   CREATE IF NOT EXISTS again (which would be harmless but noisy).
 * - versions 2+ are forward-only increments (add columns/tables/indexes).
 *
 * Migrations never mutate `messages` content — that data is user-owned.
 */

export interface Migration {
	version: number;
	name: string;
	/** Apply the schema change. Runs inside a transaction. */
	up: (db: DatabaseSync) => void;
}

const BASELINE_SCHEMA = `
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
  session_kind TEXT NOT NULL DEFAULT 'conversation',
  parent_session_id TEXT,
  background_kind TEXT,
  usage_json TEXT NOT NULL,
  todos_json TEXT,
  share_token TEXT,
  plan_question_json TEXT,
  plan_transition_json TEXT,
  checkpoint_watermark_seq INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  in_context INTEGER NOT NULL DEFAULT 1,
  has_tool_calls INTEGER NOT NULL DEFAULT 0,
  reasoning TEXT,
  turn_meta TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_messages_context ON messages(session_id, in_context, seq);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(session_id, role, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

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

/** Message search lives in a single index, session_history_fts (migration 8),
 *  which covers user/assistant/tool and carries `role` so a user/assistant-only
 *  search can filter. A second index over the same text used to exist here
 *  (messages_fts); migration 35 removed it. */
const FTS_SCHEMA = "";

/** Append-only SQLite helper: column exists? (SQLite has no ADD COLUMN IF NOT EXISTS.) */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return cols.some((c) => c.name === column);
}

/** A legacy store can have its early migrations recorded as already-applied
 * (a baseline INSERT into schema_migrations) without their DDL having
 * actually run — most visibly, one that predates messages_fts entirely. */
function tableExists(db: DatabaseSync, table: string): boolean {
	return (
		(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as unknown) !== undefined
	);
}

export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "baseline-schema",
		up: (db) => {
			db.exec(BASELINE_SCHEMA);
			db.exec(FTS_SCHEMA);
		},
	},
	// 2: columns added to `sessions` after the original design (kept as separate
	// increments so a database at any intermediate state converges).
	{
		version: 2,
		name: "sessions-todos-and-sharing-columns",
		up: (db) => {
			if (!columnExists(db, "sessions", "todos_json")) {
				db.exec("ALTER TABLE sessions ADD COLUMN todos_json TEXT");
			}
			if (!columnExists(db, "sessions", "share_token")) {
				db.exec("ALTER TABLE sessions ADD COLUMN share_token TEXT");
			}
			if (!columnExists(db, "sessions", "plan_question_json")) {
				db.exec("ALTER TABLE sessions ADD COLUMN plan_question_json TEXT");
			}
			if (!columnExists(db, "sessions", "plan_transition_json")) {
				db.exec("ALTER TABLE sessions ADD COLUMN plan_transition_json TEXT");
			}
			// Depends on share_token existing (added above) — kept out of the
			// baseline so a legacy sessions table without the column doesn't
			// fail the CREATE with "no such column".
			db.exec(
				"CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_share_token ON sessions(share_token) WHERE share_token IS NOT NULL",
			);
		},
	},
	{
		version: 3,
		name: "messages-turn-meta",
		up: (db) => {
			if (!columnExists(db, "messages", "turn_meta")) {
				db.exec("ALTER TABLE messages ADD COLUMN turn_meta TEXT");
			}
		},
	},
	{
		version: 4,
		name: "session-events-audit-log",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type, seq);
`);
		},
	},
	{
		version: 5,
		name: "messages-tool-call-index",
		up: (db) => {
			if (!columnExists(db, "messages", "has_tool_calls")) {
				db.exec("ALTER TABLE messages ADD COLUMN has_tool_calls INTEGER NOT NULL DEFAULT 0");
			}
			// Older rows predate the denormalized flag. Backfill once so the
			// partial index has the same semantics for old and new sessions.
			db.exec(`
				UPDATE messages
				SET has_tool_calls = CASE
					WHEN role = 'assistant'
					 AND json_valid(content_json) = 1
					 AND json_type(content_json, '$.tool_calls') = 'array'
					 AND json_array_length(content_json, '$.tool_calls') > 0
					THEN 1
					ELSE 0
				END
			`);
			db.exec(
				"CREATE INDEX IF NOT EXISTS idx_messages_tool_calls ON messages(session_id) WHERE role = 'assistant' AND has_tool_calls = 1",
			);
		},
	},
	{
		version: 6,
		name: "project-memory-fts",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS project_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_session_id TEXT,
  source_turn_key TEXT,
  importance INTEGER NOT NULL DEFAULT 50,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory(project_id, importance DESC, updated_at DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts USING fts5(
  content,
  content='project_memory',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS project_memory_fts_ai AFTER INSERT ON project_memory BEGIN
  INSERT INTO project_memory_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
CREATE TRIGGER IF NOT EXISTS project_memory_fts_ad AFTER DELETE ON project_memory BEGIN
  INSERT INTO project_memory_fts(project_memory_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
END;
CREATE TRIGGER IF NOT EXISTS project_memory_fts_au AFTER UPDATE ON project_memory BEGIN
  INSERT INTO project_memory_fts(project_memory_fts, rowid, content) VALUES ('delete', OLD.id, OLD.content);
  INSERT INTO project_memory_fts(rowid, content) VALUES (NEW.id, NEW.content);
END;
`);
		},
	},
	{
		version: 8,
		name: "session-history-fts",
		up: (db) => {
			db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS session_history_fts USING fts5(
  session_id UNINDEXED,
  seq UNINDEXED,
  role UNINDEXED,
  body,
  tokenize = 'unicode61'
);
CREATE TRIGGER IF NOT EXISTS session_history_fts_ai AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'assistant', 'tool')
BEGIN
  INSERT INTO session_history_fts(session_id, seq, role, body) VALUES (NEW.session_id, NEW.seq, NEW.role, cast_message_text(NEW.content_json));
END;
CREATE TRIGGER IF NOT EXISTS session_history_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM session_history_fts WHERE session_id = OLD.session_id AND seq = OLD.seq;
END;
INSERT INTO session_history_fts(session_id, seq, role, body)
SELECT m.session_id, m.seq, m.role, cast_message_text(m.content_json)
FROM messages AS m
WHERE m.role IN ('user', 'assistant', 'tool')
  AND NOT EXISTS (
    SELECT 1 FROM session_history_fts AS f WHERE f.session_id = m.session_id AND f.seq = m.seq
  );
`);
		},
	},
	{
		version: 10,
		name: "project-memory-lifecycle",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS project_memory_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, session_id, turn_key)
);
CREATE INDEX IF NOT EXISTS idx_project_memory_checkpoints_project
  ON project_memory_checkpoints(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS project_memory_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_project_memory_artifacts_project
  ON project_memory_artifacts(project_id, updated_at DESC);
			`);
		},
	},
	{
		version: 11,
		name: "agent-actor-lifecycle",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS agent_actors (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  parent_actor_id TEXT,
  session_id TEXT,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,
  background INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  fork_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_actors_parent
  ON agent_actors(parent_session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_actors_status
  ON agent_actors(status, updated_at DESC);
`);
		},
	},
	{
		version: 12,
		name: "agent-actor-fencing",
		up: (db) => {
			if (!columnExists(db, "agent_actors", "owner_token")) {
				db.exec("ALTER TABLE agent_actors ADD COLUMN owner_token TEXT");
			}
			if (!columnExists(db, "agent_actors", "owner_pid")) {
				db.exec("ALTER TABLE agent_actors ADD COLUMN owner_pid INTEGER");
			}
			if (!columnExists(db, "agent_actors", "lease_until")) {
				db.exec("ALTER TABLE agent_actors ADD COLUMN lease_until TEXT");
			}
			if (!columnExists(db, "agent_actors", "revision")) {
				db.exec("ALTER TABLE agent_actors ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
			}
			if (!columnExists(db, "agent_actors", "recovery_json")) {
				db.exec("ALTER TABLE agent_actors ADD COLUMN recovery_json TEXT");
			}
			db.exec(`
CREATE INDEX IF NOT EXISTS idx_agent_actors_lease
  ON agent_actors(status, lease_until);
`);
		},
	},
	{
		version: 13,
		name: "project-memory-operations-and-metadata",
		up: (db) => {
			if (!columnExists(db, "project_memory", "confidence")) {
				db.exec("ALTER TABLE project_memory ADD COLUMN confidence INTEGER NOT NULL DEFAULT 50");
			}
			if (!columnExists(db, "project_memory", "expires_at")) {
				db.exec("ALTER TABLE project_memory ADD COLUMN expires_at TEXT");
			}
			db.exec(`
CREATE TABLE IF NOT EXISTS project_memory_operations (
  project_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  lease_until TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_memory_operations_lease
  ON project_memory_operations(lease_until);
CREATE TABLE IF NOT EXISTS project_memory_revisions (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  session_id TEXT NOT NULL,
  project_hash TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
		},
	},
	{
		version: 14,
		name: "background-session-metadata",
		up: (db) => {
			if (!columnExists(db, "sessions", "session_kind")) {
				db.exec("ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'conversation'");
			}
			if (!columnExists(db, "sessions", "parent_session_id")) {
				db.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
			}
			if (!columnExists(db, "sessions", "background_kind")) {
				db.exec("ALTER TABLE sessions ADD COLUMN background_kind TEXT");
			}
			db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id, updated_at DESC)");
		},
	},
	{
		version: 15,
		name: "checkpoint-watermark",
		up: (db) => {
			if (!columnExists(db, "sessions", "checkpoint_watermark_seq")) {
				db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_watermark_seq INTEGER");
			}
		},
	},
	{
		version: 16,
		name: "memory-maintenance-scheduler",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS memory_maintenance_schedule (
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  last_claimed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, kind)
) WITHOUT ROWID;
`);
		},
	},
	{
		version: 17,
		name: "session-history-fts-seq-sync",
		up: (db) => {
			// Compaction shifts messages.seq (recordCompactionInTransaction) but the
			// FTS index keyed by seq only had INSERT/DELETE triggers, so shifted rows
			// kept stale seqs and session-history search JOINed to the wrong message.
			// Sync seq on UPDATE and rebuild once to repair any historical staleness.
			db.exec(`
CREATE TRIGGER IF NOT EXISTS session_history_fts_au AFTER UPDATE OF seq ON messages
WHEN OLD.seq != NEW.seq
BEGIN
  DELETE FROM session_history_fts WHERE session_id = OLD.session_id AND seq = OLD.seq;
  INSERT INTO session_history_fts(session_id, seq, role, body)
    VALUES (NEW.session_id, NEW.seq, NEW.role, cast_message_text(NEW.content_json));
END;
`);
			db.exec(`
DELETE FROM session_history_fts;
INSERT INTO session_history_fts(session_id, seq, role, body)
SELECT m.session_id, m.seq, m.role, cast_message_text(m.content_json)
FROM messages AS m
WHERE m.role IN ('user', 'assistant', 'tool');
`);
		},
	},
	{
		version: 18,
		name: "memory-file-index",
		up: (db) => {
			// Full-tree memory file index: every `.md` under the memory
			// root and, when enabled, Claude Code memory, mirrored into FTS5 so the
			// search tool covers checkpoint/notes/task/spillover files, not just the
			// parsed MEMORY.md bullets in project_memory.
			db.exec(`
CREATE TABLE IF NOT EXISTS memory_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_indexed_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_files_fts USING fts5(
  body,
  content='memory_files',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);
CREATE TRIGGER IF NOT EXISTS memory_files_fts_ai AFTER INSERT ON memory_files BEGIN
  INSERT INTO memory_files_fts(rowid, body) VALUES (NEW.id, NEW.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_files_fts_ad AFTER DELETE ON memory_files BEGIN
  INSERT INTO memory_files_fts(memory_files_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
END;
CREATE TRIGGER IF NOT EXISTS memory_files_fts_au AFTER UPDATE ON memory_files BEGIN
  INSERT INTO memory_files_fts(memory_files_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
  INSERT INTO memory_files_fts(rowid, body) VALUES (NEW.id, NEW.body);
END;
`);
		},
	},
	{
		version: 19,
		name: "message-id-watermark",
		up: (db) => {
			// Give every message a stable id so the checkpoint watermark can
			// reference an immutable identity instead of the seq (which compaction
			// shifts). The session's watermark becomes checkpoint_watermark_message_id.
			if (!columnExists(db, "messages", "message_id")) {
				db.exec("ALTER TABLE messages ADD COLUMN message_id TEXT");
			}
			db.exec("UPDATE messages SET message_id = hex(randomblob(16)) WHERE message_id IS NULL");
			db.exec("CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id)");
			if (!columnExists(db, "sessions", "checkpoint_watermark_message_id")) {
				db.exec("ALTER TABLE sessions ADD COLUMN checkpoint_watermark_message_id TEXT");
			}
		},
	},
	{
		version: 20,
		name: "llm-request-telemetry",
		up: (db) => {
			// One row per LLM request (and one per retry/error), for the web
			// dashboard's performance + usage analytics. Append-only; rows are
			// pruned by age. Kept separate from `messages`/`session_events` so a
			// session purge can leave telemetry (or not) independently.
			db.exec(`
CREATE TABLE IF NOT EXISTS llm_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT,
  provider TEXT,
  model TEXT,
  kind TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost REAL,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  retries INTEGER DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_requests_ts ON llm_requests(ts);
CREATE INDEX IF NOT EXISTS idx_llm_requests_provider ON llm_requests(provider);
`);
		},
	},
	{
		version: 21,
		name: "api-request-telemetry",
		up: (db) => {
			// One row per /api/* request (server-side latency for the system
			// performance tab). The dashboard's own telemetry reads are excluded
			// from recording so they don't pollute the data.
			db.exec(`
CREATE TABLE IF NOT EXISTS api_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_requests_ts ON api_requests(ts);
CREATE INDEX IF NOT EXISTS idx_api_requests_path ON api_requests(path);
`);
		},
	},
	{
		version: 22,
		name: "reliability-and-lifecycle-telemetry",
		up: (db) => {
			// Classify retry/error rows (vision, overflow, quota, moderation,
			// upstream, rate-limit) for the reliability tab.
			if (!columnExists(db, "llm_requests", "error_type")) {
				db.exec("ALTER TABLE llm_requests ADD COLUMN error_type TEXT");
			}
			if (!columnExists(db, "llm_requests", "context_window")) {
				db.exec("ALTER TABLE llm_requests ADD COLUMN context_window INTEGER");
			}
			// Per tool call — pattern insights (which tools the model leans on).
			db.exec(`
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  is_error INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts ON tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);
`);
			// Per compaction — lifecycle/context metrics.
			db.exec(`
CREATE TABLE IF NOT EXISTS compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT,
  messages_compacted INTEGER NOT NULL,
  tokens_before INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compactions_ts ON compactions(ts);
`);
		},
	},
	{
		version: 23,
		name: "tool-latency",
		up: (db) => {
			if (!columnExists(db, "tool_calls", "latency_ms")) {
				db.exec("ALTER TABLE tool_calls ADD COLUMN latency_ms INTEGER");
			}
		},
	},
	{
		version: 24,
		name: "turn-id",
		up: (db) => {
			// One user request ("turn") spans several LLM completions and tool
			// calls; clientMessageId groups them for per-turn aggregates.
			if (!columnExists(db, "llm_requests", "turn_id")) {
				db.exec("ALTER TABLE llm_requests ADD COLUMN turn_id TEXT");
			}
			if (!columnExists(db, "tool_calls", "turn_id")) {
				db.exec("ALTER TABLE tool_calls ADD COLUMN turn_id TEXT");
			}
		},
	},
	{
		version: 25,
		name: "memory-maintenance",
		up: (db) => {
			// Per automatic memory run (dream/distill) — how often maintenance
			// runs, whether it completed, and how much it wrote.
			db.exec(`
CREATE TABLE IF NOT EXISTS memory_maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  entries_stored INTEGER,
  entries_removed INTEGER,
  usage_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_maintenance_ts ON memory_maintenance(ts);
`);
		},
	},
	{
		version: 26,
		name: "agents-entity",
		up: (db) => {
			db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  persona TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
`);
		},
	},
	{
		version: 27,
		name: "sessions-version",
		up: (db) => {
			if (!columnExists(db, "sessions", "version")) {
				db.exec("ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
			}
		},
	},
	{
		version: 28,
		name: "sessions-provider-name",
		up: (db) => {
			// provider_url alone can't disambiguate two saved providers that
			// legitimately share a base URL (two keys against the same
			// OpenAI-compatible host) — a session pinned to one could
			// silently run against the other's credentials. provider_name
			// records which saved provider entry was actually chosen.
			if (!columnExists(db, "sessions", "provider_name")) {
				db.exec("ALTER TABLE sessions ADD COLUMN provider_name TEXT");
			}
		},
	},
	{
		version: 29,
		name: "messages-fts-seq-sync",
		up: (db) => {
			// messages_fts only had AFTER INSERT / AFTER DELETE triggers —
			// compaction's marker-insertion path shifts kept messages up by one
			// seq via a plain UPDATE (session.ts, "shiftOne") to make room, which
			// fired neither trigger. Each shifted message's fts row kept its old
			// seq, now silently pointing at whatever the compaction marker (or a
			// later message) ended up occupying — a search hit on that content
			// would resolve to the wrong message. The old row was never cleaned
			// up either, since AFTER DELETE only matches a row's *current* seq,
			// not the stale one the orphan is filed under — dead rows piled up
			// in the index every time a session compacted.
			//
			// A legacy store can have its early migrations (including the one
			// that creates messages_fts) recorded as already-applied via a
			// baseline INSERT into schema_migrations, without that DDL having
			// actually run — skip cleanly rather than fail on a table that
			// genuinely doesn't exist here (db.ts's own getDb() bootstrap
			// handles creating/backfilling it separately in that case).
			if (!tableExists(db, "messages_fts")) return;
			db.exec(`
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF seq ON messages
BEGIN
  UPDATE messages_fts SET seq = NEW.seq WHERE session_id = NEW.session_id AND seq = OLD.seq;
END;
`);
			// Existing databases: a shifted row's stale fts entry can't be
			// told apart from a correct one by seq alone once its old slot is
			// reoccupied by different content (exactly what compaction's
			// marker insertion does) — the only fully correct repair is to
			// rebuild the index from the messages table's current state
			// rather than try to patch individual rows.
			db.exec("DELETE FROM messages_fts;");
			db.exec(`
INSERT INTO messages_fts(session_id, seq, body)
SELECT session_id, seq, cast_message_text(content_json)
FROM messages
WHERE role IN ('user', 'assistant');
`);
		},
	},
	{
		// 30-32 are taken by another line of this codebase (users/multi-tenant),
		// whose rows are already in real databases — see the name-mismatch
		// warning in runMigrations below.
		version: 33,
		name: "compact-actor-fork-json",
		up: (db) => {
			// `fork_json` used to serialize the same transcript three times over
			// — `messages`, `inheritedMessages` and `prefix`+`tail` are all views
			// of it, sharing objects in memory but expanded into full copies by
			// JSON. On one real store that was 140MB of a 547MB database, with
			// the largest single row 21MB holding 7.8MB of distinct data. Writes
			// now store the transcript and the boundary only, and rebuild the
			// views on read; drop the redundant copies from rows already on
			// disk, which the same reader handles either way.
			if (!tableExists(db, "agent_actors")) return;
			db.exec(
				"UPDATE agent_actors SET fork_json = json_remove(fork_json, '$.inheritedMessages', '$.prefix', '$.tail') WHERE fork_json IS NOT NULL",
			);
		},
	},
	{
		version: 34,
		name: "messages-fts-seq-sync-repair",
		up: (db) => {
			// Version 29 in this line of the codebase is "messages-fts-seq-sync";
			// in another line it is "users-and-multi-tenant-columns". A database
			// that saw the latter has 29 recorded, so this line's 29 was skipped
			// as already-applied and its messages_fts_au trigger was never
			// created — leaving exactly the stale-seq search bug that migration
			// was written to fix. Verified on a real store: session_history_fts_au
			// present, messages_fts_au missing.
			//
			// Idempotent: does nothing when the trigger is already there, so a
			// database that did run 29 properly is untouched.
			if (!tableExists(db, "messages_fts")) return;
			const hasTrigger =
				db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'messages_fts_au'").get() !==
				undefined;
			if (hasTrigger) return;
			db.exec(`
CREATE TRIGGER messages_fts_au AFTER UPDATE OF seq ON messages
BEGIN
  UPDATE messages_fts SET seq = NEW.seq WHERE session_id = NEW.session_id AND seq = OLD.seq;
END;
`);
			// Same reasoning as migration 29: a stale entry can't be told from a
			// correct one once its old slot is reoccupied, so rebuild.
			db.exec("DELETE FROM messages_fts;");
			db.exec(`
INSERT INTO messages_fts(session_id, seq, body)
SELECT session_id, seq, cast_message_text(content_json)
FROM messages
WHERE role IN ('user', 'assistant');
`);
		},
	},
	{
		version: 35,
		name: "drop-redundant-messages-fts",
		up: (db) => {
			// messages_fts indexed exactly the user/assistant subset of
			// session_history_fts, which also carries `role` — so the same
			// searches can be answered from one index (verified identical result
			// sets against a real store). Keeping both meant every message write
			// updated two FTS indexes and the store carried two copies of the
			// same text: messages_fts was ~11MB of a 547MB database.
			db.exec(`
DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;
DROP TABLE IF EXISTS messages_fts;
`);
		},
	},
];

const MIGRATION_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/**
 * Run pending migrations. Safe to call on every `getDb()`: it is a no-op once
 * all migrations are recorded. Each `up()` is idempotent (CREATE IF NOT EXISTS
 * / columnExists guards), so a pre-migrations database — tables exist, no
 * `schema_migrations` row — converges by running the missing increments (e.g.
 * a table added in a later migration) without touching already-present schema.
 */
/** The migration's own version when that number is free, otherwise the next
 *  number past everything recorded. `version` is a PRIMARY KEY and another
 *  line of this codebase may hold this one for a different migration; the
 *  number only orders the log, the name is the identity. */
function freeVersionFor(db: DatabaseSync, preferred: number): number {
	const taken = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(preferred) !== undefined;
	if (!taken) return preferred;
	const row = db.prepare("SELECT MAX(version) AS max FROM schema_migrations").get() as { max: number | null };
	return (row.max ?? preferred) + 1;
}

export function runMigrations(db: DatabaseSync): void {
	db.exec(MIGRATION_TABLE_SCHEMA);

	// Identified by NAME, not by version number.
	//
	// Two lines of this codebase evolved the same schema and assigned the same
	// version numbers to different migrations — a real store has 29-32 taken by
	// the multi-tenant line's migrations, which meant this line's 29 was
	// treated as already-applied and its work silently never happened. A number
	// is a poor identity for that reason; a name isn't, and it's already
	// recorded. So: apply a migration when its *name* has never been recorded,
	// and record it under a version number that is actually free.
	//
	// Every up() is idempotent (CREATE IF NOT EXISTS / columnExists guards), so
	// a migration re-run against a database that already has its schema — a
	// pre-migrations store, or one where the other line did the equivalent work
	// — is a no-op rather than an error.
	const appliedNames = new Set(
		(db.prepare("SELECT name FROM schema_migrations").all() as Array<{ name: string }>).map((row) => row.name),
	);

	for (const migration of MIGRATIONS) {
		if (appliedNames.has(migration.name)) continue;
		// IMMEDIATE, and the applied-check repeated inside the transaction:
		// `appliedNames` above was read before any transaction, and several
		// processes migrate independently (the daemon, a TUI picker, `cast
		// run`, an ACP connection each open their own connection). Two of them
		// starting during the same upgrade both saw this migration as pending —
		// the second one's idempotent DDL then succeeded and its bookkeeping
		// INSERT failed, rolling back and throwing out of getDb(). A deferred
		// BEGIN also doesn't honour busy_timeout on its first write, so it
		// failed instantly instead of waiting for the other process to finish.
		db.exec("BEGIN IMMEDIATE");
		try {
			const alreadyApplied =
				db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migration.name) !== undefined;
			if (alreadyApplied) {
				db.exec("COMMIT");
				appliedNames.add(migration.name);
				continue;
			}
			migration.up(db);
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				freeVersionFor(db, migration.version),
				migration.name,
				new Date().toISOString(),
			);
			db.exec("COMMIT");
			appliedNames.add(migration.name);
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	}
}
