import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import { appendMessage, compactMessages, createSession, recordCompaction, saveSession } from "../src/core/session.ts";
import {
	execSessionHistorySearch,
	formatSessionHistoryToolResult,
	searchSessionHistory,
} from "../src/core/session-query.ts";

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

	it("scope=global searches across every project, not just the current cwd", () => {
		const project = join(root, "project");
		const otherProject = join(root, "other");
		const current = createSession("test-model", project);
		current.messages = [{ role: "user", content: "the second brain question about zebras" }];
		saveSession(current);
		const other = createSession("test-model", otherProject);
		other.messages = [{ role: "assistant", content: "the answer about zebras lives in another project" }];
		saveSession(other);

		const scoped = searchSessionHistory(project, "zebras");
		expect(scoped.every((result) => result.sessionId === current.id)).toBe(true);

		const global = searchSessionHistory(project, "zebras", 8, "global");
		const globalIds = new Set(global.map((result) => result.sessionId));
		expect(globalIds.has(current.id)).toBe(true);
		expect(globalIds.has(other.id)).toBe(true);
		expect(formatSessionHistoryToolResult("zebras", global)).toContain("another project");
	});

	it("returns no results for an empty or unknown query", () => {
		const project = join(root, "project");
		expect(searchSessionHistory(project, "")).toEqual([]);
		expect(searchSessionHistory(project, "no-such-history-term")).toEqual([]);
	});

	it("keeps search results attached to the right message after compaction shifts seq", async () => {
		const project = join(root, "project");
		const session = createSession("test-model", project, { id: "fts-seq-sync-session" });
		const messages = [
			{ role: "user", content: "question zero about the project" },
			{ role: "assistant", content: "answer zero with some detail" },
			{ role: "user", content: "question one about the project" },
			{ role: "assistant", content: "answer one with some detail" },
			{ role: "user", content: "question two about the project" },
			{ role: "assistant", content: "answer two with some detail" },
			{ role: "user", content: "question three about the project" },
			{ role: "assistant", content: "answer three with some detail" },
			{ role: "user", content: "question four about the project" },
			{ role: "assistant", content: "answer four with some detail" },
			{ role: "user", content: "next question about zebras" },
			{ role: "assistant", content: "zebra answer" },
		];
		for (const message of messages) appendMessage(session, message);
		saveSession(session);

		const compacted = await compactMessages(messages, async () => "summary marker", {
			baseURL: "https://example.invalid",
			contextWindow: 1000,
			apiKey: "test",
		});
		expect(compacted.summary.messagesCompacted).toBeGreaterThan(0);
		recordCompaction(session, messages, compacted.messages);

		const results = searchSessionHistory(project, "zebra");
		expect(results).toHaveLength(1);
		expect(results[0]!.snippet).toContain("zebra answer");
		expect(results[0]!.role).toBe("assistant");
	});
});

describe("execSessionHistorySearch — argument validation", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-session-query-args-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("caps the number of search terms instead of stalling the daemon (regression)", () => {
		// The terms are OR-ed into an FTS5 MATCH and node:sqlite is
		// synchronous: a 100,000-word query measured 50 seconds with the event
		// loop blocked for all of it — every session, the web UI and every SSE
		// stream stalled. The input is whatever the model passes.
		const words = Array.from({ length: 100_000 }, (_, i) => `w${i}`).join(" ");
		const started = Date.now();
		const result = execSessionHistorySearch({ query: words }, root);
		const elapsed = Date.now() - started;

		expect(result.isError).toBeFalsy();
		// Two orders of magnitude of headroom against the 50s it took before.
		expect(elapsed).toBeLessThan(5000);
		// And it says the query was cut, so unrelated-looking results make sense.
		expect(result.content).toMatch(/searched the first 32 of 100000 terms/);
	});

	it("rejects a limit that is not a positive integer", () => {
		// `Number(args.limit) || MAX_RESULTS` let anything through: a negative
		// limit reached SQL as `LIMIT -3` and returned a single row, reported as
		// "Found 1 session history result" — indistinguishable from there being
		// exactly one. `limit: 0` silently meant the default, and a fractional
		// one surfaced SQLite's "datatype mismatch" as an unexplained failure.
		for (const limit of [-3, 0, 1.5, "5"]) {
			const result = execSessionHistorySearch({ query: "anything", limit }, root);
			expect(result.isError).toBe(true);
			expect(result.content).toMatch(/positive integer/);
		}
	});

	it("rejects an unknown scope rather than answering from the project scope", () => {
		const result = execSessionHistorySearch({ query: "anything", scope: "everything" }, root);
		expect(result.isError).toBe(true);
		expect(result.content).toMatch(/unknown scope/i);
	});

	it("accepts the documented arguments", () => {
		expect(execSessionHistorySearch({ query: "anything" }, root).isError).toBeFalsy();
		expect(execSessionHistorySearch({ query: "anything", limit: 3 }, root).isError).toBeFalsy();
		expect(execSessionHistorySearch({ query: "anything", scope: "global" }, root).isError).toBeFalsy();
		expect(execSessionHistorySearch({ query: "anything", scope: "project" }, root).isError).toBeFalsy();
	});
});

describe("compaction summary size", () => {
	// The mirror of the empty-summary case: a model that answers a
	// summarization request with a wall of text made compaction *grow* the
	// context, so the next turn sat closer to the ceiling, tripped the
	// threshold again, and paid for another summarization that could do the
	// same thing.
	it("clamps a summary that would make the context bigger", async () => {
		const filler = "x".repeat(4000);
		const messages: Message[] = [{ role: "system", content: "persona" }];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: "user", content: `q${i} ${filler}` });
			messages.push({ role: "assistant", content: `a${i} ${filler}` });
		}
		const before = JSON.stringify(messages).length;

		const compacted = await compactMessages(messages, async () => "S".repeat(400_000), {
			baseURL: "https://example.invalid",
			contextWindow: 128_000,
			apiKey: "test",
		} as never);

		const after = JSON.stringify(compacted.messages).length;
		expect(after, "compaction must shrink the context, not grow it").toBeLessThan(before);
		expect(compacted.summary.summary).toContain("Summary truncated at");
	});

	it("keeps a normal-sized summary verbatim", async () => {
		const filler = "y".repeat(4000);
		const messages: Message[] = [{ role: "system", content: "persona" }];
		for (let i = 0; i < 30; i++) {
			messages.push({ role: "user", content: `q${i} ${filler}` });
			messages.push({ role: "assistant", content: `a${i} ${filler}` });
		}
		const compacted = await compactMessages(messages, async () => "a concise summary", {
			baseURL: "https://example.invalid",
			contextWindow: 128_000,
			apiKey: "test",
		} as never);
		expect(compacted.summary.summary).toContain("a concise summary");
		expect(compacted.summary.summary).not.toContain("truncated");
	});
});
