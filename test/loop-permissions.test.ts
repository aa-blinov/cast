/**
 * Permission rules from settings, enforced by the agent loop on real tool
 * calls. Only the LLM call is stubbed; HOME and the session DB are throwaway.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import { getPendingApproval } from "../src/core/pending-approval.ts";
import { createSession, saveSession } from "../src/core/session.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return { ...actual, createClient: () => ({}), streamAndCollect: vi.fn() };
});

const { runAgentLoop } = await import("../src/core/loop.ts");
const { streamAndCollect } = await import("../src/core/llm.ts");

const testConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 120_000,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
};

let dir: string;
let realHome: string | undefined;
let realDb: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-loop-perm-"));
	realHome = process.env.HOME;
	realDb = process.env.CAST_SESSIONS_DB;
	process.env.HOME = join(dir, "home");
	process.env.CAST_SESSIONS_DB = join(dir, "sessions.db");
	resetDbConnectionForTests();
	mkdirSync(join(dir, "home", ".cast"), { recursive: true });
	mkdirSync(join(dir, "proj"));
});
afterEach(() => {
	process.env.HOME = realHome;
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(dir, { recursive: true, force: true });
	vi.mocked(streamAndCollect).mockReset();
});

function rules(permissions: object) {
	writeFileSync(join(dir, "home", ".cast", "settings.json"), JSON.stringify({ permissions }));
}

function oneCall(name: string, args: object) {
	vi.mocked(streamAndCollect)
		.mockImplementationOnce(async () => ({
			content: "",
			thinking: "",
			finishReason: "stop",
			toolCalls: [{ id: "t1", name, arguments: JSON.stringify(args) }],
		}))
		.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));
}

async function run(
	confirmBash?: (command: string, reason: string, rule?: string) => Promise<boolean>,
	extra: { sessionId?: string; preApproved?: string } = {},
) {
	const messages: Message[] = await runAgentLoop([{ role: "user", content: "go" }], {
		config: testConfig,
		model: "test-model",
		cwd: join(dir, "proj"),
		systemPrompt: "test",
		confirmBash,
		onEvent: () => {},
		...extra,
	});
	const tool = messages.find((m) => m.role === "tool") as { content: string } | undefined;
	return tool?.content ?? "";
}

describe("the scratchpad in the system prompt", () => {
	const systemPromptSent = (): string => {
		const messages = vi.mocked(streamAndCollect).mock.calls[0]?.[2] as Array<{ role: string; content: unknown }>;
		return String(messages.find((m) => m.role === "system")?.content ?? "");
	};
	const talk = async (cwd: string, sessionId?: string) => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "ok",
			thinking: "",
			finishReason: "stop",
		}));
		await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd,
			systemPrompt: "BASE PROMPT",
			onEvent: () => {},
			...(sessionId ? { sessionId } : {}),
		});
	};

	it("tells a session in a project where its scratchpad is, and makes the folder", async () => {
		await talk(join(dir, "proj"), "sess1");
		const prompt = systemPromptSent();
		const path = join(dir, "home", ".cast", "scratch", "sess1");
		expect(prompt).toContain("BASE PROMPT");
		expect(prompt).toContain(`Your scratchpad for this session is ${path}`);
		expect(existsSync(path)).toBe(true);
	});

	it("does not tell a run that cannot write to put files there: a read-only subagent, plan mode", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "ok",
			thinking: "",
			finishReason: "stop",
		}));
		await runAgentLoop([{ role: "user", content: "look" }], {
			config: testConfig,
			model: "test-model",
			cwd: join(dir, "proj"),
			systemPrompt: "BASE PROMPT",
			onEvent: () => {},
			sessionId: "sess5",
			readOnlyBash: true,
			allowedTools: ["read", "glob", "grep", "bash"],
			disabledTools: new Set(["write", "edit"]),
		});
		expect(systemPromptSent()).not.toContain("Your scratchpad");
	});

	it("does not name a scratchpad it could not make", async () => {
		// A file where the scratch root should be: the folder cannot be created under it.
		writeFileSync(join(dir, "home", ".cast", "scratch"), "in the way");
		await talk(join(dir, "proj"), "sess3");
		expect(systemPromptSent()).not.toContain("Your scratchpad");
	});

	it("is off when the settings say so: no block, no folder", async () => {
		rules({});
		writeFileSync(join(dir, "home", ".cast", "settings.json"), JSON.stringify({ scratchpad: false }));
		await talk(join(dir, "proj"), "sess4");
		expect(systemPromptSent()).not.toContain("Your scratchpad");
		expect(existsSync(join(dir, "home", ".cast", "scratch", "sess4"))).toBe(false);
	});

	it("says nothing, and makes nothing, for a run that is not a session (no id)", async () => {
		await talk(join(dir, "proj"));
		expect(systemPromptSent()).not.toContain("scratchpad");
		expect(existsSync(join(dir, "home", ".cast", "scratch"))).toBe(false);
	});

	it("gives a sandbox session no second folder: its working folder is the scratch space", async () => {
		const sandbox = join(dir, "home", ".cast", "sandbox", "cast-sess2");
		mkdirSync(sandbox, { recursive: true });
		await talk(sandbox, "sess2");
		expect(systemPromptSent()).not.toContain("Your scratchpad");
		expect(existsSync(join(dir, "home", ".cast", "scratch", "sess2"))).toBe(false);
	});
});

describe("permission rules in the loop", () => {
	it("deny stops the call before it runs, even in bypass mode", async () => {
		rules({ deny: ["write(secrets/**)"] });
		oneCall("write", { path: "secrets/key.txt", content: "x" });
		expect(await run()).toContain('Denied by the permission rule "write(secrets/**)"');
		expect(() => readFileSync(join(dir, "proj", "secrets", "key.txt"))).toThrow();
	});

	it("ask goes through the confirm prompt with the exact rule to save; declining blocks", async () => {
		rules({ ask: ["write(*.md)"] });
		oneCall("write", { path: "notes.md", content: "x" });
		const confirm = vi.fn(async () => false);
		expect(await run(confirm)).toContain("the user declined write");
		expect(confirm).toHaveBeenCalledWith(
			"write notes.md",
			"permission rule write(*.md)",
			"write(notes.md)",
			undefined,
		);
		expect(() => readFileSync(join(dir, "proj", "notes.md"))).toThrow();
	});

	it("an approved ask on a dangerous command is not asked about twice", async () => {
		rules({ ask: ["bash(rm -rf *)"] });
		oneCall("bash", { command: "rm -rf gone-dir" });
		const confirm = vi.fn(async () => true);
		expect(await run(confirm)).not.toContain("Blocked");
		expect(confirm).toHaveBeenCalledTimes(1);
	});

	it("allow answers the dangerous-command prompt for good", async () => {
		rules({ allow: ["bash(rm -rf gone-dir)"] });
		oneCall("bash", { command: "rm -rf gone-dir" });
		const confirm = vi.fn(async () => false);
		expect(await run(confirm)).not.toContain("Blocked");
		expect(confirm).not.toHaveBeenCalled();
	});

	it("keeps the request in the session while it waits, so another process can answer it", async () => {
		const session = createSession("test-model", join(dir, "proj"));
		saveSession(session);
		rules({ ask: ["write(*.md)"] });
		oneCall("write", { path: "notes.md", content: "x" });
		let seen: unknown;
		await run(
			async () => {
				seen = getPendingApproval(session.id);
				return false;
			},
			{ sessionId: session.id },
		);
		expect(seen).toMatchObject({ command: "write notes.md", rule: "write(notes.md)" });
		expect(getPendingApproval(session.id)).toBeUndefined();
	});

	it("lets the one call an earlier approval names through, once", async () => {
		rules({ ask: ["write(*.md)"] });
		oneCall("write", { path: "notes.md", content: "x" });
		const confirm = vi.fn(async () => false);
		expect(await run(confirm, { preApproved: "write notes.md" })).not.toContain("declined");
		expect(confirm).not.toHaveBeenCalled();
		expect(readFileSync(join(dir, "proj", "notes.md"), "utf-8")).toBe("x");
	});

	it("an edit sent with write's `path` still edits, and the guard sees that path", async () => {
		writeFileSync(join(dir, "proj", "a.txt"), "old");
		oneCall("edit", { path: "a.txt", oldString: "old", newString: "new" });
		await run(vi.fn(async () => true));
		expect(readFileSync(join(dir, "proj", "a.txt"), "utf-8")).toBe("new");

		writeFileSync(join(dir, "out.txt"), "old");
		oneCall("edit", { path: join(dir, "out.txt"), oldString: "old", newString: "new" });
		const confirm = vi.fn(async () => false);
		await run(confirm);
		expect(confirm).toHaveBeenCalled();
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("old");
	});

	describe("outside the project", () => {
		it("asks before a file tool reaches outside, with the directory as the rule to save", async () => {
			writeFileSync(join(dir, "secret.txt"), "top secret");
			oneCall("read", { path: join(dir, "secret.txt") });
			const confirm = vi.fn(async () => false);
			const content = await run(confirm);
			expect(confirm).toHaveBeenCalledWith(
				`read ${join(dir, "secret.txt")}`,
				"outside the project",
				`external_directory(${dir}/**)`,
				undefined,
			);
			expect(content).toContain("outside the project");
			expect(content).not.toContain("top secret");
		});

		it("runs it once approved, and an always-allow answer stops the asking", async () => {
			writeFileSync(join(dir, "notes.txt"), "shared notes");
			oneCall("read", { path: join(dir, "notes.txt") });
			expect(await run(vi.fn(async () => true))).toContain("shared notes");

			rules({ approved: [`external_directory(${dir}/**)`] });
			oneCall("read", { path: join(dir, "notes.txt") });
			const confirm = vi.fn(async () => false);
			expect(await run(confirm)).toContain("shared notes");
			expect(confirm).not.toHaveBeenCalled();
		});

		it("a deny rule blocks, and a tool's own allow rule counts as the answer", async () => {
			rules({ deny: [`external_directory(${dir}/**)`] });
			oneCall("write", { path: join(dir, "x.txt"), content: "x" });
			expect(await run(vi.fn(async () => true))).toContain("blocks it");
			expect(() => readFileSync(join(dir, "x.txt"))).toThrow();

			rules({ allow: [`write(${dir}/**)`] });
			oneCall("write", { path: join(dir, "x.txt"), content: "x" });
			const confirm = vi.fn(async () => false);
			await run(confirm);
			expect(confirm).not.toHaveBeenCalled();
			expect(readFileSync(join(dir, "x.txt"), "utf-8")).toBe("x");
		});

		it("never asks about cast's own memory files, which the agent is told to read and update", async () => {
			const realMem = process.env.CAST_MEMORY_DIR;
			process.env.CAST_MEMORY_DIR = join(dir, "memory");
			try {
				oneCall("write", { path: join(dir, "memory", "sessions", "s1", "notes.md"), content: "note" });
				const confirm = vi.fn(async () => false);
				await run(confirm);
				expect(confirm).not.toHaveBeenCalled();
				expect(readFileSync(join(dir, "memory", "sessions", "s1", "notes.md"), "utf-8")).toBe("note");
			} finally {
				if (realMem === undefined) delete process.env.CAST_MEMORY_DIR;
				else process.env.CAST_MEMORY_DIR = realMem;
			}
		});

		it("never asks about the session's scratchpad, but still asks about another session's", async () => {
			const home = join(dir, "home");
			// The paths are the ones the loop derives from HOME and the session id.
			mkdirSync(join(home, ".cast", "scratch", "mine"), { recursive: true });
			mkdirSync(join(home, ".cast", "scratch", "other"), { recursive: true });
			writeFileSync(join(home, ".cast", "scratch", "other", "theirs.txt"), "their notes");

			oneCall("write", { path: join(home, ".cast", "scratch", "mine", "tmp.txt"), content: "mine" });
			const confirm = vi.fn(async () => false);
			await run(confirm, { sessionId: "mine" });
			expect(confirm).not.toHaveBeenCalled();
			expect(readFileSync(join(home, ".cast", "scratch", "mine", "tmp.txt"), "utf-8")).toBe("mine");

			oneCall("read", { path: join(home, ".cast", "scratch", "mine", "tmp.txt") });
			expect(await run(confirm, { sessionId: "mine" })).toContain("mine");
			expect(confirm).not.toHaveBeenCalled();

			oneCall("read", { path: join(home, ".cast", "scratch", "other", "theirs.txt") });
			expect(await run(confirm, { sessionId: "mine" })).toContain("outside the project");
			expect(confirm).toHaveBeenCalledTimes(1);
		});

		it("a refused write to /tmp says where a temporary file may go", async () => {
			oneCall("write", { path: "/tmp/cast-test-never-written.txt", content: "x" });
			const content = await run(
				vi.fn(async () => false),
				{ sessionId: "mine" },
			);
			expect(content).toContain("declined");
			expect(content).toContain(join(dir, "home", ".cast", "scratch", "mine"));
			expect(existsSync("/tmp/cast-test-never-written.txt")).toBe(false);
		});

		it("with nobody to ask (bypass) it runs; inside the project it never asks", async () => {
			writeFileSync(join(dir, "free.txt"), "free");
			oneCall("read", { path: join(dir, "free.txt") });
			expect(await run(undefined)).toContain("free");

			writeFileSync(join(dir, "proj", "local.txt"), "local");
			oneCall("read", { path: "local.txt" });
			const confirm = vi.fn(async () => false);
			expect(await run(confirm)).toContain("local");
			expect(confirm).not.toHaveBeenCalled();
		});
	});
});
