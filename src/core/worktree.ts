/**
 * Session-scoped git worktree — opt-in via `cast -w <name>` / `--worktree <name>`.
 *
 * One worktree per session: the agent loop's cwd is the worktree's path, so every
 * tool (bash, read, write, edit) sees an isolated working copy on its own branch
 * and never touches the user's main checkout. Two `cast -w foo` + `cast -w bar`
 * runs in parallel never collide — different paths, different branches, same git
 * object DB. The worktree is reused across `--resume` of the same session because
 * `SessionState.cwd` already records the worktree path and `runStartup` restores
 * it on resume.
 *
 * Modeled on the same shape Claude Code uses (`--worktree` / EnterWorktreeTool):
 * branch prefix `cast-<slug>`, worktree dir `<repoRoot>/.cast/worktrees/<slug>`,
 * flat-slug mapping `a/b → a+b` to dodge a D/F ref conflict and a parent-child
 * worktree race. The `+` is invalid in the slug allowlist so the mapping is
 * injective — every valid slug round-trips through `flatten` uniquely.
 *
 * Not implemented here (deliberate, v2 if/when needed):
 *  - Mid-session EnterWorktree/ExitWorktree tool for the model.
 *  - `.worktreeinclude` for gitignored-file copy (.env, etc.).
 *  - `worktree.symlinkDirectories` setting.
 *  - `cleanupStaleAgentWorktrees` sweep — v1 always auto-keeps on exit.
 *  - WorktreeCreate/WorktreeRemove hooks (non-git VCS).
 *  - PR reference (`-w "#1234"`) parsing.
 */

import { execFile, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { runHooksForEvent } from "./hooks.ts";
import { resolveHooksForCwd } from "./project.ts";

const VALID_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const MAX_SLUG_LENGTH = 64;

// Suppress git/SSH credential prompts in the (rare) case worktree creation needs
// to fetch — a hung prompt here would lock the whole startup. See Claude Code's
// worktree.ts for the same constants.
const GIT_NO_PROMPT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
} as const;

export interface SessionWorktree {
	/** Absolute path to the new worktree's working directory. */
	readonly path: string;
	/** Branch checked out in the worktree (`cast-<flattened-slug>`). */
	readonly branch: string;
	/** Original user-supplied slug (pre-flatten, with `/` if any). */
	readonly name: string;
	/** Canonical main-repo root — worktree was created from here. */
	readonly repoRoot: string;
	/** Commit SHA the worktree was created at (from `git rev-parse HEAD` on the
	 * main repo at ensure time). Used to detect later divergence. */
	readonly headCommit: string;
	/** ISO timestamp the worktree was created at. */
	readonly createdAt: string;
}

/**
 * Throw if `slug` is not a valid worktree name. Per-segment allowlist, total
 * length cap, no `..` / empty / backslash segments. Slug can be `foo` or
 * `foo/bar/baz`; each segment must match `[a-zA-Z0-9._-]+`. The check runs
 * BEFORE any side effect (git worktree add, path.join), so a bad slug never
 * touches disk.
 */
export function validateWorktreeSlug(slug: string): void {
	if (typeof slug !== "string" || slug.length === 0) {
		throw new Error("Invalid worktree name: must be a non-empty string");
	}
	if (slug.length > MAX_SLUG_LENGTH) {
		throw new Error(`Invalid worktree name: must be ${MAX_SLUG_LENGTH} characters or fewer (got ${slug.length})`);
	}
	for (const segment of slug.split("/")) {
		if (segment === "." || segment === "..") {
			throw new Error(`Invalid worktree name "${slug}": must not contain "." or ".." path segments`);
		}
		// Disallow leading dot — segment can't start with a dot (ref files
		// like `.hidden` collide with the per-segment allowlist char `.`
		// even though it's syntactically valid, and a leading-dot branch is
		// almost always a user mistake).
		if (segment.startsWith(".")) {
			throw new Error(`Invalid worktree name "${slug}": segments must not start with a dot`);
		}
		if (!VALID_SEGMENT.test(segment)) {
			throw new Error(
				`Invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
			);
		}
	}
}

/**
 * Flatten nested slugs (`user/feature` → `user+feature`) for both branch name
 * and directory path. Two reasons nesting is unsafe in either location:
 *   1. Git refs: `cast-user` (file under .git/refs/heads) vs `cast-user/feature`
 *      (needs a directory) is a D/F conflict git rejects.
 *   2. Filesystem: `.cast/worktrees/user/feature/` would live inside the `user`
 *      worktree; a future `git worktree remove` on the parent would try to
 *      delete children whose mtimes might still hold uncommitted work.
 * `+` is valid in git ref names and on every common filesystem, but NOT in
 * the slug-segment allowlist — so the mapping is one-to-one and reversible
 * by humans reading the branch name.
 */
export function flattenSlug(slug: string): string {
	return slug.replaceAll("/", "+");
}

/** Branch checked out in the worktree, e.g. `cast-feature-auth`. */
export function worktreeBranchName(slug: string): string {
	return `cast-${flattenSlug(slug)}`;
}

function worktreePathFor(repoRoot: string, slug: string): string {
	return join(repoRoot, ".cast", "worktrees", flattenSlug(slug));
}

/**
 * Walk up to the canonical git root — the main repo, not a worktree of it.
 * Two reasons this matters:
 *   1. A sub-agent or `bash` that ran `cd ../<other-worktree>` would otherwise
 *      anchor the new worktree inside its sibling, which is both a layout
 *      surprise and a path-traversal risk.
 *   2. `git worktree add` from inside a worktree is legal but produces a
 *      *linked* worktree of the worktree (not of the main repo), and a future
 *      `git worktree prune` on the main repo would orphan it.
 * `--git-common-dir` returns the shared .git/ directory (resolving the
 * worktree pointer file); the parent of that directory is the main repo's
 * working tree. For non-worktree checkouts `--git-common-dir` is
 * `<repoRoot>/.git`, so the parent is the main repo itself. Falls back to
 * `null` when not in a git repo.
 *
 * The returned path is the *raw* value git itself produced (after going
 * through Node's `resolve` to lift the leading "../" off the parent). On
 * Windows that means backslashes — match callers against `git rev-parse
 * --show-toplevel` if you need a literal `===` comparison. Use the
 * exported `samePath` helper for slash/case-insensitive equivalence.
 */
export function findCanonicalGitRoot(start: string): string | null {
	const commonDir = runGit(start, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonDir) return null;
	return resolve(commonDir, "..");
}

/**
 * Two paths describe the same directory iff they refer to the same file on
 * disk. `path.resolve` alone is not enough on Windows — it doesn't collapse
 * 8.3 short paths (`C:\Users\JUSTCO~1\...`) to their long form, so a path
 * built from `os.tmpdir()` and a path returned by git (long form) compare
 * unequal even when they're the same directory. `realpathSync` is the only
 * portable way to canonicalize; we fall back to `resolve` when the path
 * doesn't exist (realpathSync throws ENOENT in that case).
 */
export function samePath(a: string, b: string): boolean {
	const realA = canonicalize(a);
	const realB = canonicalize(b);
	if (process.platform === "win32") {
		return realA.toLowerCase() === realB.toLowerCase();
	}
	return realA === realB;
}

function canonicalize(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/**
 * Create a worktree for a session, or reuse an existing one at the same path.
 *
 * Reuse is intentional and cheap: if the user quits `cast -w foo`, the worktree
 * and branch are left on disk (auto-keep, v1 has no prompt). The next
 * `cast -w foo` should not blow away that work — it should `git worktree add`
 * the same path against the same branch and let the user pick up where they
 * left off. Two cases:
 *
 *  1. Path is already registered as a worktree (the common resume case):
 *     read its current HEAD from the .git pointer file directly, no subprocess.
 *     `git rev-parse HEAD` on a per-call basis costs ~15ms of spawn overhead
 *     even for a 2ms task — and the yield lets other spawnSyncs in the
 *     background pile on, which Claude Code's tests caught at 55ms total.
 *  2. Path is not registered (first create): `git worktree add -B <branch>
 *     <path> HEAD` handles this cleanly. `-B` (not `-b`) resets an orphan
 *     branch left behind by a manual cleanup without needing a `git branch
 *     -D` subprocess.
 *
 * Throws on: not in a git repo, repo has no commits yet, slug validation fails,
 * or git worktree add itself fails (e.g. permission denied). All errors
 * surface to the user verbatim — no silent fall back to main cwd, because
 * `-w` is an explicit opt-in and silently ignoring it would mean the user's
 * mental model ("I'm in a worktree") is a lie.
 */
export async function ensureSessionWorktree(name: string, startCwd: string): Promise<SessionWorktree> {
	validateWorktreeSlug(name);

	const repoRoot = findCanonicalGitRoot(startCwd);
	if (!repoRoot) {
		throw new Error(
			"Worktree mode requires a git repository, but no git root was found from " +
				JSON.stringify(startCwd) +
				". Run `cast` from inside a git checkout, or drop the --worktree flag.",
		);
	}

	const headCommit = runGit(repoRoot, ["rev-parse", "HEAD"]);
	if (!headCommit) {
		throw new Error(
			"Worktree mode requires at least one commit, but the repository at " +
				repoRoot +
				" has no commits yet. Make an initial commit and try again.",
		);
	}

	const worktreePath = worktreePathFor(repoRoot, name);
	const branch = worktreeBranchName(name);

	// Fast resume: if this path is already a registered worktree, reuse it.
	// We only match on path (not branch) on purpose: a hand-rolled
	// `git worktree add` against the same path on a different branch is
	// exotic enough to fail loudly later (next `git status` will reveal the
	// branch mismatch) rather than papering over here. The lookup goes
	// through `git worktree list --porcelain` and matches against what git
	// itself reports as the canonical path — on Windows `path.join(...)`
	// can produce an 8.3 short form while git records the long form, and
	// string-comparing those fails even though they describe the same dir.
	const existing = findExistingWorktree(repoRoot, worktreePath);
	if (existing) {
		return {
			path: existing.path,
			branch,
			name,
			repoRoot,
			headCommit: existing.headCommit,
			createdAt: new Date().toISOString(),
		};
	}

	const result = await runGitAsyncWithStatus(repoRoot, ["worktree", "add", "-B", branch, worktreePath, "HEAD"]);
	if (!result.ok) {
		throw new Error(`Failed to create worktree at ${worktreePath}: ${result.stderr}`);
	}

	// Re-read the canonical path git stored for this worktree.
	const afterCreate = findExistingWorktree(repoRoot, worktreePath);
	const finalPath = afterCreate?.path ?? worktreePath;

	copyIgnoredConfigFiles(repoRoot, finalPath);

	return {
		path: finalPath,
		branch,
		name,
		repoRoot,
		headCommit,
		createdAt: new Date().toISOString(),
	};
}

/**
 * Look up a registered worktree of `repoRoot` by its expected path. Returns
 * the canonical path git stored (which may differ from the requested path
 * after Windows path canonicalization or junction resolution) and the
 * worktree's current HEAD commit SHA. The match compares the two paths as
 * `path.resolve()`'d strings, which is the closest Node can get to "same
 * directory" across the 8.3 / long-form and junction cases Windows throws
 * at us — git itself does the same canonicalization before storing the
 * path, so a literal `===` would mismatch even on the same physical dir.
 */
function findExistingWorktree(repoRoot: string, expectedPath: string): { path: string; headCommit: string } | null {
	const worktreesRoot = join(repoRoot, ".git", "worktrees");
	if (!existsSync(worktreesRoot)) return null;
	const porcelain = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!porcelain) return null;
	// Each worktree block is separated by a blank line and starts with
	// `worktree <path>` followed by a `HEAD <sha>` line. Walk the blocks
	// manually rather than splitting — splitting on "\n\n" silently drops
	// a trailing block that has no blank line after it, which is exactly
	// what `git worktree list` produces.
	const lines = porcelain.split("\n");
	let currentPath: string | null = null;
	let currentHead: string | null = null;
	const check = (): { path: string; headCommit: string } | null => {
		if (currentPath === null || currentHead === null) return null;
		if (!samePath(currentPath, expectedPath)) return null;
		return { path: currentPath, headCommit: currentHead };
	};
	for (const line of lines) {
		if (line === "") {
			const hit = check();
			if (hit) return hit;
			currentPath = null;
			currentHead = null;
			continue;
		}
		if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
		else if (line.startsWith("HEAD ")) currentHead = line.slice("HEAD ".length);
	}
	// No trailing blank line — check whatever the last block held.
	return check();
}

/**
 * Remove the worktree directory and its branch from the main repo. Best-effort:
 * errors are swallowed because the caller (cleanup on exit) cannot meaningfully
 * react to a partial failure — the user will see leftover files on disk and can
 * clean them up with `git worktree remove` / `git branch -D` themselves. Both
 * commands are no-ops if the worktree/branch is already gone, so this is safe
 * to call speculatively (e.g. from a signal handler).
 */
export async function disposeSessionWorktree(wt: SessionWorktree): Promise<void> {
	// `git worktree remove --force` deletes the directory and un-registers the
	// worktree from .git/worktrees/. Must run from the main repo, not the
	// worktree itself (which we're about to delete). Async: this deletes a
	// whole checkout on disk and must not freeze the loop while git works.
	await runGitAsync(wt.repoRoot, ["worktree", "remove", "--force", wt.path]);
	// `git branch -D` (capital, force) drops the branch even if it has
	// unmerged commits. We don't try to preserve them — the user kept them in
	// the working tree until they explicitly chose `-w` again, but this v1
	// always auto-keeps on exit (no `discard_changes` flow), so by the time
	// we get here, the user wants the branch gone.
	runGit(wt.repoRoot, ["branch", "-D", wt.branch]);
}

// ---- git plumbing ----

/**
 * Run `git <args>` in `cwd`, return trimmed stdout, or null on non-zero exit.
 * Used for read-only probes (`rev-parse`, `git-common-dir`) where a missing
 * value is expected and the caller wants to branch on it.
 */
function runGit(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			env: { ...process.env, ...GIT_NO_PROMPT_ENV },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.trim();
	} catch {
		return null;
	}
}

interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Run `git <args>` in `cwd`, return full result. Used for side-effecting
 * commands (worktree add) where the caller needs stderr on failure. */
function runGitWithStatus(cwd: string, args: string[]): GitResult {
	try {
		const stdout = execFileSync("git", args, {
			cwd,
			env: { ...process.env, ...GIT_NO_PROMPT_ENV },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: stdout.toString(), stderr: "" };
	} catch (err) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
		// Non-zero exit: stderr is the diagnostic. Stdout is sometimes populated
		// (e.g. "fatal: ...", but also the actual progress output we ignore);
		// we only need stderr to surface to the user.
		const stderr = e.stderr ? e.stderr.toString() : "";
		return { ok: false, stdout: "", stderr: stderr.trim() || `git exited with status ${e.status ?? "non-zero"}` };
	}
}

const execFileP = promisify(execFile);
// promisify(execFile)'s generated types don't accept `stdio` in options, so
// type the wrapper explicitly; the runtime options are what execFileSync used.
const execFileT = execFileP as (
	file: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding; stdio?: Array<"ignore" | "pipe"> },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/** Async `git <args>` — for the slow operations (worktree add/remove) that
 * must not freeze the daemon's event loop while git works. Same semantics as
 * runGit (null on failure); callers that already await are unchanged. */
async function runGitAsync(cwd: string, args: string[]): Promise<string | null> {
	try {
		const out = await execFileT("git", args, {
			cwd,
			env: { ...process.env, ...GIT_NO_PROMPT_ENV },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.stdout.toString().trim();
	} catch {
		return null;
	}
}

/** Async counterpart of runGitWithStatus for side-effecting git commands. */
async function runGitAsyncWithStatus(cwd: string, args: string[]): Promise<GitResult> {
	try {
		const out = await execFileT("git", args, {
			cwd,
			env: { ...process.env, ...GIT_NO_PROMPT_ENV },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: out.stdout.toString(), stderr: "" };
	} catch (err) {
		const e = err as { stderr?: Buffer | string; status?: number };
		const stderr = e.stderr ? e.stderr.toString() : "";
		return { ok: false, stdout: "", stderr: stderr.trim() || `git exited with status ${e.status ?? "non-zero"}` };
	}
}

// ---- shared types re-exports (intentionally not present; this module owns
// the only SessionWorktree type, and the integration site imports directly). ----

/**
 * Re-validate a stored worktree path still points inside its claimed
 * repoRoot. Defends against a session file (or pasted path) pointing at
 * `<unrelated>/.cast/worktrees/foo` after the repo moved or was deleted.
 * Returns `false` for anything outside the resolved repoRoot, including
 * symlink escapes. Used by the startup path before `process.chdir`-equivalent
 * operations hand the worktree path off to the loop.
 */
/**
 * Copy common uncommitted configuration files (.env, .env.local, .env.development)
 * from main repo root to newly created worktree so local dev environment works out-of-the-box.
 */
function copyIgnoredConfigFiles(repoRoot: string, worktreePath: string): void {
	const envFiles = [".env", ".env.local", ".env.development", ".env.test"];
	for (const file of envFiles) {
		const src = join(repoRoot, file);
		const dest = join(worktreePath, file);
		if (existsSync(src) && !existsSync(dest)) {
			try {
				copyFileSync(src, dest);
			} catch {
				// Best effort — ignore copy errors
			}
		}
	}
}

/**
 * Remove a worktree and its branch given a slug/name or path.
 */
/** Thrown when a WorktreeCreate hook refuses the creation. */
export class WorktreeBlockedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "WorktreeBlockedError";
	}
}

/**
 * ensureSessionWorktree plus the documented WorktreeCreate hook.
 *
 * The hook is documented as able to cancel a worktree creation, but it used to
 * be fired from exactly one of the four places that create one (the web
 * bridge's /worktree) — the TUI's /worktree, the `--worktree` CLI flag and
 * `POST /api/sessions {worktree}` all called ensureSessionWorktree directly
 * and never asked. Putting the hook here means every caller honours it by
 * construction, and a new call site can't quietly skip it.
 */
export async function createSessionWorktree(
	name: string,
	startCwd: string,
	context: { sessionId?: string; projectTrusted: boolean },
): Promise<SessionWorktree> {
	const before = await runHooksForEvent(resolveHooksForCwd(startCwd, context.projectTrusted), {
		event: "WorktreeCreate",
		cwd: startCwd,
		sessionId: context.sessionId,
		payload: { worktree_name: name },
	});
	if (before.blocked) throw new WorktreeBlockedError(before.reason ?? "Worktree creation blocked by hook");
	return ensureSessionWorktree(name, startCwd);
}

/** removeWorktreeBySlug plus the WorktreeRemove hook, for the same reason as
 *  createSessionWorktree above — the TUI's /worktree remove never fired it. */
export async function removeSessionWorktree(
	name: string,
	startCwd: string,
	context: { sessionId?: string; projectTrusted: boolean; worktreePath?: string },
): Promise<{ ok: boolean; message: string }> {
	const result = await removeWorktreeBySlug(name, startCwd);
	if (result.ok) {
		void runHooksForEvent(resolveHooksForCwd(startCwd, context.projectTrusted), {
			event: "WorktreeRemove",
			cwd: startCwd,
			sessionId: context.sessionId,
			payload: { worktree_name: name, worktree_path: context.worktreePath },
		});
	}
	return result;
}

export async function removeWorktreeBySlug(name: string, startCwd: string): Promise<{ ok: boolean; message: string }> {
	validateWorktreeSlug(name);
	const repoRoot = findCanonicalGitRoot(startCwd);
	if (!repoRoot) {
		return { ok: false, message: "Not in a git repository" };
	}
	const wtPath = worktreePathFor(repoRoot, name);
	const branch = worktreeBranchName(name);

	const existing = findExistingWorktree(repoRoot, wtPath);
	if (!existing && !existsSync(wtPath)) {
		return { ok: false, message: `Worktree "${name}" does not exist` };
	}

	const removeRes = await runGitAsyncWithStatus(repoRoot, ["worktree", "remove", "--force", wtPath]);
	runGitWithStatus(repoRoot, ["branch", "-D", branch]);

	if (!removeRes.ok && existsSync(wtPath)) {
		return { ok: false, message: `Failed to remove worktree: ${removeRes.stderr}` };
	}
	return { ok: true, message: `Worktree "${name}" and branch "${branch}" removed` };
}

/**
 * List all cast worktrees for the current git repo.
 */
export function listWorktrees(startCwd: string): Array<{ name: string; path: string; branch: string }> {
	const repoRoot = findCanonicalGitRoot(startCwd);
	if (!repoRoot) return [];
	const porcelain = runGit(repoRoot, ["worktree", "list", "--porcelain"]);
	if (!porcelain) return [];

	const results: Array<{ name: string; path: string; branch: string }> = [];
	const prefix = join(repoRoot, ".cast", "worktrees");
	const blocks = porcelain.split("\n\n");

	for (const block of blocks) {
		let path = "";
		let branch = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			if (line.startsWith("branch ")) branch = line.slice("branch refs/heads/".length);
		}
		if (path && samePath(resolve(path, ".."), prefix)) {
			const name = relative(prefix, path).replaceAll("+", "/");
			results.push({ name, path, branch });
		}
	}
	return results;
}

export function isWorktreeInsideRepo(wtPath: string, repoRoot: string): boolean {
	if (!wtPath || !repoRoot) return false;
	const absWt = resolve(wtPath);
	const absRoot = resolve(repoRoot);
	const rel = relative(absRoot, absWt);
	if (rel === "" || rel.startsWith("..")) return false;
	const withSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep;
	return absWt.startsWith(withSep);
}
