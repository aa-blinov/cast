import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { createSession, saveSession } from "../src/core/session.ts";
import { formatSessionHistoryToolResult, searchSessionHistory } from "../src/core/session-query.ts";

describe("session history search", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-session-query-test-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("searches prior messages in the current project without using durable memory", () => {
		const project = join(root, "project");
		const otherProject = join(root, "other");
		const current = createSession("test-model", project);
		current.messages = [
			{ role: "user", content: "We chose the reconnect watermark for SSE." },
			{ role: "assistant", content: "The watermark is persisted with the client id." },
		];
		saveSession(current);

		const other = createSession("test-model", otherProject);
		other.messages = [{ role: "user", content: "We chose the reconnect watermark for SSE." }];
		saveSession(other);

		const results = searchSessionHistory(project, "reconnect watermark");
		expect(results).toHaveLength(2);
		expect(results.every((result) => result.sessionId === current.id)).toBe(true);
		expect(formatSessionHistoryToolResult("reconnect watermark", results)).toContain("SSE");
	});

	it("returns no results for an empty or unknown query", () => {
		const project = join(root, "project");
		expect(searchSessionHistory(project, "")).toEqual([]);
		expect(searchSessionHistory(project, "no-such-history-term")).toEqual([]);
	});
});
