import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearProjectRootCache, findProjectRoot, isUnderProjectRoot } from "../src/core/project-root.ts";

describe("findProjectRoot", () => {
	let realHome: string | undefined;
	let home: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "cast-root-home-"));
		process.env.HOME = home;
		clearProjectRootCache();
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
		clearProjectRootCache();
	});

	function tree(...dirs: string[]): void {
		for (const dir of dirs) mkdirSync(join(home, dir), { recursive: true });
	}

	it("climbs to the checkout a subdirectory belongs to", () => {
		// The bug this exists for: `cd apps/web && cast` in a monorepo read
		// rules only from `apps/web/.cast/rules` and keyed memory on the exact
		// directory, so the repository's rules and MEMORY.md were invisible —
		// while AGENTS.md was still inherited from the same root.
		tree("repo/.git", "repo/apps/web/src");
		expect(findProjectRoot(join(home, "repo/apps/web/src"))).toBe(join(home, "repo"));
		expect(findProjectRoot(join(home, "repo"))).toBe(join(home, "repo"));
	});

	it("gives a nested checkout its own root", () => {
		// A submodule or vendored checkout is its own project — its own .git
		// says so — so the nearest one wins.
		tree("repo/.git", "repo/vendor/lib/.git", "repo/vendor/lib/src");
		expect(findProjectRoot(join(home, "repo/vendor/lib/src"))).toBe(join(home, "repo/vendor/lib"));
	});

	it("does not treat a subdirectory's .cast as a project of its own", () => {
		// `apps/web/.cast/rules` is the documented way to scope rules to a
		// subtree. Reading it as a root would split the project and hide the
		// outer rules from the inner directory — the very bug being fixed.
		tree("proj/.cast/rules", "proj/apps/web/.cast/rules");
		expect(findProjectRoot(join(home, "proj/apps/web"))).toBe(join(home, "proj"));
	});

	it("never makes the home directory a project, whatever markers it has", () => {
		// ~/.cast is the global configuration directory, and a dotfiles
		// repository in $HOME would otherwise make everything under it one
		// project sharing one memory.
		mkdirSync(join(home, ".cast"), { recursive: true });
		mkdirSync(join(home, ".git"), { recursive: true });
		mkdirSync(join(home, "scratch"), { recursive: true });
		expect(findProjectRoot(home)).toBe(home);
		expect(findProjectRoot(join(home, "scratch"))).toBe(join(home, "scratch"));
	});

	it("falls back to the directory itself when nothing above it is a project", () => {
		tree("loose/dir");
		expect(findProjectRoot(join(home, "loose/dir"))).toBe(join(home, "loose/dir"));
	});

	it("sees a .git file, not just a directory (worktrees and submodules)", () => {
		tree("wt/sub");
		writeFileSync(join(home, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
		expect(findProjectRoot(join(home, "wt/sub"))).toBe(join(home, "wt"));
	});

	it("re-reads the filesystem after the cache is cleared", () => {
		tree("late/sub");
		expect(findProjectRoot(join(home, "late/sub"))).toBe(join(home, "late/sub"));
		mkdirSync(join(home, "late", ".git"), { recursive: true });
		expect(findProjectRoot(join(home, "late/sub"))).toBe(join(home, "late/sub"));
		clearProjectRootCache();
		expect(findProjectRoot(join(home, "late/sub"))).toBe(join(home, "late"));
	});
});

describe("isUnderProjectRoot", () => {
	it("accepts the root itself and anything below it", () => {
		expect(isUnderProjectRoot("/a/b", "/a/b")).toBe(true);
		expect(isUnderProjectRoot("/a/b", "/a/b/c")).toBe(true);
		expect(isUnderProjectRoot("/a/b/", "/a/b/c/d")).toBe(true);
	});

	it("rejects a sibling whose name merely starts the same", () => {
		expect(isUnderProjectRoot("/a/b", "/a/bc")).toBe(false);
		expect(isUnderProjectRoot("/a/b", "/a")).toBe(false);
	});
});
