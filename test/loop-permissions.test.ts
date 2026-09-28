/**
 * Permission rules from settings, enforced by the agent loop on real tool
 * calls. Only the LLM call is stubbed; HOME and the session DB are throwaway.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
