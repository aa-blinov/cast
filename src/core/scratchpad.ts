/**
 * A session's scratchpad: a folder of its own for temporary files (intermediate results, throwaway scripts, saved
 * command output), kept out of the project and out of a shared /tmp.
 *
 * The agent is told its path in the system prompt, may read and write it without being asked (see `loop.ts`), and it
 * is removed with the session (see `deleteSession`). A sandbox session needs none: its working folder is already a
 * throwaway one of its own, so that folder is its scratchpad.
 */
import { mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export function scratchpadRoot(): string {
	return join(homedir(), ".cast", "scratch");
}

/** The throwaway working folder of a sandbox session (`~/.cast/sandbox/cast-<id>`). */
export function sandboxDirFor(sessionId: string): string {
	return join(homedir(), ".cast", "sandbox", `cast-${sessionId}`);
}

/** Matched exactly, never by prefix: a project that merely lives under ~/.cast/sandbox is not a sandbox. */
export function isSandboxCwd(sessionId: string, cwd: string | undefined): boolean {
	return cwd !== undefined && cwd === sandboxDirFor(sessionId);
}

/** Where the scratchpad of the session `sessionId` working in `cwd` is. */
export function scratchpadFor(sessionId: string, cwd: string): string {
	return isSandboxCwd(sessionId, cwd) ? cwd : join(scratchpadRoot(), sessionId);
}

/**
 * Makes the folder if it is not there (private to the user: it can hold anything the agent fetched or generated), and
 * says whether it is there afterwards. A scratchpad that cannot be made is not named to the model: it would send its
 * temporary files to a path that fails, when it would otherwise have used the project.
 */
export function ensureScratchpad(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return true;
	} catch {
		return false;
	}
}

/** Removes the scratchpad of a deleted session. The sandbox folder is not this function's to remove. */
export function removeScratchpadFor(sessionId: string): void {
	try {
		rmSync(join(scratchpadRoot(), sessionId), { recursive: true, force: true });
	} catch {
		// Best-effort, like the other per-session folders: it must not fail the delete or stall the prune.
	}
}

/** A path in a system temp folder: where a model reaches for a throwaway file when nobody has told it of a better place. */
export function isTemporaryPath(path: string): boolean {
	const roots = [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** Added to a refusal of a write to a system temp folder: it says where the temporary file may go. */
export function scratchpadRefusalHint(path: string, scratchpad: string | undefined): string {
	if (!scratchpad || !isTemporaryPath(path)) return "";
	return ` For temporary files use your scratchpad, ${scratchpad}, which needs no permission.`;
}

/** What the model is told. Not given to a sandbox session, whose working folder is the scratch space already. */
export function scratchpadPromptBlock(dir: string): string {
	return `## Scratchpad

Your scratchpad for this session is ${dir}

Put temporary files there: intermediate results, throwaway scripts, downloaded or generated data, command output you want to keep. Use it instead of /tmp or the project, so the project stays clean and nothing collides with another session. You can read and write it without asking. It is deleted with the session, so anything the user should keep belongs in the project.`;
}
