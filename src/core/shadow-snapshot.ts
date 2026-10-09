/**
 * Whole-folder snapshots for a working directory that is not a git repository.
 *
 * Outside git /undo used to have only a copy of each file the edit and write
 * tools touched, so anything a shell command changed (`sed -i`, `rm`, a
 * generator, `mv`) stayed changed, and sandbox sessions, which are the default
 * start in the web UI, are never repositories. A hidden repository under
 * ~/.cast/shadow keeps the folder's state instead: `git add -A` against
 * GIT_WORK_TREE=<the folder> and a commit per turn, deduplicated by git, so a
 * turn that changed one file costs one file.
 *
 * Bounded on purpose: a folder with more than a few thousand files or tens of
 * megabytes (a home directory, a downloads folder) is not snapshotted, and the
 * caller falls back to per-file backups and says so.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync } from "node:fs";
import { lstat, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MAX_SNAPSHOT_FILES = 3000;
export const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

/** Never entered, never snapshotted: dependencies and build output are rebuilt, not restored. */
const EXCLUDED_NAMES = [
	"node_modules",
	".git",
	"dist",
	"build",
	".venv",
	"venv",
	"__pycache__",
	"target",
	".next",
	".cache",
];
const EXCLUDED = new Set(EXCLUDED_NAMES);

export const CHECKPOINT_REF_PREFIX = "refs/cast/checkpoints/";

const IDENTITY_ENV = {
	GIT_AUTHOR_NAME: "cast",
	GIT_AUTHOR_EMAIL: "cast@localhost",
	GIT_COMMITTER_NAME: "cast",
	GIT_COMMITTER_EMAIL: "cast@localhost",
	GIT_TERMINAL_PROMPT: "0",
} as const;

/** Where the hidden repositories live; undefined when this process must not write there. */
function shadowRoot(): string | undefined {
	const root = join(homedir(), ".cast", "shadow");
	// Under vitest, refuse the real home rather than fill it with repositories
	// from tests that forgot to point HOME at a temp directory.
	if (process.env.VITEST && !root.startsWith(tmpdir())) return undefined;
	return root;
}

/** The hidden repository for a folder: one per absolute path. */
export function shadowDirFor(cwd: string): string | undefined {
	const root = shadowRoot();
	if (!root) return undefined;
	return join(root, `${createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 24)}.git`);
}

/** Whether the folder is small enough to snapshot. Stops counting as soon as it is not. */
export async function fitsInSnapshot(cwd: string): Promise<boolean> {
	const start = resolve(cwd);
	// The whole home directory or the filesystem root are never a project.
	if (start === homedir() || start === "/") return false;
	const stack = [start];
	let files = 0;
	let bytes = 0;
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			// biome-ignore lint/performance/noAwaitInLoops: one folder at a time keeps the walk's load bounded
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!EXCLUDED.has(entry.name)) stack.push(join(dir, entry.name));
				continue;
			}
			if (++files > MAX_SNAPSHOT_FILES) return false;
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sizes add up until the budget is spent
				bytes += (await lstat(join(dir, entry.name))).size;
			} catch {
				continue;
			}
			if (bytes > MAX_SNAPSHOT_BYTES) return false;
		}
	}
	return true;
}

function git(cwd: string, shadowDir: string, args: string[], stdin?: string): Promise<string | null> {
	return new Promise((done) => {
		const child = execFile(
			"git",
			args,
			{
				cwd,
				env: { ...process.env, ...IDENTITY_ENV, GIT_DIR: shadowDir, GIT_WORK_TREE: cwd },
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
			},
			(error, stdout) => done(error ? null : stdout.trim()),
		);
		if (stdin !== undefined) child.stdin?.end(stdin);
	});
}

/**
 * One writer at a time per hidden repository. Sessions in the same folder share the repository, and deleting it
 * while another session writes into it (or writing while it is deleted) corrupts both. The lock file sits beside
 * the repository, not in it, so deleting the repository never removes the lock under its holder.
 *
 * Returns undefined when the lock could not be had in time: the caller skips its step rather than race.
 */
const SHADOW_LOCK_WAIT_MS = 10_000;
const SHADOW_LOCK_STALE_MS = 60_000;

async function withShadowLock<T>(shadowDir: string, work: () => Promise<T>): Promise<T | undefined> {
	const lock = `${shadowDir}.lock`;
	await mkdir(dirname(lock), { recursive: true });
	const deadline = Date.now() + SHADOW_LOCK_WAIT_MS;
	// biome-ignore lint/performance/noAwaitInLoops: polls until the other session releases the repository
	while (!(await createLockFile(lock))) {
		try {
			// A holder that died leaves its lock behind; git steps take seconds at most, so an old one is stale.
			if (Date.now() - (await stat(lock)).mtimeMs > SHADOW_LOCK_STALE_MS) await rm(lock, { force: true });
		} catch {
			// Released between the create and the stat: try again.
		}
		if (Date.now() >= deadline) return undefined;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	try {
		return await work();
	} finally {
		await rm(lock, { force: true });
	}
}

/** Exclusive create: true when this call made the file. */
async function createLockFile(path: string): Promise<boolean> {
	try {
		await writeFile(path, String(process.pid), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Commits the folder's current state to its hidden repository and pins the
 * commit with a ref. Null when the folder is too big, missing, git fails, or
 * another session holds the repository.
 */
export async function createShadowSnapshot(
	cwd: string,
	id: string,
): Promise<{ shadowDir: string; commitSha: string } | null> {
	const shadowDir = shadowDirFor(cwd);
	if (!shadowDir || !existsSync(cwd) || !(await fitsInSnapshot(cwd))) return null;
	const snapshot = await withShadowLock(shadowDir, () => commitShadowSnapshot(cwd, shadowDir, id));
	return snapshot ?? null;
}

async function commitShadowSnapshot(
	cwd: string,
	shadowDir: string,
	id: string,
): Promise<{ shadowDir: string; commitSha: string } | null> {
	if (!existsSync(join(shadowDir, "HEAD"))) {
		await mkdir(shadowDir, { recursive: true });
		if ((await git(cwd, shadowDir, ["init", "-q"])) === null) return null;
		await mkdir(join(shadowDir, "info"), { recursive: true });
		await writeFile(join(shadowDir, "info", "exclude"), `${EXCLUDED_NAMES.map((name) => `${name}/`).join("\n")}\n`);
	}
	if ((await git(cwd, shadowDir, ["add", "-A"])) === null) return null;
	const tree = await git(cwd, shadowDir, ["write-tree"]);
	if (!tree) return null;
	const commit = await git(cwd, shadowDir, ["commit-tree", tree, "-m", `cast-checkpoint-${id}`]);
	if (!commit) return null;
	// Without the ref the commit is unpinned and a later prune can take it: no snapshot is better than a dangling one.
	if ((await git(cwd, shadowDir, ["update-ref", `${CHECKPOINT_REF_PREFIX}${id}`, commit])) === null) return null;
	return { shadowDir, commitSha: commit };
}

/**
 * Drops the refs of released checkpoints; a repository left with none is deleted. The deletion and the emptiness
 * check run under the lock, so a checkpoint written at the same moment is either kept or never deleted under.
 */
export async function releaseShadowRefs(shadowDir: string, ids: string[]): Promise<void> {
	// Run from the repository itself: the session's folder is often already gone
	// (a deleted sandbox session), and ref operations don't need a work tree.
	await git(
		shadowDir,
		shadowDir,
		["update-ref", "--stdin"],
		`${ids.map((id) => `delete ${CHECKPOINT_REF_PREFIX}${id}`).join("\n")}\n`,
	);
	// A busy lock leaves the repository for the next release to judge.
	await withShadowLock(shadowDir, async () => {
		const remaining = await git(shadowDir, shadowDir, ["for-each-ref", "--count=1", CHECKPOINT_REF_PREFIX]);
		if (remaining === "") await rm(shadowDir, { recursive: true, force: true });
	});
}
