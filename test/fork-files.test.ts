import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkpointAtCut, createCheckpoint } from "../src/core/checkpoint.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { forkSessionWithFiles, previewForkFiles } from "../src/core/fork-files.ts";
import type { Message } from "../src/core/llm.ts";
import { createSession, deleteSession, forkCutAfterReply, saveSession, seqOfMessage } from "../src/core/session.ts";
import type { ServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

let root = "";
let home = "";
let previousHome: string | undefined;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
	previousHome = process.env.HOME;
	root = realpathSync(mkdtempSync(join(tmpdir(), "cast-forkfiles-")));
	home = join(root, "home");
	mkdirSync(home, { recursive: true });
	// Hidden snapshot repositories and sandbox folders go under ~/.cast: keep them in a temp dir.
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

/** Two turns in `dir`, a checkpoint at the start of each, and the folder changed after both. */
async function twoTurns(dir: string) {
	const session = createSession("test-model", dir);
	session.messages = [
		{ role: "system", content: "system prompt" },
		{ role: "user", content: "first" },
		{ role: "assistant", content: "one" },
		{ role: "user", content: "second" },
		{ role: "assistant", content: "two" },
	] as Message[];
	saveSession(session);
	const seq = (i: number) => seqOfMessage(session.id, session.messages[i] as Message) as number;
	const write = (text: string) => writeFileSync(join(dir, "a.txt"), text);

	write("v1\n");
	const first = await createCheckpoint(dir);
	first.userSeq = seq(1);
	write("v2\n");
	const second = await createCheckpoint(dir);
	second.userSeq = seq(3);
	write("v3\n");
	session.checkpoints = [first, second];
	return { session, seqs: { firstUser: seq(1), firstAnswer: seq(2), secondUser: seq(3), secondAnswer: seq(4) } };
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

describe("checkpointAtCut", () => {
	it("is the snapshot of the first turn at or after the cut", () => {
		const cps = [
			{ id: "a", timestamp: "", cwd: "/x", userSeq: 2 },
			{ id: "b", timestamp: "", cwd: "/x", userSeq: 10 },
			{ id: "legacy", timestamp: "", cwd: "/x" },
		];
		expect(checkpointAtCut(cps, 2)?.id).toBe("a");
		expect(checkpointAtCut(cps, 3)?.id).toBe("b");
		expect(checkpointAtCut(cps, 10)?.id).toBe("b");
		expect(checkpointAtCut(cps, 11)).toBeUndefined();
		expect(checkpointAtCut([{ id: "legacy", timestamp: "", cwd: "/x" }], 0)).toBeUndefined();
	});
});

describe("a fork with its own files, in a git repository", () => {
	it("gets a worktree holding the files as they were before the message", async () => {
		const dir = repo();
		const { session, seqs } = await twoTurns(dir);
		const made = await forkSessionWithFiles(session, seqs.secondUser);
		expect(made.error).toBeUndefined();
		const fork = made.session!;
		expect(fork.cwd).not.toBe(dir);
		expect(fork.cwd).toContain(join(".cast", "worktrees", `fork-${fork.id}`));
		expect(readFileSync(join(fork.cwd as string, "a.txt"), "utf8")).toBe("v2\n");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v3\n");
		expect(fork.messages.map((m) => m.content)).toEqual(["system prompt", "first", "one"]);
	});

	it("through an answer is the next turn's snapshot", async () => {
		const dir = repo();
		const { session, seqs } = await twoTurns(dir);
		const cut = forkCutAfterReply(session.id, seqs.firstAnswer);
		if (!cut.ok) throw new Error(cut.error);
		const made = await forkSessionWithFiles(session, cut.beforeSeq);
		expect(readFileSync(join(made.session!.cwd as string, "a.txt"), "utf8")).toBe("v2\n");
	});

	it("before the first message is the first snapshot", async () => {
		const dir = repo();
		const { session, seqs } = await twoTurns(dir);
		const made = await forkSessionWithFiles(session, seqs.firstUser);
		expect(readFileSync(join(made.session!.cwd as string, "a.txt"), "utf8")).toBe("v1\n");
	});

	it("keeps the subfolder a session ran from", async () => {
		const dir = repo();
		mkdirSync(join(dir, "pkg"));
		const session = createSession("test-model", join(dir, "pkg"));
		session.messages = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: "done" },
		] as Message[];
		saveSession(session);
		writeFileSync(join(dir, "pkg", "m.txt"), "m1\n");
		const checkpoint = await createCheckpoint(join(dir, "pkg"));
		checkpoint.userSeq = seqOfMessage(session.id, session.messages[0] as Message);
		session.checkpoints = [checkpoint];
		const made = await forkSessionWithFiles(session, checkpoint.userSeq);
		expect(made.session!.cwd?.endsWith(join(`fork-${made.session!.id}`, "pkg"))).toBe(true);
		expect(readFileSync(join(made.session!.cwd as string, "m.txt"), "utf8")).toBe("m1\n");
	});
});

describe("a fork with its own files, outside git", () => {
	it("gets a sandbox folder with the snapshot, which goes with the session", async () => {
		const dir = join(root, "notes");
		mkdirSync(dir);
		const { session, seqs } = await twoTurns(dir);
		const made = await forkSessionWithFiles(session, seqs.secondUser);
		expect(made.error).toBeUndefined();
		const fork = made.session!;
		expect(fork.cwd).toBe(join(home, ".cast", "sandbox", `cast-${fork.id}`));
		expect(readFileSync(join(fork.cwd as string, "a.txt"), "utf8")).toBe("v2\n");
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("v3\n");
		deleteSession(fork.id, fork.cwd);
		expect(existsSync(fork.cwd as string)).toBe(false);
	});
});

describe("when there are no files to give", () => {
	it("says so for the whole session, an old session and a folder that was not snapshotted", async () => {
		const dir = join(root, "notes");
		mkdirSync(dir);
		const { session, seqs } = await twoTurns(dir);
		expect((await forkSessionWithFiles(session, undefined)).error).toMatch(/whole session/);
		expect(await previewForkFiles(session, undefined)).toMatchObject({ canCopyFiles: false });

		const old = { ...session, checkpoints: session.checkpoints?.map((c) => ({ ...c, userSeq: undefined })) };
		expect((await forkSessionWithFiles(old, seqs.secondUser)).error).toMatch(/no snapshot/i);

		const filesOnly = {
			...session,
			checkpoints: [{ id: "x", timestamp: "", cwd: dir, userSeq: seqs.secondUser, backups: [] }],
		};
		expect((await forkSessionWithFiles(filesOnly, seqs.secondUser)).error).toMatch(/edit and write/);
	});

	it("previews what it can do", async () => {
		const dir = join(root, "notes");
		mkdirSync(dir);
		const { session, seqs } = await twoTurns(dir);
		expect(await previewForkFiles(session, seqs.secondUser)).toEqual({ canCopyFiles: true, kind: "snapshot" });
		const gitDir = repo();
		const inRepo = await twoTurns(gitDir);
		expect(await previewForkFiles(inRepo.session, inRepo.seqs.secondUser)).toEqual({
			canCopyFiles: true,
			kind: "worktree",
		});
	});
});

describe("POST /fork with withFiles and GET /fork-preview", () => {
	let server: ReturnType<typeof startServer>;
	let origin = "";
	let cookie = "";
	let sessionId = "";
	let calls: Array<{ beforeSeq: number | undefined }>;

	beforeEach(async () => {
		calls = [];
		const bridge = {
			getSession: (id: string) => (id === sessionId ? { id, status: "idle", session: { cwd: root } } : undefined),
			forkSessionWithFiles: async (_id: string, beforeSeq: number | undefined) => {
				calls.push({ beforeSeq });
				return beforeSeq === 999
					? { error: "There is no snapshot" }
					: { session: { id: "forked", session: { id: "forked" } } };
			},
			previewForkFiles: async (id: string, beforeSeq: number | undefined) =>
				id === sessionId ? { canCopyFiles: beforeSeq !== undefined } : undefined,
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

	const post = (body: unknown) =>
		fetch(`${origin}/api/sessions/${sessionId}/fork`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const preview = (query: string) =>
		fetch(`${origin}/api/sessions/${sessionId}/fork-preview${query}`, { headers: { Cookie: cookie } });

	it("forks with files at the cut, resolving an answer to the message after it", async () => {
		const dir = join(root, "notes");
		mkdirSync(dir);
		const { session, seqs } = await twoTurns(dir);
		sessionId = session.id;
		expect((await post({ beforeSeq: seqs.secondUser, withFiles: true })).status).toBe(201);
		expect(calls.at(-1)).toEqual({ beforeSeq: seqs.secondUser });
		expect((await post({ afterSeq: seqs.firstAnswer, withFiles: true })).status).toBe(201);
		expect(calls.at(-1)).toEqual({ beforeSeq: seqs.secondUser });
	});

	it("reports why it could not as a conflict, and rejects a malformed flag", async () => {
		mkdirSync(join(root, "n2"));
		const { session } = await twoTurns(join(root, "n2"));
		sessionId = session.id;
		const res = await post({ beforeSeq: 999, withFiles: true });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(/no snapshot/);
		expect((await post({ beforeSeq: 1, withFiles: "yes" })).status).toBe(400);
	});

	it("previews for a before cut, an after cut, no cut, and a bad request", async () => {
		mkdirSync(join(root, "n3"));
		const { session, seqs } = await twoTurns(join(root, "n3"));
		sessionId = session.id;
		expect(await (await preview(`?beforeSeq=${seqs.secondUser}`)).json()).toEqual({ canCopyFiles: true });
		expect(await (await preview(`?afterSeq=${seqs.firstAnswer}`)).json()).toEqual({ canCopyFiles: true });
		expect(await (await preview("")).json()).toEqual({ canCopyFiles: false });
		expect((await preview(`?beforeSeq=1&afterSeq=2`)).status).toBe(400);
		expect((await preview(`?beforeSeq=x`)).status).toBe(400);
		expect((await preview(`?afterSeq=${seqs.firstUser}`)).status).toBe(400);
		const missing = await fetch(`${origin}/api/sessions/nope/fork-preview`, { headers: { Cookie: cookie } });
		expect(missing.status).toBe(404);
	});
});
