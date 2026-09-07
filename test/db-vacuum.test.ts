import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, reclaimFreePages, resetDbConnectionForTests } from "../src/core/db.ts";

/**
 * SQLite never shrinks a file on its own, and `auto_vacuum` is off. cast
 * prunes sessions, events and background runs on a retention policy, so the
 * space is genuinely freed — it just stayed claimed by the file. A real store
 * measured 547MB on disk of which 219MB (40%) were free pages, with nothing
 * in the codebase that would ever return them; a VACUUM took 2.0s and brought
 * it to 324MB.
 */
describe("reclaimFreePages", () => {
	let dir: string;
	let path: string;
	let db: DatabaseSync;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cast-vacuum-"));
		path = join(dir, "test.db");
		db = new DatabaseSync(path);
		db.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT)");
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			// already closed
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function fill(rows: number): void {
		const insert = db.prepare("INSERT INTO blobs (body) VALUES (?)");
		const blob = "x".repeat(16 * 1024);
		db.exec("BEGIN");
		for (let i = 0; i < rows; i++) insert.run(blob);
		db.exec("COMMIT");
	}

	function walSize(): number {
		return existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
	}

	function onDiskSize(): number {
		return statSync(path).size + walSize();
	}

	function freelist(): number {
		const row = db.prepare("PRAGMA freelist_count").get() as Record<string, unknown>;
		return Number(Object.values(row)[0]);
	}

	it("returns the free pages to the filesystem once both thresholds are met", () => {
		db.exec("PRAGMA journal_mode = WAL");
		fill(600);
		db.exec("DELETE FROM blobs");
		const sizeBefore = onDiskSize();
		expect(freelist()).toBeGreaterThan(0);

		const ran = reclaimFreePages(db, { minFreeBytes: 1024 * 1024, minFreeShare: 0.2, quiet: true });

		expect(ran).toBe(true);
		expect(freelist()).toBe(0);
		// Measured across db + WAL on purpose: in WAL mode a VACUUM writes the
		// whole rebuilt database into the log, so checking the .db file alone
		// would call a 547MB→(324MB db + 326MB WAL) move a saving. It was not.
		expect(onDiskSize()).toBeLessThan(sizeBefore / 2);
		expect(walSize()).toBeLessThan(1024 * 1024);
	});

	it("does nothing when the free space is below the byte threshold", () => {
		fill(50);
		db.exec("DELETE FROM blobs");
		const sizeBefore = statSync(path).size;

		// Real default: 64MB. A small file never pays for a write lock.
		const ran = reclaimFreePages(db, { quiet: true });

		expect(ran).toBe(false);
		expect(statSync(path).size).toBe(sizeBefore);
	});

	it("does nothing when the free share is below the threshold, however big the file", () => {
		fill(600);
		// Delete a sliver: plenty of bytes in the file, few free pages.
		db.exec("DELETE FROM blobs WHERE id <= 20");
		const sizeBefore = statSync(path).size;

		const ran = reclaimFreePages(db, { minFreeBytes: 1024, minFreeShare: 0.5, quiet: true });

		expect(ran).toBe(false);
		expect(statSync(path).size).toBe(sizeBefore);
	});
});

describe("opening a damaged store", () => {
	let realHome: string | undefined;
	let home: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "cast-badstore-"));
		process.env.HOME = home;
		delete process.env.CAST_SESSIONS_DB;
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	});

	it("explains what to do instead of surfacing SQLite's own wording", () => {
		// A truncated or overwritten store made cast exit with "Error: file is
		// not a database" and a stack through the minified bundle — nothing
		// naming the file, nothing saying what to do. Verified live: the daemon
		// log held pages of that.
		const dir = join(home, ".cast", "sessions");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "sessions.db");
		writeFileSync(path, randomBytes(40 * 1024));

		let error: Error | undefined;
		try {
			getDb();
		} catch (err) {
			error = err as Error;
		}

		expect(error).toBeDefined();
		expect(error?.message).toContain(path);
		expect(error?.message).toMatch(/not a readable SQLite database/i);
		expect(error?.message).toContain("Nothing was changed");
		expect(error?.message).toContain(".broken");
		// And the file really is untouched: it may be the only copy of the
		// user's history, so a wrong guess here would destroy it.
		expect(statSync(path).size).toBe(40 * 1024);
	});
});
