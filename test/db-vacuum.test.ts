import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reclaimFreePages } from "../src/core/db.ts";

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

	function freelist(): number {
		const row = db.prepare("PRAGMA freelist_count").get() as Record<string, unknown>;
		return Number(Object.values(row)[0]);
	}

	it("returns the free pages to the filesystem once both thresholds are met", () => {
		fill(600);
		db.exec("DELETE FROM blobs");
		const sizeBefore = statSync(path).size;
		expect(freelist()).toBeGreaterThan(0);

		const ran = reclaimFreePages(db, { minFreeBytes: 1024 * 1024, minFreeShare: 0.2, quiet: true });

		expect(ran).toBe(true);
		expect(freelist()).toBe(0);
		expect(statSync(path).size).toBeLessThan(sizeBefore / 2);
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
