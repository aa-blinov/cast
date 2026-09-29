import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import {
	createSession,
	forkCutAfterReply,
	forkSession,
	getFullHistoryWithReasoning,
	listForkPoints,
	saveSession,
} from "../src/core/session.ts";
import type { ServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

let root = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-fork-after-"));
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(() => {
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	rmSync(root, { recursive: true, force: true });
});

const call = { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } };

/** Two turns: the first a plain answer, the second a tool round and then the answer. */
function conversation() {
	const session = createSession("test-model", join(root, "project"));
	session.messages = [
		{ role: "system", content: "system prompt" },
		{ role: "user", content: "first question" },
		{ role: "assistant", content: "first answer" },
		{ role: "user", content: "second question" },
		{ role: "assistant", content: "", tool_calls: [call] },
		{ role: "tool", tool_call_id: "c1", content: "tool output" },
		{ role: "assistant", content: "second answer" },
	] as Message[];
	saveSession(session);
	const { seqs } = getFullHistoryWithReasoning(session.id);
	// seq by role for readability
	return {
		session,
		seqs: {
			firstUser: seqs[1]!,
			firstAnswer: seqs[2]!,
			secondUser: seqs[3]!,
			toolCall: seqs[4]!,
			secondAnswer: seqs[6]!,
		},
	};
}

const texts = (messages: Message[]) => messages.map((m) => (typeof m.content === "string" ? m.content : ""));

describe("forkCutAfterReply", () => {
	it("cuts before the message that follows a turn's answer", () => {
		const { session, seqs } = conversation();
		expect(forkCutAfterReply(session.id, seqs.firstAnswer)).toEqual({ ok: true, beforeSeq: seqs.secondUser });
	});

	it("gives no cut for the last answer: that is the whole session", () => {
		const { session, seqs } = conversation();
		expect(forkCutAfterReply(session.id, seqs.secondAnswer)).toEqual({ ok: true, beforeSeq: undefined });
	});

	it("refuses a message that calls tools, a user message and an unknown seq", () => {
		const { session, seqs } = conversation();
		expect(forkCutAfterReply(session.id, seqs.toolCall)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/calls tools/),
		});
		expect(forkCutAfterReply(session.id, seqs.firstUser)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/agent's answer/),
		});
		expect(forkCutAfterReply(session.id, 9999)).toMatchObject({
			ok: false,
			error: expect.stringMatching(/No message/),
		});
	});

	it("makes a fork that keeps the answer and stops there", () => {
		const { session, seqs } = conversation();
		const cut = forkCutAfterReply(session.id, seqs.firstAnswer);
		if (!cut.ok) throw new Error(cut.error);
		const fork = forkSession(session, cut.beforeSeq);
		expect(texts(fork.messages)).toEqual(["system prompt", "first question", "first answer"]);
	});

	it("keeps the whole tool round when forking through a later answer", () => {
		const { session, seqs } = conversation();
		const cut = forkCutAfterReply(session.id, seqs.secondAnswer);
		if (!cut.ok) throw new Error(cut.error);
		const fork = forkSession(session, cut.beforeSeq);
		expect(texts(fork.messages)).toEqual(texts(session.messages));
		expect(fork.messages.some((m) => m.role === "tool")).toBe(true);
	});
});

describe("POST /fork with afterSeq", () => {
	let server: ReturnType<typeof startServer>;
	let origin = "";
	let cookie = "";
	let captured: { called: boolean; beforeSeq?: number };
	let status: "idle" | "running";
	let sessionId = "";

	beforeEach(async () => {
		captured = { called: false };
		status = "idle";
		const bridge = {
			getSession: (id: string) => (id === sessionId ? { id, status, session: { cwd: root } } : undefined),
			forkSession: (_id: string, beforeSeq?: number) => {
				captured = { called: true, beforeSeq };
				return { id: "forked", session: { id: "forked" } };
			},
		} as unknown as ServerBridge;
		server = startServer({
			port: 0,
			host: "127.0.0.1",
			bridge,
			webUser: "cast",
			serverPassword: "pw",
			version: "test",
		});
		await once(server, "listening");
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const login = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "pw" }),
		});
		cookie = login.headers.get("set-cookie") ?? "";
	});

	afterEach(async () => {
		server.close();
		await once(server, "close");
	});

	const fork = (body: unknown) =>
		fetch(`${origin}/api/sessions/${sessionId}/fork`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	it("turns an answer's seq into the cut before the next message", async () => {
		const { session, seqs } = conversation();
		sessionId = session.id;
		expect((await fork({ afterSeq: seqs.firstAnswer })).status).toBe(201);
		expect(captured).toEqual({ called: true, beforeSeq: seqs.secondUser });
	});

	it("forks everything for the last answer", async () => {
		const { session, seqs } = conversation();
		sessionId = session.id;
		expect((await fork({ afterSeq: seqs.secondAnswer })).status).toBe(201);
		expect(captured).toEqual({ called: true, beforeSeq: undefined });
	});

	it("still takes beforeSeq as before", async () => {
		const { session, seqs } = conversation();
		sessionId = session.id;
		expect((await fork({ beforeSeq: seqs.secondUser })).status).toBe(201);
		expect(captured.beforeSeq).toBe(seqs.secondUser);
	});

	it("rejects a message that is not an answer, both parameters, and a non-integer", async () => {
		const { session, seqs } = conversation();
		sessionId = session.id;
		expect((await fork({ afterSeq: seqs.toolCall })).status).toBe(400);
		expect((await fork({ afterSeq: seqs.firstUser })).status).toBe(400);
		expect((await fork({ afterSeq: 1, beforeSeq: 2 })).status).toBe(400);
		expect((await fork({ afterSeq: "x" })).status).toBe(400);
		expect(captured.called).toBe(false);
	});

	it("refuses while the agent is running", async () => {
		const { session, seqs } = conversation();
		sessionId = session.id;
		status = "running";
		expect((await fork({ afterSeq: seqs.firstAnswer })).status).toBe(409);
		expect(captured.called).toBe(false);
	});
});

describe("listForkPoints answers", () => {
	it("names each prompt's final answer, skipping the tool round in between", () => {
		const { session, seqs } = conversation();
		expect(listForkPoints(session.id)).toEqual([
			{ seq: seqs.firstUser, text: "first question", answerSeq: seqs.firstAnswer },
			{ seq: seqs.secondUser, text: "second question", answerSeq: seqs.secondAnswer },
		]);
	});

	it("leaves answerSeq out for a prompt that was never answered", () => {
		const session = createSession("test-model", join(root, "project"));
		session.messages = [{ role: "user", content: "unanswered" }] as Message[];
		saveSession(session);
		expect(listForkPoints(session.id)).toEqual([{ seq: expect.any(Number), text: "unanswered" }]);
	});
});
