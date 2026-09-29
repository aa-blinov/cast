import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryReadOnly, stopSqliteReader } from "../src/core/sqlite-reader.ts";

let dir = "";
let path = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-sqlite-reader-"));
	path = join(dir, "t.db");
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (n INTEGER, s TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b');");
	db.close();
});

afterEach(async () => {
	await stopSqliteReader();
	rmSync(dir, { recursive: true, force: true });
});

describe("queryReadOnly", () => {
	it("runs a parameterised select", async () => {
		expect(await queryReadOnly(path, "SELECT n, s FROM t WHERE n > ? ORDER BY n", [1])).toEqual([{ n: 2, s: "b" }]);
	});

	it("refuses to write", async () => {
		await expect(queryReadOnly(path, "INSERT INTO t VALUES (3, 'c')", [])).rejects.toThrow(/readonly/i);
	});

	it("reports a bad statement and keeps answering", async () => {
		await expect(queryReadOnly(path, "SELECT nope FROM missing", [])).rejects.toThrow();
		expect(await queryReadOnly(path, "SELECT count(*) AS c FROM t", [])).toEqual([{ c: 2 }]);
	});

	it("follows the path it is given", async () => {
		const other = join(dir, "other.db");
		const db = new DatabaseSync(other);
		db.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (42);");
		db.close();
		expect(await queryReadOnly(path, "SELECT count(*) AS c FROM t", [])).toEqual([{ c: 2 }]);
		expect(await queryReadOnly(other, "SELECT n FROM t", [])).toEqual([{ n: 42 }]);
	});

	it("starts a fresh worker after being stopped", async () => {
		await queryReadOnly(path, "SELECT 1 AS x", []);
		await stopSqliteReader();
		expect(await queryReadOnly(path, "SELECT 2 AS x", [])).toEqual([{ x: 2 }]);
	});

	it("rejects a store that can't be opened", async () => {
		await expect(queryReadOnly(join(dir, "missing", "x.db"), "SELECT 1", [])).rejects.toThrow();
	});
});
