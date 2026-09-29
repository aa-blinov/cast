import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	createSession,
	listSessionSummaries,
	listSessionSummariesAsync,
	saveSession,
	searchSessionSummaries,
	searchSessionSummariesAsync,
} from "../src/core/session.ts";
import { stopSqliteReader } from "../src/core/sqlite-reader.ts";

let root = "";

function seed(cwd: string, title: string, texts: string[]) {
	const session = createSession("test-model", join(root, cwd));
	session.title = title;
	session.messages = texts.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }) as never);
	saveSession(session);
	return session;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-summaries-async-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(async () => {
	await stopSqliteReader();
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

describe("session summaries on the sqlite worker", () => {
	it("lists what the in-thread list lists", async () => {
		seed("a", "First", ["hello there", "hi", "more", "ok"]);
		seed("b", "Second", ["another topic", "reply"]);
		const sync = listSessionSummaries();
		expect(sync).toHaveLength(2);
		expect(await listSessionSummariesAsync()).toEqual(sync);
	});

	it("returns an empty list for an empty store", async () => {
		expect(await listSessionSummariesAsync()).toEqual([]);
	});

	it("sees a session saved just before the call", async () => {
		seed("a", "First", ["one"]);
		await listSessionSummariesAsync();
		seed("b", "Second", ["two"]);
		expect((await listSessionSummariesAsync()).map((s) => s.title).sort()).toEqual(["First", "Second"]);
	});

	it.each(["zebra", "ze", "second", "zebra crossing", "no-such-thing", "  "])(
		"searches %j like the in-thread search",
		async (query) => {
			seed("a", "First", ["the zebra crossing bug", "fixed it"]);
			seed("b", "Second", ["something else", "zebras everywhere"]);
			expect(await searchSessionSummariesAsync(query)).toEqual(searchSessionSummaries(query));
		},
	);

	it("keeps ranking: a title hit outranks a message hit", async () => {
		seed("a", "unrelated", ["we talked about pineapple"]);
		seed("b", "pineapple notes", ["nothing to see"]);
		const found = await searchSessionSummariesAsync("pineapple");
		expect(found.map((s) => s.title)).toEqual(["pineapple notes", "unrelated"]);
	});

	it("works on an in-memory store, which a worker can't share", async () => {
		process.env.CAST_SESSIONS_DB = ":memory:";
		resetDbConnectionForTests();
		seed("a", "Mem", ["memory zebra"]);
		expect(await listSessionSummariesAsync()).toHaveLength(1);
		expect(await searchSessionSummariesAsync("zebra")).toHaveLength(1);
	});
});
