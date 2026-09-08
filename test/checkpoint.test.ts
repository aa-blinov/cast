import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backupFileForCheckpoint,
	createCheckpoint,
	filesLostByRestore,
	restoreCheckpoint,
} from "../src/core/checkpoint.ts";
import type { AppConfig } from "../src/core/config.ts";
import { createToolExecutor } from "../src/core/tools.ts";

const TEST_DIR = join(process.cwd(), "test", "__test_tmp__", "checkpoint-test");

describe("checkpoint module", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("creates shadow backups and restores non-git workspace", async () => {
		const targetFile = join(TEST_DIR, "original.txt");
		writeFileSync(targetFile, "initial content", "utf8");

		const chk = createCheckpoint(TEST_DIR, true);
		expect(chk.gitCommitSha).toBeUndefined();

		const execute = createToolExecutor(
			TEST_DIR,
			{} as AppConfig,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(path) => backupFileForCheckpoint(chk, path),
		);

		// Mutate existing file and add new file through the executor that backs
		// the agent's write/edit tools.
		await execute("write", { path: "original.txt", content: "mutated content" });
		const createdFile = join(TEST_DIR, "created.txt");
		await execute("write", { path: "created.txt", content: "brand new" });

		expect(readFileSync(targetFile, "utf8")).toBe("mutated content");
		expect(existsSync(createdFile)).toBe(true);

		const res = restoreCheckpoint(chk);
		expect(res.ok).toBe(true);
		expect(readFileSync(targetFile, "utf8")).toBe("initial content");
		expect(existsSync(createdFile)).toBe(false);
	});

	it("creates git plumbing commit and restores git workspace", () => {
		// Initialize temporary git repo
		execFileSync("git", ["init"], { cwd: TEST_DIR, stdio: "ignore" });
		execFileSync("git", ["config", "user.name", "Test"], { cwd: TEST_DIR, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: TEST_DIR, stdio: "ignore" });

		const initialFile = join(TEST_DIR, "code.ts");
		writeFileSync(initialFile, "console.log('v1');", "utf8");
		execFileSync("git", ["add", "-A"], { cwd: TEST_DIR, stdio: "ignore" });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: TEST_DIR, stdio: "ignore" });
		const stagedFile = join(TEST_DIR, "staged.ts");
		writeFileSync(stagedFile, "export const staged = true;", "utf8");
		execFileSync("git", ["add", "staged.ts"], { cwd: TEST_DIR, stdio: "ignore" });
		const preexistingUntracked = join(TEST_DIR, "keep.txt");
		writeFileSync(preexistingUntracked, "keep me", "utf8");
		const indexBefore = execFileSync("git", ["diff", "--cached", "--name-only"], {
			cwd: TEST_DIR,
			encoding: "utf8",
		});

		const chk = createCheckpoint(TEST_DIR);
		expect(chk.gitCommitSha).toBeDefined();
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: TEST_DIR, encoding: "utf8" })).toBe(
			indexBefore,
		);

		// Agent edits file and creates a new one
		writeFileSync(initialFile, "console.log('v2 broken');", "utf8");
		const newFile = join(TEST_DIR, "temp.txt");
		writeFileSync(newFile, "garbage", "utf8");

		expect(readFileSync(initialFile, "utf8")).toBe("console.log('v2 broken');");
		expect(existsSync(newFile)).toBe(true);

		const res = restoreCheckpoint(chk);
		expect(res.ok).toBe(true);
		expect(readFileSync(initialFile, "utf8")).toBe("console.log('v1');");
		expect(existsSync(newFile)).toBe(false);
		expect(readFileSync(preexistingUntracked, "utf8")).toBe("keep me");
		expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: TEST_DIR, encoding: "utf8" })).toBe(
			indexBefore,
		);
	});
	it("restores a file whose bytes are not valid UTF-8", () => {
		// The shadow path read and wrote "utf8", so every byte outside UTF-8
		// came back as U+FFFD: /undo "restored" a PNG as replacement characters
		// and reported success.
		const file = join(TEST_DIR, "logo.png");
		const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x80, 0x81]);
		writeFileSync(file, original);

		const chk = createCheckpoint(TEST_DIR, true);
		backupFileForCheckpoint(chk, file);
		writeFileSync(file, "the agent overwrote it", "utf8");
		const res = restoreCheckpoint(chk);

		expect(res.ok).toBe(true);
		expect(readFileSync(file).equals(original)).toBe(true);
	});

	describe("filesLostByRestore", () => {
		// Restoring runs `git clean -fd`, so untracked files created after the
		// checkpoint are deleted and cannot be recovered — that includes anything
		// the user wrote themselves while the agent worked. Files untracked *at*
		// checkpoint time are in its tree and come back, so they are not losses.
		it("names only the untracked files the restore cannot bring back", () => {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "t"], { cwd: TEST_DIR, stdio: "ignore" });
			writeFileSync(join(TEST_DIR, "tracked.ts"), "v1", "utf8");
			execFileSync("git", ["add", "-A"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "init"], { cwd: TEST_DIR, stdio: "ignore" });
			writeFileSync(join(TEST_DIR, "untracked-before.txt"), "written before the checkpoint", "utf8");

			const chk = createCheckpoint(TEST_DIR);
			expect(chk.gitCommitSha).toBeDefined();

			writeFileSync(join(TEST_DIR, "tracked.ts"), "v2", "utf8");
			writeFileSync(join(TEST_DIR, "written-during-the-turn.txt"), "the user's own note", "utf8");

			expect(filesLostByRestore(chk)).toEqual(["written-during-the-turn.txt"]);

			// And the claim holds: restoring keeps the first, loses the second.
			restoreCheckpoint(chk);
			expect(existsSync(join(TEST_DIR, "untracked-before.txt"))).toBe(true);
			expect(existsSync(join(TEST_DIR, "written-during-the-turn.txt"))).toBe(false);
		});

		it("names the same files when the session runs from a subdirectory", () => {
			// `git clean -nd` prints cwd-relative paths (prefixed with `./`) and
			// notices like "Would refuse to remove current working directory",
			// while ls-tree was listing cwd-scoped paths — so from a subdirectory
			// the confirmation named a git notice as a file and claimed it would
			// delete files its own restore puts straight back.
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["config", "user.name", "t"], { cwd: TEST_DIR, stdio: "ignore" });
			writeFileSync(join(TEST_DIR, "tracked.ts"), "v1", "utf8");
			execFileSync("git", ["add", "-A"], { cwd: TEST_DIR, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "init"], { cwd: TEST_DIR, stdio: "ignore" });
			const sub = join(TEST_DIR, "apps", "web");
			mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, "untracked-before.txt"), "written before the checkpoint", "utf8");

			const chk = createCheckpoint(sub);
			expect(chk.gitCommitSha).toBeDefined();
			writeFileSync(join(sub, "written-during-the-turn.txt"), "the user's own note", "utf8");

			expect(filesLostByRestore(chk)).toEqual(["written-during-the-turn.txt"]);

			restoreCheckpoint(chk);
			expect(existsSync(join(sub, "untracked-before.txt"))).toBe(true);
			expect(existsSync(join(sub, "written-during-the-turn.txt"))).toBe(false);
		});

		it("reports nothing for a shadow checkpoint, which never cleans", () => {
			const chk = createCheckpoint(TEST_DIR, true);
			expect(filesLostByRestore(chk)).toEqual([]);
		});
	});
});
