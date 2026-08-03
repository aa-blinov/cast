/**
 * Worktree integration tests — exercise the real `git` CLI against throwaway
 * repositories, since mocking `git worktree add` would just be testing our
 * mocks, not git. The only non-trivial plumbing is `findCanonicalGitRoot`,
 * which calls `git rev-parse --path-format=absolute --git-common-dir` and
 * depends on git's actual behavior for submodules and linked worktrees.
 *
 * Path comparison gotcha (Windows): `os.tmpdir()` may return an 8.3 short
 * path (`C:\Users\JUSTCO~1\...`) while `git` returns the long form
 * (`c:\users\justcomex\...`). Comparing them with `===` fails. The test
 * helper `gitPath` always asks git for the canonical form of a path, so
 * both sides of every assertion are in the same form.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	disposeSessionWorktree,
	ensureSessionWorktree,
	findCanonicalGitRoot,
	flattenSlug,
	isWorktreeInsideRepo,
	samePath,
	validateWorktreeSlug,
	worktreeBranchName,
} from "../src/core/worktree.ts";

const NO_PROMPT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		env: NO_PROMPT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** True iff `git <args>` in `cwd` exits 0. Used for "does this ref exist"
 * probes where stdout is irrelevant and exit code is the answer. */
function runGitOrFail(cwd: string, args: string[]): boolean {
	try {
		execFileSync("git", args, {
			cwd,
			env: NO_PROMPT_ENV,
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

/** Resolve `path` to whatever git would call it. Used to keep comparisons
 * stable on Windows where `os.tmpdir()` may report an 8.3 short path
 * (`C:\Users\JUSTCO~1\...`) while `git` reports the long form
 * (`c:\users\justcomex\...`). Falls back to `realpathSync` for paths that
 * aren't inside a git repo, where `git rev-parse` would error. */
function gitPath(path: string): string {
	try {
		return execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], {
			env: NO_PROMPT_ENV,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return realpathSync(path);
	}
}

let tmpRoot: string;

beforeEach(() => {
	const raw = join(tmpdir(), `cast-wt-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(raw, { recursive: true });
	// Canonicalize once so all comparisons in this test use the same form.
	tmpRoot = realpathSync(raw);
});

afterEach(() => {
	if (tmpRoot && existsSync(tmpRoot)) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

/** One-commit git repo with user.email/user.name set, `.gitignore` for the
 * worktree directory so the integration test's `git status --porcelain === ""`
 * assertion doesn't see `.cast/worktrees/` as untracked noise. */
function initRepo(path: string): void {
	git(path, ["init", "--initial-branch=main"]);
	git(path, ["config", "user.email", "test@example.com"]);
	git(path, ["config", "user.name", "Test"]);
	// Disable commit.gpgsigning in case the host has it on globally — tests
	// would otherwise hang on a missing GPG key in CI.
	git(path, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(path, "README.md"), "hello\n");
	writeFileSync(join(path, ".gitignore"), ".cast/\n");
	git(path, ["add", "."]);
	git(path, ["commit", "-m", "init"]);
}

describe("validateWorktreeSlug", () => {
	const goodNames = ["foo", "feature-1", "a.b_c-d", "user/feature", "a/b/c/d"];
	for (const name of goodNames) {
		it(`accepts ${JSON.stringify(name)}`, () => {
			expect(() => validateWorktreeSlug(name)).not.toThrow();
		});
	}

	const badNames: string[] = [
		"",
		"../escape",
		"foo/../bar",
		"/leading-slash",
		"trailing/",
		"foo//bar",
		"foo bar",
		"foo\\bar",
		"foo~bar",
		"foo?bar",
		"*",
		".hidden",
	];
	for (const name of badNames) {
		it(`rejects ${JSON.stringify(name)}`, () => {
			expect(() => validateWorktreeSlug(name)).toThrow();
		});
	}

	it("rejects slugs longer than 64 chars", () => {
		expect(() => validateWorktreeSlug("a".repeat(65))).toThrow(/64 characters or fewer/);
	});

	it("rejects non-string", () => {
		// Cast through unknown to bypass the type check and exercise the guard.
		expect(() => validateWorktreeSlug(undefined as unknown as string)).toThrow();
	});
});

describe("flattenSlug + worktreeBranchName", () => {
	it("flattens nested slugs with +", () => {
		expect(flattenSlug("feature-auth")).toBe("feature-auth");
		expect(flattenSlug("user/feature")).toBe("user+feature");
		expect(flattenSlug("a/b/c/d")).toBe("a+b+c+d");
	});

	it("prefixes branch with cast-", () => {
		expect(worktreeBranchName("feature-auth")).toBe("cast-feature-auth");
		expect(worktreeBranchName("user/feature")).toBe("cast-user+feature");
	});

	it("slug segments do not contain + so the mapping is one-to-one on slug-only inputs", () => {
		// + is not in the per-segment allowlist (only [a-zA-Z0-9._-]) — so two
		// distinct valid slugs (which never contain +) can never produce the
		// same flattened form. This proves the D/F-avoidance mapping is
		// injective over the input space the user is actually allowed to type.
		const slugs = ["a", "a/b", "a/b/c/d", "feature-auth", "user/feature-x"];
		const flattened = new Set(slugs.map(flattenSlug));
		expect(flattened.size).toBe(slugs.length);
	});
});

describe("findCanonicalGitRoot", () => {
	it("returns the main repo root for a plain checkout", () => {
		initRepo(tmpRoot);
		const root = findCanonicalGitRoot(tmpRoot);
		// Module returns what git + `path.resolve` produces (Windows uses
		// backslashes after resolve); git rev-parse --show-toplevel uses
		// forward slashes. samePath normalizes both.
		expect(samePath(root ?? "", gitPath(tmpRoot))).toBe(true);
	});

	it("returns the main repo root when called from inside a worktree", () => {
		initRepo(tmpRoot);
		const wtDir = join(tmpRoot, ".cast", "worktrees", "nested");
		mkdirSync(wtDir, { recursive: true });
		git(tmpRoot, ["worktree", "add", "-B", "cast-nested", wtDir, "HEAD"]);

		const root = findCanonicalGitRoot(wtDir);
		expect(samePath(root ?? "", gitPath(tmpRoot))).toBe(true);
	});

	it("returns null outside any git repo", () => {
		expect(findCanonicalGitRoot(tmpRoot)).toBeNull();
	});
});

describe("isWorktreeInsideRepo", () => {
	it("accepts a strict descendant of repoRoot", () => {
		const root = `/tmp${sep}repo`.toLowerCase();
		const wt = join(root, ".cast", "worktrees", "foo");
		expect(isWorktreeInsideRepo(wt, root)).toBe(true);
	});

	it("rejects the repo root itself (a worktree named exactly repoRoot is bogus)", () => {
		const root = `/tmp${sep}repo`.toLowerCase();
		expect(isWorktreeInsideRepo(root, root)).toBe(false);
	});

	it("rejects anything outside the repo", () => {
		const root = `/tmp${sep}repo`.toLowerCase();
		expect(isWorktreeInsideRepo(`/tmp${sep}other`, root)).toBe(false);
		expect(isWorktreeInsideRepo(`/tmp${sep}repo-evil`, root)).toBe(false);
	});

	it("rejects empty inputs", () => {
		expect(isWorktreeInsideRepo("", "/tmp/repo")).toBe(false);
		expect(isWorktreeInsideRepo("/tmp/foo", "")).toBe(false);
	});
});

describe("ensureSessionWorktree — happy path", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpRoot;
		initRepo(repo);
	});

	it("creates a worktree on a new branch and reports the resolved paths", async () => {
		const wt = await ensureSessionWorktree("feature-auth", repo);
		expect(wt.name).toBe("feature-auth");
		expect(wt.branch).toBe("cast-feature-auth");
		expect(samePath(wt.repoRoot, gitPath(repo))).toBe(true);
		expect(samePath(wt.path, join(gitPath(repo), ".cast", "worktrees", "feature-auth"))).toBe(true);
		expect(wt.headCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(existsSync(wt.path)).toBe(true);
		// The worktree must be a real git checkout of the branch we just made.
		expect(git(wt.path, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("cast-feature-auth");
		// The main repo must list it as a worktree — its reported path should
		// match what we got back from ensure. `git worktree list` includes the
		// main checkout too, so we filter for our worktree instead of taking
		// the first block.
		const list = git(repo, ["worktree", "list", "--porcelain"]);
		const lines = list.split("\n");
		const matches: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]?.startsWith("worktree ") && samePath(lines[i].slice("worktree ".length), wt.path)) {
				matches.push(lines[i].slice("worktree ".length));
			}
		}
		expect(matches.length).toBe(1);
	});

	it("reuses an existing worktree at the same path on a second ensure", async () => {
		const first = await ensureSessionWorktree("feature-auth", repo);
		const second = await ensureSessionWorktree("feature-auth", repo);
		expect(samePath(second.path, first.path)).toBe(true);
		expect(second.headCommit).toBe(first.headCommit);
		// `git worktree list` should still show exactly one entry for this path.
		const list = git(repo, ["worktree", "list", "--porcelain"]);
		const matches = list
			.split("\n")
			.filter((line) => line.startsWith("worktree ") && samePath(line.slice("worktree ".length), first.path));
		expect(matches.length).toBe(1);
	});

	it("flattens nested slugs into a single-segment path", async () => {
		const wt = await ensureSessionWorktree("user/feature", repo);
		expect(samePath(wt.path, join(gitPath(repo), ".cast", "worktrees", "user+feature"))).toBe(true);
		expect(wt.branch).toBe("cast-user+feature");
		expect(existsSync(wt.path)).toBe(true);
	});

	it("anchors to the main repo when started from inside a worktree", async () => {
		// Create a first worktree, then start the second one from inside it.
		// Without findCanonicalGitRoot the second worktree would nest inside
		// the first one.
		const first = await ensureSessionWorktree("outer", repo);
		const second = await ensureSessionWorktree("inner", first.path);
		expect(samePath(second.repoRoot, gitPath(repo))).toBe(true);
		expect(samePath(second.path, join(gitPath(repo), ".cast", "worktrees", "inner"))).toBe(true);
		expect(existsSync(second.path)).toBe(true);
	});
});

describe("ensureSessionWorktree — failure modes", () => {
	it("throws on a non-git startCwd", async () => {
		await expect(ensureSessionWorktree("foo", tmpRoot)).rejects.toThrow(/git repository/);
	});

	it("throws on a git repo with no commits", async () => {
		git(tmpRoot, ["init", "--initial-branch=main"]);
		git(tmpRoot, ["config", "user.email", "t@e.com"]);
		git(tmpRoot, ["config", "user.name", "t"]);
		await expect(ensureSessionWorktree("foo", tmpRoot)).rejects.toThrow(/no commits/);
	});

	it("throws on an invalid slug before touching disk", async () => {
		initRepo(tmpRoot);
		await expect(ensureSessionWorktree("../escape", tmpRoot)).rejects.toThrow(/Invalid worktree name/);
		// Sanity: nothing was created.
		expect(existsSync(join(tmpRoot, ".cast", "worktrees", "..escape"))).toBe(false);
	});
});

describe("disposeSessionWorktree", () => {
	let repo: string;

	beforeEach(() => {
		repo = tmpRoot;
		initRepo(repo);
	});

	it("removes the worktree directory and the branch", async () => {
		const wt = await ensureSessionWorktree("feature-auth", repo);
		expect(existsSync(wt.path)).toBe(true);
		await disposeSessionWorktree(wt);
		expect(existsSync(wt.path)).toBe(false);
		// The branch should be gone. `git rev-parse --verify refs/heads/<name>`
		// is the precise "does this ref exist" probe — `git branch --list`
		// would mark the active branch with a `+` and noise the equality check.
		const verify = runGitOrFail(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/cast-feature-auth"]);
		expect(verify).toBe(false);
		// git worktree list should no longer mention the path.
		const list = git(repo, ["worktree", "list"]);
		expect(list).not.toContain(wt.path);
	});

	it("is idempotent — calling on an already-disposed worktree does not throw", async () => {
		const wt = await ensureSessionWorktree("feature-auth", repo);
		await disposeSessionWorktree(wt);
		// Second call: the directory is gone, the branch is gone. Both
		// subcommands should report "no such" errors which we swallow.
		await expect(disposeSessionWorktree(wt)).resolves.toBeUndefined();
	});

	it("ensures a fresh worktree after dispose (the old branch is fully gone)", async () => {
		const first = await ensureSessionWorktree("feature-auth", repo);
		await disposeSessionWorktree(first);
		const second = await ensureSessionWorktree("feature-auth", repo);
		expect(second.path).toBe(first.path);
		expect(existsSync(second.path)).toBe(true);
		// The branch exists again — `git rev-parse --verify --quiet` returns
		// exit 0 only when the ref is present.
		const verify = runGitOrFail(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/cast-feature-auth"]);
		expect(verify).toBe(true);
	});

	it("removes a worktree that has uncommitted changes when called explicitly", async () => {
		// Documents v1 behavior: dispose is "user has decided, nuke it" — we
		// always run --force. v2's ExitWorktree tool will offer a safer
		// keep/remove with discard_changes confirmation instead.
		const wt = await ensureSessionWorktree("feature-auth", repo);
		writeFileSync(join(wt.path, "dirty.txt"), "uncommitted");
		await disposeSessionWorktree(wt);
		expect(existsSync(wt.path)).toBe(false);
	});
});

describe("ensure → dispose → ensure — round trip", () => {
	it("rebuilds the same worktree cleanly", async () => {
		initRepo(tmpRoot);
		const wt1 = await ensureSessionWorktree("round-trip", tmpRoot);
		const firstHead = wt1.headCommit;
		await disposeSessionWorktree(wt1);
		const wt2 = await ensureSessionWorktree("round-trip", tmpRoot);
		expect(wt2.path).toBe(wt1.path);
		expect(wt2.headCommit).toBe(firstHead);
		// Working tree has the original README.md.
		expect(existsSync(join(wt2.path, "README.md"))).toBe(true);
	});
});

describe("integration: parent cwd does not see worktree edits", () => {
	// Documents the actual user-facing promise: edits inside the worktree
	// stay inside the worktree. Without the worktree, the parent checkout
	// would be modified too.
	it("writing inside the worktree does not change the main checkout", async () => {
		initRepo(tmpRoot);
		const wt = await ensureSessionWorktree("isolated", tmpRoot);
		writeFileSync(join(wt.path, "WORKTREE_ONLY.md"), "only in the worktree\n");
		git(wt.path, ["add", "WORKTREE_ONLY.md"]);
		git(wt.path, ["commit", "-m", "worktree-only change"]);

		// The main checkout must not see the new file.
		expect(existsSync(join(tmpRoot, "WORKTREE_ONLY.md"))).toBe(false);
		// The main checkout's status is clean.
		expect(git(tmpRoot, ["status", "--porcelain"])).toBe("");
		// The branches have diverged: main's HEAD is one commit behind.
		const mainHead = git(tmpRoot, ["rev-parse", "HEAD"]);
		const wtHead = git(wt.path, ["rev-parse", "HEAD"]);
		expect(mainHead).not.toBe(wtHead);
	});
});
