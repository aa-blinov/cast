import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { CHECKPOINT_REF_PREFIX, createShadowSnapshot, releaseShadowRefs } from "./shadow-snapshot.ts";

export interface CheckpointFileBackup {
	relPath: string;
	existedBefore: boolean;
	/** Base64 when `encoding` says so, otherwise the file's text (older checkpoints). */
	content?: string;
	encoding?: "base64";
	/** Set when the file was too large to snapshot — restore has to say so. */
	omitted?: true;
}

export interface TurnCheckpoint {
	id: string;
	timestamp: string;
	cwd: string;
	gitCommitSha?: string;
	/** Set when gitCommitSha lives in a hidden repository (a folder that is not a git repo). */
	shadowDir?: string;
	backups?: CheckpointFileBackup[];
}

const GIT_NO_PROMPT_ENV = {
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
} as const;

const WOULD_REMOVE_PREFIX_RE = /^Would remove /;
const LEADING_DOT_SLASH_RE = /^\.\//;
/** Above this, a file is recorded as un-restorable rather than copied into the
 * session store — a shadow checkpoint is persisted with the session, and a
 * multi-megabyte snapshot per edited file is not what /undo is worth. */
const MAX_SHADOW_BACKUP_BYTES = 10 * 1024 * 1024;
const TRAILING_SLASH_RE = /\/$/;
const EMPTY_SOURCE_RE = /did not match any file\(s\) known to git/;
interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/**
 * git without holding the event loop: a checkpoint runs at the start of every
 * turn and a restore on /undo, and run synchronously their git calls stopped
 * every session, SSE stream and HTTP request in the daemon until they ended.
 */
function gitRun(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			args,
			{ cwd, env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => resolvePromise({ ok: !error, stdout: stdout.trim(), stderr: String(stderr) }),
		);
	});
}

async function runGitAsync(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
	const result = await gitRun(cwd, args, env);
	return result.ok ? result.stdout : null;
}

async function insideGitRepo(cwd: string): Promise<boolean> {
	return (await runGitAsync(cwd, ["rev-parse", "--git-dir"])) !== null;
}

/** Checkpoint commits are internal objects nobody reads the author of; without
 * this, a machine with no git identity configured failed commit-tree and lost
 * git checkpoints altogether (after hashing the whole tree for nothing). */
const CHECKPOINT_IDENTITY_ENV = {
	GIT_AUTHOR_NAME: "cast",
	GIT_AUTHOR_EMAIL: "cast@localhost",
	GIT_COMMITTER_NAME: "cast",
	GIT_COMMITTER_EMAIL: "cast@localhost",
} as const;

/**
 * Create a checkpoint snapshot of the given workspace directory.
 * If inside a Git repository, creates a lightweight git commit object via write-tree/commit-tree.
 * Otherwise a small folder is committed to a hidden repository, and a big one (or `forceShadow`) gets
 * an empty checkpoint that only holds the per-file backups.
 */
export async function createCheckpoint(cwd: string, forceShadow = false): Promise<TurnCheckpoint> {
	const timestamp = new Date().toISOString();
	const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	// One rev-parse for everything the snapshot needs to know about the repo.
	const info = forceShadow
		? null
		: await runGitAsync(cwd, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
				"--show-toplevel",
				"--is-inside-work-tree",
				"--git-path",
				"index",
			]);
	const [commonDir, topLevel, insideWorkTree, indexPath] = info?.split("\n") ?? [];

	if (commonDir && topLevel && insideWorkTree === "true") {
		// Build the tree in a disposable index. `git add -A` against the user's
		// real index would leave every pre-existing change staged just by asking
		// cast to remember an undo point. It starts as a copy of the real one:
		// an empty index has no stat cache, so git re-hashed every file in the
		// tree on every turn (0.38s vs 0.03s on 20k files, same tree).
		const indexDir = mkdtempSync(join(tmpdir(), "cast-checkpoint-"));
		try {
			const tempIndex = join(indexDir, "index");
			if (indexPath && existsSync(indexPath)) copyFileSync(indexPath, tempIndex);
			const indexEnv = { GIT_INDEX_FILE: tempIndex };
			await runGitAsync(cwd, ["add", "-A"], indexEnv);
			const treeSha = await runGitAsync(cwd, ["write-tree"], indexEnv);
			if (treeSha) {
				const headSha = (await runGitAsync(cwd, ["rev-parse", "HEAD"])) ?? "";
				const commitArgs = ["commit-tree", treeSha, "-m", `cast-checkpoint-${id}`];
				if (headSha) commitArgs.push("-p", headSha);
				const commitSha = await runGitAsync(cwd, commitArgs, CHECKPOINT_IDENTITY_ENV);
				if (commitSha) {
					await runGitAsync(cwd, ["update-ref", `${CHECKPOINT_REF_PREFIX}${id}`, commitSha]);
					return { id, timestamp, cwd, gitCommitSha: commitSha };
				}
			}
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}
	}

	// Not a repository: snapshot the folder into a hidden one, unless it is too
	// big, in which case only the per-file backups below apply.
	if (!forceShadow) {
		const snapshot = await createShadowSnapshot(cwd, id);
		if (snapshot) {
			return { id, timestamp, cwd, gitCommitSha: snapshot.commitSha, shadowDir: snapshot.shadowDir, backups: [] };
		}
	}

	return {
		id,
		timestamp,
		cwd,
		backups: [],
	};
}

function isGitIgnored(cwd: string, absPath: string): boolean {
	return spawnSync("git", ["check-ignore", "-q", "--", absPath], { cwd, stdio: "ignore" }).status === 0;
}

/**
 * Record a pre-edit file backup for non-git fallback checkpointing.
 */
export function backupFileForCheckpoint(checkpoint: TurnCheckpoint, filePath: string): void {
	const absPath = resolve(filePath);
	const relPath = relative(checkpoint.cwd, absPath);
	// Git covers what it tracks inside the working directory. It does not cover a
	// file it ignores (.env, build output, coverage), which is exactly what an
	// agent edits and /undo then silently left changed, nor one outside the
	// directory the restore is scoped to.
	if (
		checkpoint.gitCommitSha &&
		!checkpoint.shadowDir &&
		!(relPath.startsWith("..") || isGitIgnored(checkpoint.cwd, absPath))
	)
		return;
	if (!checkpoint.backups) checkpoint.backups = [];
	if (checkpoint.backups.some((b) => b.relPath === relPath)) return;

	if (existsSync(absPath)) {
		try {
			// Base64 of the raw bytes, not utf8 text. Reading and writing back as
			// "utf8" replaced every byte that is not valid UTF-8 with U+FFFD, so
			// /undo on a non-git project "restored" a PNG as 22 bytes of
			// replacement characters and reported success (verified).
			const bytes = readFileSync(absPath);
			if (bytes.byteLength > MAX_SHADOW_BACKUP_BYTES) {
				checkpoint.backups.push({ relPath, existedBefore: true, omitted: true });
			} else {
				checkpoint.backups.push({
					relPath,
					existedBefore: true,
					content: bytes.toString("base64"),
					encoding: "base64",
				});
			}
		} catch {
			// Best effort
		}
	} else {
		checkpoint.backups.push({ relPath, existedBefore: false });
	}
}

/**
 * Files a restore would delete without being able to bring them back.
 *
 * Restoring a git checkpoint runs `git clean -fd` first, which removes every
 * untracked file — including ones that appeared *after* the checkpoint was
 * taken. Files that were untracked at checkpoint time are recreated by the
 * restore (they are in its tree), so those are not losses; anything else is
 * gone for good, and that includes whatever the user wrote themselves while
 * the agent worked. Callers ask first.
 */
export async function filesLostByRestore(checkpoint: TurnCheckpoint): Promise<string[]> {
	if (!checkpoint.gitCommitSha) return [];
	if (!checkpoint.shadowDir) {
		if (!(await insideGitRepo(checkpoint.cwd))) return [];
		return lostFiles(checkpoint);
	}
	// The hidden repository's own index describes some other checkpoint, so ask
	// against a throwaway copy that holds this one's tree.
	const indexDir = await mkdtemp(join(tmpdir(), "cast-lost-"));
	try {
		const env = { ...shadowEnv(checkpoint), GIT_INDEX_FILE: join(indexDir, "index") };
		if ((await runGitAsync(checkpoint.cwd, ["read-tree", checkpoint.gitCommitSha], env)) === null) return [];
		return await lostFiles(checkpoint, env);
	} finally {
		await rm(indexDir, { recursive: true, force: true });
	}
}

/** The environment that points git at a checkpoint's hidden repository. */
function shadowEnv(checkpoint: TurnCheckpoint): NodeJS.ProcessEnv | undefined {
	return checkpoint.shadowDir ? { GIT_DIR: checkpoint.shadowDir, GIT_WORK_TREE: checkpoint.cwd } : undefined;
}

async function lostFiles(checkpoint: TurnCheckpoint, env?: NodeJS.ProcessEnv): Promise<string[]> {
	const wouldRemove = await runGitAsync(checkpoint.cwd, ["clean", "-nd"], env);
	if (!wouldRemove) return [];
	const commit = checkpoint.gitCommitSha as string;
	const inCheckpoint = new Set(
		// --full-tree --full-name: without them ls-tree is scoped to the cwd and
		// prints paths relative to it, so in a subdirectory the comparison below
		// was between two different namespaces (and, before that, between
		// "notes.txt" and git clean's "./notes.txt").
		(
			(await runGitAsync(
				checkpoint.cwd,
				["ls-tree", "-r", "--full-tree", "--full-name", "--name-only", commit],
				env,
			)) ?? ""
		)
			.split("\n")
			.filter(Boolean),
	);
	// `git clean -nd` prints paths relative to the cwd (and prefixed with `./`
	// in a subdirectory), while `ls-tree` prints them relative to the
	// repository root. Comparing the two directly meant that in a subdirectory
	// nothing ever matched, so /undo warned that it would delete files its own
	// restore puts straight back — including files the *user* had written.
	const prefix = (await runGitAsync(checkpoint.cwd, ["rev-parse", "--show-prefix"], env)) ?? "";
	const removed: string[] = [];
	for (const rawLine of wouldRemove.split("\n")) {
		const line = rawLine.trim();
		// Only "Would remove …" lines are paths; git also emits notices such as
		// "Would refuse to remove current working directory", which used to be
		// listed to the user as a file about to be deleted.
		if (!WOULD_REMOVE_PREFIX_RE.test(line)) continue;
		const relToCwd = line.replace(WOULD_REMOVE_PREFIX_RE, "").replace(LEADING_DOT_SLASH_RE, "");
		const isDir = relToCwd.endsWith("/");
		const path = relToCwd.replace(TRAILING_SLASH_RE, "");
		if (!path) continue;
		const repoPath = `${prefix}${path}`;
		if (inCheckpoint.has(repoPath)) continue;
		// A directory line covers everything under it; keep it only when the
		// checkpoint holds nothing from that subtree.
		if (isDir && [...inCheckpoint].some((f) => f.startsWith(`${repoPath}/`))) continue;
		removed.push(path);
	}
	return removed;
}

/** Puts back the files saved by backupFileForCheckpoint. */
async function applyBackups(checkpoint: TurnCheckpoint): Promise<{ restored: number; skipped: string[] }> {
	let restored = 0;
	const skipped: string[] = [];
	for (const backup of checkpoint.backups ?? []) {
		const absPath = join(checkpoint.cwd, backup.relPath);
		if (backup.omitted) {
			skipped.push(backup.relPath);
			continue;
		}
		if (backup.existedBefore && backup.content !== undefined) {
			// biome-ignore lint/performance/noAwaitInLoops: a few files, restored in order
			await mkdir(dirname(absPath), { recursive: true });
			// Older checkpoints stored text; anything written since is base64.
			await writeFile(
				absPath,
				backup.encoding === "base64" ? Buffer.from(backup.content, "base64") : Buffer.from(backup.content, "utf8"),
			);
			restored++;
		} else if (!backup.existedBefore) {
			if (existsSync(absPath)) {
				try {
					await rm(absPath, { recursive: true, force: true });
				} catch {
					// Best effort
				}
			}
			restored++;
		}
	}
	return { restored, skipped };
}

const tooLargeNote = (skipped: string[]): string =>
	skipped.length > 0 ? ` — left untouched (too large to snapshot): ${skipped.join(", ")}` : "";

/**
 * Restore a workspace to the state captured by checkpoint.
 */
export async function restoreCheckpoint(checkpoint: TurnCheckpoint): Promise<{ ok: boolean; message: string }> {
	const env = shadowEnv(checkpoint);
	const failed = (result: GitResult): { ok: false; message: string } => ({
		ok: false,
		message: `Failed to restore Git checkpoint: ${result.stderr.trim() || "git failed"}`,
	});

	if (checkpoint.gitCommitSha && (checkpoint.shadowDir || (await insideGitRepo(checkpoint.cwd)))) {
		const sha = checkpoint.gitCommitSha;
		// The hidden repository's index describes the last snapshot, not this one;
		// point it at this one's tree so `clean` below judges "created since".
		if (checkpoint.shadowDir) {
			const readTree = await gitRun(checkpoint.cwd, ["read-tree", sha], env);
			if (!readTree.ok) return failed(readTree);
		}
		// Remove post-checkpoint untracked files before restoring the tree.
		// The restore then recreates files that were untracked at the checkpoint.
		const clean = await gitRun(checkpoint.cwd, ["clean", "-fd"], env);
		if (!clean.ok) return failed(clean);
		const restore = await gitRun(checkpoint.cwd, ["restore", `--source=${sha}`, "--worktree", "--", "."], env);
		// An empty checkpoint (a fresh sandbox at the first turn) has nothing under
		// `.` to restore, and git treats that as an error; the clean above already
		// removed everything created since.
		if (!restore.ok && !EMPTY_SOURCE_RE.test(restore.stderr)) return failed(restore);
		// The ignored and out-of-scope files git doesn't cover.
		const { restored, skipped } = await applyBackups(checkpoint);
		// Its job is done: let git collect the commit now.
		await gitRun(checkpoint.cwd, ["update-ref", "-d", `${CHECKPOINT_REF_PREFIX}${checkpoint.id}`], env);
		const extra = restored > 0 && !checkpoint.shadowDir ? ` and ${restored} ignored or outside-folder file(s)` : "";
		const kind = checkpoint.shadowDir ? "snapshot" : "Git checkpoint";
		return { ok: true, message: `Restored workspace to ${kind} ${sha.slice(0, 7)}${extra}${tooLargeNote(skipped)}` };
	}

	if (checkpoint.backups) {
		const { restored, skipped } = await applyBackups(checkpoint);
		// Without a snapshot there is only a copy of each file the edit and write
		// tools touched: what a shell command changed or created is not known, so
		// say so instead of reporting a full restore.
		const scope =
			" (only files changed with edit/write are restored; this folder is too big to snapshot, so changes made by shell commands are not undone)";
		return {
			ok: true,
			message: `Restored ${restored} file(s) from shadow checkpoint${scope}${tooLargeNote(skipped)}`,
		};
	}

	return { ok: false, message: "No valid checkpoint data found" };
}

/**
 * Lets git collect the commits of checkpoints that are no longer needed (their
 * session was deleted). One `update-ref --stdin` per repository, best effort.
 */
export async function releaseCheckpointRefs(checkpoints: TurnCheckpoint[]): Promise<void> {
	const byRepo = new Map<string, { cwd: string; shadowDir?: string; ids: string[] }>();
	for (const c of checkpoints) {
		if (!c.gitCommitSha) continue;
		const key = `${c.shadowDir ?? ""}\u0000${c.cwd}`;
		const entry = byRepo.get(key) ?? { cwd: c.cwd, shadowDir: c.shadowDir, ids: [] };
		entry.ids.push(c.id);
		byRepo.set(key, entry);
	}
	await Promise.all(
		[...byRepo.values()].map(({ cwd, shadowDir, ids }) => {
			if (shadowDir) return releaseShadowRefs(shadowDir, ids);
			return new Promise<void>((done) => {
				const child = execFile("git", ["update-ref", "--stdin"], { cwd }, () => done());
				child.stdin?.end(`${ids.map((id) => `delete ${CHECKPOINT_REF_PREFIX}${id}`).join("\n")}\n`);
			});
		}),
	);
}
