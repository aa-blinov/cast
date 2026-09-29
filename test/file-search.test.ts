import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	invalidateProjectFiles,
	listProjectFiles,
	searchProjectFiles,
	searchProjectNames,
} from "../src/core/file-search.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp__", "file-search");

function touch(path: string) {
	mkdirSync(join(TEST_DIR, path, ".."), { recursive: true });
	writeFileSync(join(TEST_DIR, path), "");
}

describe("project file search", () => {
	beforeEach(() => {
		invalidateProjectFiles(TEST_DIR);
		rmSync(TEST_DIR, { recursive: true, force: true });
		for (const p of ["src/ui/Composer.tsx", "src/core/loop.ts", "docs/composer-guide.md", "node_modules/x/index.js"])
			touch(p);
	});
	afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }));

	it("honours .gitignore in a repository and still lists untracked files", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules/\n");
		touch("new file.ts");
		const { files } = await listProjectFiles(TEST_DIR);
		expect(files).toContain("src/ui/Composer.tsx");
		expect(files).toContain("new file.ts");
		expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
	});

	it("ranks a file-name hit above a directory hit, and fuzzy-matches", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		expect((await searchProjectFiles(TEST_DIR, "composer")).slice(0, 2).sort()).toEqual([
			"docs/composer-guide.md",
			"src/ui/Composer.tsx",
		]);
		expect(await searchProjectFiles(TEST_DIR, "lop")).toEqual(["src/core/loop.ts"]);
		expect(await searchProjectFiles(TEST_DIR, "zzz")).toEqual([]);
	});

	it("finds files in a repository whose ignored folders are huge (the explorer's search)", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules/\n");
		for (let i = 0; i < 300; i++) touch(`node_modules/pkg-${i}/index.js`);
		touch("src/deep/er/needle-target.ts");
		const found = await searchProjectNames(TEST_DIR, "needle");
		expect(found.results.map((r) => r.path)).toEqual(["src/deep/er/needle-target.ts"]);
		expect(found.truncated).toBe(false);
	});

	it("matches every word, in the path, files and folders alike", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		const found = await searchProjectNames(TEST_DIR, "src ui");
		expect(found.results).toContainEqual({ path: "src/ui/Composer.tsx", type: "file" });
		expect(found.results).toContainEqual({ path: "src/ui", type: "dir" });
		expect((await searchProjectNames(TEST_DIR, "composer tsx")).results.map((r) => r.path)).toEqual([
			"src/ui/Composer.tsx",
		]);
	});

	it("says how many matched, and that it stopped, when there are more than the limit", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		for (let i = 0; i < 12; i++) touch(`many/file-${i}.txt`);
		const found = await searchProjectNames(TEST_DIR, "file-", { limit: 5 });
		expect(found.results).toHaveLength(5);
		expect(found.total).toBe(12);
		expect(found.truncated).toBe(true);
	});

	it("can include ignored files, and forgets a listing when told files changed", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		writeFileSync(join(TEST_DIR, ".gitignore"), "node_modules/\n");
		expect((await searchProjectNames(TEST_DIR, "x/index")).results).toEqual([]);
		expect(
			(await searchProjectNames(TEST_DIR, "x/index", { includeIgnored: true })).results.map((r) => r.path),
		).toContain("node_modules/x/index.js");
		touch("later-file.ts");
		invalidateProjectFiles(TEST_DIR);
		expect((await searchProjectNames(TEST_DIR, "later-file")).results.map((r) => r.path)).toEqual(["later-file.ts"]);
	});

	it("does not block the event loop while a large listing runs", async () => {
		execFileSync("git", ["init", "-q"], { cwd: TEST_DIR });
		for (let i = 0; i < 4000; i++) touch(`bulk/dir-${i % 40}/f-${i}.txt`);
		let worst = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			worst = Math.max(worst, now - last);
			last = now;
		}, 5);
		invalidateProjectFiles(TEST_DIR);
		await searchProjectNames(TEST_DIR, "f-39");
		await searchProjectFiles(TEST_DIR, "f-39");
		clearInterval(timer);
		expect(worst).toBeLessThan(120);
	});
});
