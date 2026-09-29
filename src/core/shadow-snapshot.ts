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
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
 * Commits the folder's current state to its hidden repository and pins the
 * commit with a ref. Null when the folder is too big, missing, or git fails.
 */
export async function createShadowSnapshot(
	cwd: string,
	id: string,
): Promise<{ shadowDir: string; commitSha: string } | null> {
	const shadowDir = shadowDirFor(cwd);
	if (!shadowDir || !existsSync(cwd) || !(await fitsInSnapshot(cwd))) return null;
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
	await git(cwd, shadowDir, ["update-ref", `${CHECKPOINT_REF_PREFIX}${id}`, commit]);
	return { shadowDir, commitSha: commit };
}

/** Drops the refs of released checkpoints; a repository left with none is deleted. */
export async function releaseShadowRefs(shadowDir: string, ids: string[]): Promise<void> {
	// Run from the repository itself: the session's folder is often already gone
	// (a deleted sandbox session), and ref operations don't need a work tree.
	await git(
		shadowDir,
		shadowDir,
		["update-ref", "--stdin"],
		`${ids.map((id) => `delete ${CHECKPOINT_REF_PREFIX}${id}`).join("\n")}\n`,
	);
	const remaining = await git(shadowDir, shadowDir, ["for-each-ref", "--count=1", CHECKPOINT_REF_PREFIX]);
	if (remaining === "") await rm(shadowDir, { recursive: true, force: true });
}
