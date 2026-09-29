import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckpoint } from "../src/core/checkpoint.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import { listRewindPoints, previewRewind, rewindSession } from "../src/core/rewind.ts";
import {
	appendCheckpoint,
	createSession,
	loadCheckpoints,
	loadSession,
	saveSession,
	seqOfMessage,
} from "../src/core/session.ts";

let root = "";
let home = "";
let previousHome: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const refs = (cwd: string) => git(cwd, "for-each-ref", "refs/cast/checkpoints/").split("\n").filter(Boolean);

beforeEach(() => {
	previousHome = process.env.HOME;
	root = realpathSync(mkdtempSync(join(tmpdir(), "cast-rewind-")));
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
	resetDbConnectionForTests();
});

afterEach(() => {
	resetDbConnectionForTests();
	delete process.env.CAST_SESSIONS_DB;
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	rmSync(root, { recursive: true, force: true });
});

/**
 * Three turns in `dir`. The file reads v0 when turn 1 starts, v1 when turn 2
 * starts, v2 when turn 3 starts, and v3 at the end: each turn's checkpoint is
 * taken at its start and the "agent" then edits the file.
 */
async function threeTurns(dir: string) {
	const session = createSession("test-model", dir);
	const messages: Message[] = [{ role: "system", content: "system prompt" } as Message];
	const file = join(dir, "a.txt");
	writeFileSync(file, "v0\n");
	saveSession(session);
	const seqs: number[] = [];
	for (let turn = 1; turn <= 3; turn++) {
		const user = { role: "user", content: `ask ${turn}` } as Message;
		messages.push(user);
		session.messages = [...messages];
		saveSession(session);
		const checkpoint = await createCheckpoint(dir);
		checkpoint.userSeq = seqOfMessage(session.id, user);
		seqs.push(checkpoint.userSeq as number);
		session.checkpoints = [...(session.checkpoints ?? []), checkpoint];
		appendCheckpoint(session.id, checkpoint);
		writeFileSync(file, `v${turn}\n`);
		messages.push({ role: "assistant", content: `answer ${turn}` } as Message);
		session.messages = [...messages];
		saveSession(session);
	}
	return { session, seqs, file };
}

function repo(): string {
	const dir = join(root, "repo");
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@example.com");
	git(dir, "config", "user.name", "T");
	writeFileSync(join(dir, "README.md"), "hi\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-qm", "init");
	return dir;
}

const texts = (messages: Message[]) => messages.map((m) => (typeof m.content === "string" ? m.content : ""));

describe("rewind in a git repository", () => {
	it("files and conversation: goes back to before the message, and drops the turns after it for good", async () => {
		const dir = repo();
		const { session, seqs, file } = await threeTurns(dir);
		expect(refs(dir)).toHaveLength(3);

		const result = await rewindSession(session, seqs[1] as number, "both", { force: true });
		expect(result.ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v1\n");
		expect(texts(session.messages)).toEqual(["system prompt", "ask 1", "answer 1"]);
		expect(session.checkpoints).toHaveLength(1);
		// Stored too, not only in memory.
		expect(texts(loadSession(session.id)?.messages ?? [])).toEqual(["system prompt", "ask 1", "answer 1"]);
		expect(loadCheckpoints(session.id)).toHaveLength(1);
		// Only the first turn's snapshot is still pinned.
		expect(refs(dir)).toHaveLength(1);
	});

	it("conversation only: the files stay, the turns and their snapshots go", async () => {
		const dir = repo();
		const { session, seqs, file } = await threeTurns(dir);
		const result = await rewindSession(session, seqs[1] as number, "conversation", { force: false });
		expect(result.ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v3\n");
		expect(texts(session.messages)).toEqual(["system prompt", "ask 1", "answer 1"]);
		expect(session.checkpoints).toHaveLength(1);
		expect(refs(dir)).toHaveLength(1);
	});

	it("files only: the conversation and every snapshot stay, so the files can go forward again", async () => {
		const dir = repo();
		const { session, seqs, file } = await threeTurns(dir);
		const back = await rewindSession(session, seqs[0] as number, "code", { force: true });
		expect(back.ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v0\n");
		expect(session.messages).toHaveLength(7);
		expect(session.checkpoints).toHaveLength(3);
		expect(refs(dir)).toHaveLength(3);
		expect(loadCheckpoints(session.id)).toHaveLength(3);

		const forward = await rewindSession(session, seqs[2] as number, "code", { force: true });
		expect(forward.ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v2\n");
	});

	it("refuses to delete files created since unless forced", async () => {
		const dir = repo();
		const { session, seqs, file } = await threeTurns(dir);
		writeFileSync(join(dir, "made.txt"), "by hand\n");

		const refused = await rewindSession(session, seqs[1] as number, "both", { force: false });
		expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("made.txt") });
		expect(readFileSync(file, "utf8")).toBe("v3\n");
		expect(session.messages).toHaveLength(7);
		expect(existsSync(join(dir, "made.txt"))).toBe(true);

		expect((await rewindSession(session, seqs[1] as number, "both", { force: true })).ok).toBe(true);
		expect(existsSync(join(dir, "made.txt"))).toBe(false);
	});

	it("does not ask about files when only the conversation goes", async () => {
		const dir = repo();
		const { session, seqs } = await threeTurns(dir);
		writeFileSync(join(dir, "made.txt"), "by hand\n");
		expect((await rewindSession(session, seqs[1] as number, "conversation", { force: false })).ok).toBe(true);
		expect(existsSync(join(dir, "made.txt"))).toBe(true);
	});
});

describe("rewind outside git", () => {
	it("undoes what shell commands did, several turns back", async () => {
		const dir = join(root, "notes");
		mkdirSync(dir);
		const { session, seqs, file } = await threeTurns(dir);
		writeFileSync(join(dir, "shell-made.txt"), "x\n");
		const result = await rewindSession(session, seqs[0] as number, "both", { force: true });
		expect(result.ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v0\n");
		expect(existsSync(join(dir, "shell-made.txt"))).toBe(false);
		expect(session.messages).toHaveLength(1);
		expect(session.checkpoints).toHaveLength(0);
	});
});

describe("rewind limits and previews", () => {
	it("says there is no snapshot for a message that has none", async () => {
		const dir = repo();
		const { session } = await threeTurns(dir);
		expect(await rewindSession(session, 999, "both", { force: true })).toMatchObject({ ok: false });
		expect(await previewRewind(session, 999)).toMatchObject({ available: false });
	});

	it("keeps a message that compaction took out of the conversation reachable for files only", async () => {
		const dir = repo();
		const { session, seqs, file } = await threeTurns(dir);
		session.messages = session.messages.filter((m) => m.content !== "ask 2" && m.content !== "answer 2");
		const preview = await previewRewind(session, seqs[1] as number);
		expect(preview).toMatchObject({ available: true, conversationAvailable: false });
		expect((await rewindSession(session, seqs[1] as number, "both", { force: true })).ok).toBe(false);
		expect((await rewindSession(session, seqs[1] as number, "conversation", { force: true })).ok).toBe(false);
		expect((await rewindSession(session, seqs[1] as number, "code", { force: true })).ok).toBe(true);
		expect(readFileSync(file, "utf8")).toBe("v1\n");
	});

	it("previews the message, the turns it removes, and the files it would delete", async () => {
		const dir = repo();
		const { session, seqs } = await threeTurns(dir);
		writeFileSync(join(dir, "made.txt"), "x\n");
		expect(await previewRewind(session, seqs[1] as number)).toMatchObject({
			available: true,
			kind: "git",
			shellChangesCovered: true,
			message: "ask 2",
			turns: 2,
			conversationAvailable: true,
			lost: ["made.txt"],
			lostTotal: 1,
		});
	});

	it("lists the turns that can be rewound to, oldest first", async () => {
		const dir = repo();
		const { session, seqs } = await threeTurns(dir);
		expect(listRewindPoints(session)).toEqual([
			{ userSeq: seqs[0], text: "ask 1" },
			{ userSeq: seqs[1], text: "ask 2" },
			{ userSeq: seqs[2], text: "ask 3" },
		]);
		expect(listRewindPoints({ ...session, checkpoints: [] })).toEqual([]);
	});
});
