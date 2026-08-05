import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupFileForCheckpoint, createCheckpoint, restoreCheckpoint } from "../src/core/checkpoint.ts";

const TEST_DIR = join(process.cwd(), "test", "__test_tmp__", "checkpoint-test");

describe("checkpoint module", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	it("creates shadow backups and restores non-git workspace", () => {
		const targetFile = join(TEST_DIR, "original.txt");
		writeFileSync(targetFile, "initial content", "utf8");

		const chk = createCheckpoint(TEST_DIR, true);
		expect(chk.gitCommitSha).toBeUndefined();

		backupFileForCheckpoint(chk, targetFile);

		// Mutate existing file and add new file
		writeFileSync(targetFile, "mutated content", "utf8");
		const createdFile = join(TEST_DIR, "created.txt");
		backupFileForCheckpoint(chk, createdFile);
		writeFileSync(createdFile, "brand new", "utf8");

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

		const chk = createCheckpoint(TEST_DIR);
		expect(chk.gitCommitSha).toBeDefined();

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
	});
});
