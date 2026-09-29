import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import { createSession, deleteMessagesFrom, loadSession, saveSession } from "../src/core/session.ts";
import { searchSessionHistory } from "../src/core/session-query.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-undo-persist-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(() => {
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

const roles = (id: string) =>
	(loadSession(id)?.messages ?? []).map((m) => `${m.role[0]}:${typeof m.content === "string" ? m.content : ""}`);

function seeded() {
	const session = createSession("test-model", join(root, "project"));
	session.messages = [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: "first answer" },
		{ role: "user", content: "second zebra question" },
		{ role: "assistant", content: "second zebra answer" },
	] as Message[];
	saveSession(session);
	return session;
}

describe("deleteMessagesFrom", () => {
	it("removes the message and everything after it from the store, not just from memory", () => {
		const session = seeded();
		expect(deleteMessagesFrom(session, session.messages[2] as Message)).toBe(2);
		expect(roles(session.id)).toEqual(["u:first question", "a:first answer"]);
	});

	it("is what saveSession alone cannot do: slicing the array does not shorten the store", () => {
		const session = seeded();
		session.messages = session.messages.slice(0, 2);
		saveSession(session);
		expect(roles(session.id)).toHaveLength(4);
	});

	it("takes the deleted messages out of the history search", () => {
		const session = seeded();
		expect(searchSessionHistory(join(root, "project"), "zebra")).toHaveLength(2);
		deleteMessagesFrom(session, session.messages[2] as Message);
		expect(searchSessionHistory(join(root, "project"), "zebra")).toEqual([]);
	});

	it("lets the conversation continue after the cut", () => {
		const session = seeded();
		deleteMessagesFrom(session, session.messages[2] as Message);
		session.messages = session.messages.slice(0, 2);
		session.messages.push({ role: "user", content: "a different second question" } as Message);
		saveSession(session);
		expect(roles(session.id)).toEqual(["u:first question", "a:first answer", "u:a different second question"]);
	});

	it("does nothing for a message that was never stored", () => {
		const session = seeded();
		expect(deleteMessagesFrom(session, { role: "user", content: "never saved" } as Message)).toBe(0);
		expect(roles(session.id)).toHaveLength(4);
	});
});
