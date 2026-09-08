import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { findCanonicalGitRoot } from "./worktree.ts";

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

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			env: { ...process.env, ...GIT_NO_PROMPT_ENV, ...env },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.trim();
	} catch {
		return null;
	}
}

/**
 * Create a checkpoint snapshot of the given workspace directory.
 * If inside a Git repository, creates a lightweight git commit object via write-tree/commit-tree.
 * If not in a Git repo, returns an empty non-git checkpoint initialized for shadow file backups.
 */
export function createCheckpoint(cwd: string, forceShadow = false): TurnCheckpoint {
	const timestamp = new Date().toISOString();
	const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const repoRoot = findCanonicalGitRoot(cwd);
	const topLevel = repoRoot ? runGit(cwd, ["rev-parse", "--show-toplevel"]) : null;
	const isGitRepo =
		!forceShadow && Boolean(topLevel && runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true");

	if (isGitRepo && repoRoot) {
		// Build the tree in a disposable index. `git add -A` against the user's
		// real index would leave every pre-existing change staged just by asking
		// cast to remember an undo point.
		const indexDir = mkdtempSync(join(tmpdir(), "cast-checkpoint-"));
		try {
			const indexEnv = { GIT_INDEX_FILE: join(indexDir, "index") };
			runGit(cwd, ["add", "-A"], indexEnv);
			const treeSha = runGit(cwd, ["write-tree"], indexEnv);
			if (treeSha) {
				const headSha = runGit(cwd, ["rev-parse", "HEAD"]) ?? "";
				const commitArgs = ["commit-tree", treeSha, "-m", `cast-checkpoint-${id}`];
				if (headSha) commitArgs.push("-p", headSha);
				const commitSha = runGit(cwd, commitArgs);
				if (commitSha) return { id, timestamp, cwd, gitCommitSha: commitSha };
			}
		} finally {
			rmSync(indexDir, { recursive: true, force: true });
		}
	}

	return {
		id,
		timestamp,
		cwd,
		backups: [],
	};
}

/**
 * Record a pre-edit file backup for non-git fallback checkpointing.
 */
export function backupFileForCheckpoint(checkpoint: TurnCheckpoint, filePath: string): void {
	if (checkpoint.gitCommitSha) return; // Git handles this natively
	if (!checkpoint.backups) checkpoint.backups = [];

	const absPath = resolve(filePath);
	const relPath = relative(checkpoint.cwd, absPath);
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
 * Restore a workspace to the state captured by checkpoint.
 */
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
export function filesLostByRestore(checkpoint: TurnCheckpoint): string[] {
	if (!checkpoint.gitCommitSha || !findCanonicalGitRoot(checkpoint.cwd)) return [];
	const wouldRemove = runGit(checkpoint.cwd, ["clean", "-nd"]);
	if (!wouldRemove) return [];
	const inCheckpoint = new Set(
		// --full-tree --full-name: without them ls-tree is scoped to the cwd and
		// prints paths relative to it, so in a subdirectory the comparison below
		// was between two different namespaces (and, before that, between
		// "notes.txt" and git clean's "./notes.txt").
		(
			runGit(checkpoint.cwd, [
				"ls-tree",
				"-r",
				"--full-tree",
				"--full-name",
				"--name-only",
				checkpoint.gitCommitSha,
			]) ?? ""
		)
			.split("\n")
			.filter(Boolean),
	);
	// `git clean -nd` prints paths relative to the cwd (and prefixed with `./`
	// in a subdirectory), while `ls-tree` prints them relative to the
	// repository root. Comparing the two directly meant that in a subdirectory
	// nothing ever matched, so /undo warned that it would delete files its own
	// restore puts straight back — including files the *user* had written.
	const prefix = runGit(checkpoint.cwd, ["rev-parse", "--show-prefix"]) ?? "";
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

export function restoreCheckpoint(checkpoint: TurnCheckpoint): { ok: boolean; message: string } {
	const repoRoot = findCanonicalGitRoot(checkpoint.cwd);

	if (checkpoint.gitCommitSha && repoRoot) {
		try {
			// Remove post-checkpoint untracked files before restoring the tree.
			// The restore then recreates files that were untracked at the checkpoint.
			execFileSync("git", ["clean", "-fd"], {
				cwd: checkpoint.cwd,
				env: { ...process.env, ...GIT_NO_PROMPT_ENV },
				stdio: ["ignore", "pipe", "pipe"],
			});
			execFileSync("git", ["restore", `--source=${checkpoint.gitCommitSha}`, "--worktree", "--", "."], {
				cwd: checkpoint.cwd,
				env: { ...process.env, ...GIT_NO_PROMPT_ENV },
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, message: `Restored workspace to Git checkpoint ${checkpoint.gitCommitSha.slice(0, 7)}` };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, message: `Failed to restore Git checkpoint: ${msg}` };
		}
	}

	if (checkpoint.backups) {
		let restored = 0;
		const skipped: string[] = [];
		for (const backup of checkpoint.backups) {
			const absPath = join(checkpoint.cwd, backup.relPath);
			if (backup.omitted) {
				skipped.push(backup.relPath);
				continue;
			}
			if (backup.existedBefore && backup.content !== undefined) {
				mkdirSync(dirname(absPath), { recursive: true });
				// Older checkpoints stored text; anything written since is base64.
				writeFileSync(
					absPath,
					backup.encoding === "base64"
						? Buffer.from(backup.content, "base64")
						: Buffer.from(backup.content, "utf8"),
				);
				restored++;
			} else if (!backup.existedBefore) {
				if (existsSync(absPath)) {
					try {
						rmSync(absPath, { recursive: true, force: true });
					} catch {
						// Best effort
					}
				}
				restored++;
			}
		}
		const note = skipped.length > 0 ? ` — left untouched (too large to snapshot): ${skipped.join(", ")}` : "";
		return { ok: true, message: `Restored ${restored} file(s) from shadow checkpoint${note}` };
	}

	return { ok: false, message: "No valid checkpoint data found" };
}
