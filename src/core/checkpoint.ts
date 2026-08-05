import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findCanonicalGitRoot, samePath } from "./worktree.ts";

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

/**
 * Create a checkpoint snapshot of the given workspace directory.
 * If inside a Git repository, creates a lightweight git commit object via write-tree/commit-tree.
 * If not in a Git repo, returns an empty non-git checkpoint initialized for shadow file backups.
 */
export function createCheckpoint(cwd: string): TurnCheckpoint {
	const timestamp = new Date().toISOString();
	const id = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const repoRoot = findCanonicalGitRoot(cwd);
	const isGitRepo = Boolean(repoRoot && runGit(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true");

	if (isGitRepo && repoRoot) {
		// Stage all changes (including untracked files) to index temporarily for write-tree
		runGit(cwd, ["add", "-A"]);
		const treeSha = runGit(cwd, ["write-tree"]);
		if (treeSha) {
			const headSha = runGit(cwd, ["rev-parse", "HEAD"]) ?? "";
			const commitArgs = ["commit-tree", treeSha, "-m", `cast-checkpoint-${id}`];
			if (headSha) {
				commitArgs.push("-p", headSha);
			}
			const commitSha = runGit(cwd, commitArgs);
			if (commitSha) {
				return {
					id,
					timestamp,
					cwd,
					gitCommitSha: commitSha,
				};
			}
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
export function restoreCheckpoint(checkpoint: TurnCheckpoint): { ok: boolean; message: string } {
	const repoRoot = findCanonicalGitRoot(checkpoint.cwd);

	if (checkpoint.gitCommitSha && repoRoot) {
		try {
			execFileSync("git", ["checkout", checkpoint.gitCommitSha, "--", "."], {
				cwd: checkpoint.cwd,
				env: { ...process.env, ...GIT_NO_PROMPT_ENV },
				stdio: ["ignore", "pipe", "pipe"],
			});
			execFileSync("git", ["clean", "-fd"], {
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
