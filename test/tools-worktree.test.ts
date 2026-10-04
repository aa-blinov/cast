import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { gateWorktreeCreate } from "../src/core/loop.ts";
import { execWorktree } from "../src/core/tools/worktree.ts";
import { createToolExecutor, getToolDefinitions } from "../src/core/tools.ts";

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 10_000,
};

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };
const git = (cwd: string, args: string[]) =>
	execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("worktree tool", () => {
	let repo: string;

	beforeEach(() => {
		repo = realpathSync(mkdtempSync(join(tmpdir(), "cast-worktree-tool-")));
		git(repo, ["init", "-q"]);
		git(repo, ["config", "user.email", "t@t"]);
		git(repo, ["config", "user.name", "t"]);
		writeFileSync(join(repo, "a.txt"), "main\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "init"]);
	});
	afterEach(() => rmSync(repo, { recursive: true, force: true }));

	const deps = (over: Record<string, unknown> = {}) => {
		let cwd = repo;
		const switchTo = vi.fn((path: string) => {
			cwd = path;
		});
		return { deps: { cwd: () => cwd, projectTrusted: false, switchTo, ...over }, switchTo, where: () => cwd };
	};

	it("moves into a new worktree on its own branch and tells where", async () => {
		const { deps: d, switchTo, where } = deps();
		const res = await execWorktree({ action: "enter", name: "feature-x" }, d);
		expect(res.isError).toBeFalsy();
		expect(where()).toBe(join(repo, ".cast", "worktrees", "feature-x"));
		expect(switchTo).toHaveBeenCalledWith(where(), repo);
		expect(existsSync(join(where(), "a.txt"))).toBe(true);
		expect(git(where(), ["branch", "--show-current"])).toBe("cast-feature-x");
		expect(res.content).toContain("cast-feature-x");
		expect(git(repo, ["status", "--short"])).toBe("");
		expect(git(repo, ["branch", "--show-current"])).not.toBe("cast-feature-x");
	});

	it("says so when it is already in that worktree, and does not move again", async () => {
		const { deps: d, switchTo } = deps();
		await execWorktree({ action: "enter", name: "same" }, d);
		switchTo.mockClear();
		const res = await execWorktree({ action: "enter", name: "same" }, d);
		expect(res.content).toContain("Already in the worktree");
		expect(switchTo).not.toHaveBeenCalled();
	});

	it("lists the worktrees and marks the one it is in", async () => {
		const { deps: d } = deps();
		expect((await execWorktree({ action: "list" }, d)).content).toContain("No worktrees yet");
		await execWorktree({ action: "enter", name: "one" }, d);
		const listed = (await execWorktree({ action: "list" }, d)).content;
		expect(listed).toMatch(/\* one {2}\(cast-one\)/);
		expect(listed).toContain(`Main checkout: ${repo}`);
	});

	it("goes back to the main checkout and keeps the worktree", async () => {
		const { deps: d, where } = deps();
		await execWorktree({ action: "enter", name: "keep" }, d);
		const wt = where();
		const res = await execWorktree({ action: "exit" }, d);
		expect(res.isError).toBeFalsy();
		expect(where()).toBe(repo);
		expect(existsSync(wt)).toBe(true);
		const again = await execWorktree({ action: "exit" }, d);
		expect(again.isError).toBe(true);
		expect(again.content).toContain("not in a worktree");
	});

	it("refuses a bad name and an unknown action, and outside a repository", async () => {
		const { deps: d } = deps();
		expect((await execWorktree({ action: "enter" }, d)).isError).toBe(true);
		const bad = await execWorktree({ action: "enter", name: "../escape" }, d);
		expect(bad.isError).toBe(true);
		expect((await execWorktree({ action: "remove", name: "x" }, d)).content).toContain("enter, exit or list");
		const outside = mkdtempSync(join(tmpdir(), "cast-not-git-"));
		try {
			const res = await execWorktree({ action: "list" }, { ...d, cwd: () => outside });
			expect(res.isError).toBe(true);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("moves the executor's own directory: the next bash runs in the worktree", async () => {
		let moved = "";
		const executor = createToolExecutor(
			repo,
			mockConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"s1",
			{
				projectTrusted: false,
				switchTo: (path) => {
					moved = path;
				},
			},
		);
		const before = await executor("bash", { command: "pwd" });
		expect(before.content.trim()).toBe(repo);
		await executor("worktree", { action: "enter", name: "ex" });
		expect(moved).toBe(join(repo, ".cast", "worktrees", "ex"));
		const after = await executor("bash", { command: "pwd" });
		expect(after.content.trim()).toBe(moved);
		const written = await executor("write", { path: "in-worktree.txt", content: "hi\n" });
		expect(written.isError).toBeFalsy();
		expect(existsSync(join(moved, "in-worktree.txt"))).toBe(true);
		expect(existsSync(join(repo, "in-worktree.txt"))).toBe(false);
	});

	it("keeps its copies out of the main checkout's searches", async () => {
		writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-qm", "calc"]);
		const { deps: d } = deps();
		await execWorktree({ action: "enter", name: "copy" }, d);
		const executor = createToolExecutor(repo, mockConfig);
		const files = await executor("glob", { pattern: "**/calc.py" });
		expect(files.content).toContain("calc.py");
		expect(files.content).not.toContain(".cast/worktrees");
		const found = await executor("grep", { pattern: "def add" });
		expect(found.content).not.toContain(".cast/worktrees");
	});

	it("is not available to an executor that was given no host", async () => {
		const executor = createToolExecutor(repo, mockConfig);
		const res = await executor("worktree", { action: "list" });
		expect(res.isError).toBe(true);
	});

	it("is advertised only when asked for", () => {
		const names = (include: boolean) =>
			getToolDefinitions(
				undefined,
				undefined,
				undefined,
				undefined,
				false,
				false,
				true,
				true,
				false,
				false,
				false,
				false,
				include,
			).map((t) => t.function.name);
		expect(names(false)).not.toContain("worktree");
		expect(names(true)).toContain("worktree");
	});
});

describe("gateWorktreeCreate", () => {
	it("asks only before creating, and only where a write asks", async () => {
		const ask = vi.fn(async () => false);
		expect((await gateWorktreeCreate("worktree", { action: "enter", name: "x" }, ask))?.isError).toBe(true);
		expect(ask).toHaveBeenCalledWith(
			"worktree",
			join(".cast", "worktrees", "x"),
			expect.stringContaining("create a git worktree"),
		);
		ask.mockClear();
		expect(await gateWorktreeCreate("worktree", { action: "list" }, ask)).toBeUndefined();
		expect(await gateWorktreeCreate("worktree", { action: "exit" }, ask)).toBeUndefined();
		expect(await gateWorktreeCreate("bash", { action: "enter" }, ask)).toBeUndefined();
		expect(ask).not.toHaveBeenCalled();
		expect(await gateWorktreeCreate("worktree", { action: "enter", name: "x" }, undefined)).toBeUndefined();
		expect(await gateWorktreeCreate("worktree", { action: "enter", name: "x" }, async () => true)).toBeUndefined();
	});
});
