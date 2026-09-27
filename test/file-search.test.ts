import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectFiles, searchProjectFiles } from "../src/core/file-search.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "file-search");

function touch(path: string) {
	mkdirSync(join(TEST_DIR, path, ".."), { recursive: true });
	writeFileSync(join(TEST_DIR, path), "");
}

describe("project file search", () => {
	beforeEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
		for (const p of ["src/ui/Composer.tsx", "src/core/loop.ts", "docs/composer-guide.md", "node_modules/x/index.js"])
			touch(p);
	});
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	it("honours .gitignore in a repository and still lists untracked files", () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules/\n");
		touch("new file.ts");
		const files = listProjectFiles(TEST_DIR);
		expect(files).toContain("src/ui/Composer.tsx");
		expect(files).toContain("new file.ts");
		expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
	});

	it("ranks a file-name hit above a directory hit, and fuzzy-matches", () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		expect(searchProjectFiles(TEST_DIR, "composer").slice(0, 2).sort()).toEqual([
			"docs/composer-guide.md",
			"src/ui/Composer.tsx",
		]);
		expect(searchProjectFiles(TEST_DIR, "lop")).toEqual(["src/core/loop.ts"]);
		expect(searchProjectFiles(TEST_DIR, "zzz")).toEqual([]);
	});
});
