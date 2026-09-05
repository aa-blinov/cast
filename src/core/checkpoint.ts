import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { findCanonicalGitRoot } from "./worktree.ts";

export interface CheckpointFileBackup {
	relPath: string;
	existedBefore: boolean;
	content?: string;
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
			const content = readFileSync(absPath, "utf8");
			checkpoint.backups.push({ relPath, existedBefore: true, content });
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
		(runGit(checkpoint.cwd, ["ls-tree", "-r", "--name-only", checkpoint.gitCommitSha]) ?? "")
			.split("\n")
			.filter(Boolean),
	);
	const removed: string[] = [];
	for (const line of wouldRemove.split("\n")) {
		const path = line.replace(WOULD_REMOVE_PREFIX_RE, "").trim().replace(TRAILING_SLASH_RE, "");
		if (!path || inCheckpoint.has(path)) continue;
		// A directory line covers everything under it; keep it only when the
		// checkpoint holds nothing from that subtree.
		if (line.trim().endsWith("/") && [...inCheckpoint].some((f) => f.startsWith(`${path}/`))) continue;
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
		for (const backup of checkpoint.backups) {
			const absPath = join(checkpoint.cwd, backup.relPath);
			if (backup.existedBefore && backup.content !== undefined) {
				mkdirSync(dirname(absPath), { recursive: true });
				writeFileSync(absPath, backup.content, "utf8");
			} else if (!backup.existedBefore && existsSync(absPath)) {
				try {
					rmSync(absPath, { recursive: true, force: true });
				} catch {
					// Best effort
				}
			}
		}
		return { ok: true, message: `Restored ${checkpoint.backups.length} file(s) from shadow checkpoint` };
	}

	return { ok: false, message: "No valid checkpoint data found" };
}
