import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "../src/core/migrations.ts";

// Versioned-schema tests: runMigrations against a throwaway SQLite file.
// Covers the three lifecycle states — brand-new DB, pre-migrations DB
// (baseline: tables exist, no schema_migrations row), and already-migrated
// (idempotent no-op) — plus the FTS backfill path.
describe("schema migrations", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-migrations-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const openDb = (name: string): DatabaseSync => {
		const db = new DatabaseSync(join(dir, name));
		// Replicate getDb()'s function registration (migrations' FTS triggers
		// reference it).
		db.function("cast_message_text", { deterministic: true }, (json: unknown) => {
			try {
				const m = JSON.parse(String(json)) as { content?: unknown };
				if (typeof m.content === "string") return m.content;
				if (Array.isArray(m.content)) {
					const part = m.content.find((p: { type?: string }) => p?.type === "text") as
						| { text?: string }
						| undefined;
					return part?.text ?? "";
				}
			} catch {
				/* ignore */
			}
			return "";
		});
		return db;
	};

	const appliedVersions = (db: DatabaseSync): number[] =>
		(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(
			(r) => r.version,
		);

	it("creates the full schema on a brand-new database and records all migrations", () => {
		const db = openDb("fresh.db");
		runMigrations(db);
		expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
		for (const table of [
			"sessions",
			"messages",
			"session_events",
			"web_sessions",
			"session_checkpoints",
			"subagent_runs",
			"messages_fts",
		]) {
			const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
			expect(row, `table ${table} exists`).toBeTruthy();
		}
		db.close();
	});

	it("is idempotent on a second run", () => {
		const db = openDb("again.db");
		runMigrations(db);
		runMigrations(db);
		expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
		// FTS rows for inserted messages survive a second run's backfill check.
		db.prepare("INSERT INTO sessions (id, created_at, updated_at, usage_json) VALUES ('s1', 't', 't', '{}')").run();
		db.prepare("INSERT INTO messages (session_id, seq, role, content_json) VALUES ('s1', 0, 'user', ?)").run(
			JSON.stringify({ role: "user", content: "hello world" }),
		);
		runMigrations(db);
		const fts = db.prepare("SELECT count(*) AS c FROM messages_fts").get() as { c: number };
		expect(fts.c).toBe(1);
		db.close();
	});

	it("treats a pre-migrations database as already migrated (baseline)", () => {
		const db = openDb("legacy.db");
		// Simulate a store that predates schema_migrations: only `sessions` +
		// `messages` exist (the original design), with a row already there.
		db.exec(`
			CREATE TABLE sessions (
			  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, usage_json TEXT NOT NULL
			);
			CREATE TABLE messages (
			  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
			  role TEXT NOT NULL, content_json TEXT NOT NULL,
			  in_context INTEGER NOT NULL DEFAULT 1,
			  PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID;
			INSERT INTO sessions (id, created_at, updated_at, usage_json) VALUES ('s1', 't', 't', '{}');
			INSERT INTO messages (session_id, seq, role, content_json) VALUES ('s1', 0, 'user', '{"role":"user","content":"hi"}');
		`);
		runMigrations(db);
		// Baseline: all migrations recorded, existing data untouched.
		expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
		const data = db.prepare("SELECT count(*) AS c FROM messages").get() as { c: number };
		expect(data.c).toBe(1);
		// Later migrations (columns added on top of the legacy base) still apply.
		const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
		expect(cols).toContain("todos_json");
		db.close();
	});

	it("runs only the migrations added after the baseline on an existing store", () => {
		const db = openDb("partial.db");
		db.exec(`
			CREATE TABLE sessions (
			  id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, usage_json TEXT NOT NULL
			);
			CREATE TABLE messages (
			  session_id TEXT NOT NULL, seq INTEGER NOT NULL,
			  role TEXT NOT NULL, content_json TEXT NOT NULL,
			  in_context INTEGER NOT NULL DEFAULT 1,
			  PRIMARY KEY (session_id, seq)
			) WITHOUT ROWID;
			CREATE TABLE schema_migrations (
			  version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
			);
			INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'baseline-schema', 't');
		`);
		runMigrations(db);
		// v2-v4 applied on top of the recorded baseline; v1 stays recorded.
		expect(appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version));
		const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
		expect(cols).toContain("todos_json");
		db.close();
	});
});
