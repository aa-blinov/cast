import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	createSession,
	listSessionSummariesAsync,
	saveSession,
	searchSessionSummariesAsync,
} from "../src/core/session.ts";

vi.mock("../src/core/sqlite-reader.ts", () => ({
	queryReadOnly: vi.fn(async () => {
		throw new Error("worker unavailable");
	}),
}));

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-summaries-fallback-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
	const session = createSession("test-model", join(root, "p"));
	session.title = "Fallback";
	session.messages = [{ role: "user", content: "a fallback zebra" }];
	saveSession(session);
});

afterEach(() => {
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

describe("session summaries when the worker fails", () => {
	it("still lists and searches, from the main connection", async () => {
		expect((await listSessionSummariesAsync()).map((s) => s.title)).toEqual(["Fallback"]);
		expect(await searchSessionSummariesAsync("zebra")).toHaveLength(1);
	});
});
