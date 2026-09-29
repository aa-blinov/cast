import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { createSession, saveSession } from "../src/core/session.ts";
import { searchSessionHistoryAsync } from "../src/core/session-query.ts";

vi.mock("../src/core/sqlite-reader.ts", () => ({
	queryReadOnly: vi.fn(async () => {
		throw new Error("worker unavailable");
	}),
}));

describe("history search when the worker fails", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-session-query-fallback-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("answers from the main connection instead of failing", async () => {
		const session = createSession("test-model", join(root, "project"));
		session.messages = [{ role: "user", content: "a fallback zebra" }];
		saveSession(session);
		const results = await searchSessionHistoryAsync(join(root, "project"), "zebra");
		expect(results).toHaveLength(1);
	});

	it("searches an in-memory store in-thread, since a worker can't share it", async () => {
		process.env.CAST_SESSIONS_DB = ":memory:";
		resetDbConnectionForTests();
		const session = createSession("test-model", join(root, "project"));
		session.messages = [{ role: "user", content: "memory zebra" }];
		saveSession(session);
		expect(await searchSessionHistoryAsync(join(root, "project"), "zebra")).toHaveLength(1);
	});
});
