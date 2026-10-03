/**
 * A session's scratchpad: a folder of its own for temporary files (intermediate results, throwaway scripts, saved
 * command output), kept out of the project and out of a shared /tmp.
 *
 * The agent is told its path in the system prompt, may read and write it without being asked (see `loop.ts`), and it
 * is removed with the session (see `deleteSession`). A sandbox session needs none: its working folder is already a
 * throwaway one of its own, so that folder is its scratchpad.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

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
		// The root first, so it is private too: its entries are the ids of the user's sessions.
		if (dir.startsWith(`${scratchpadRoot()}/`) || dir.startsWith(`${scratchpadRoot()}\\`)) {
			mkdirSync(scratchpadRoot(), { recursive: true, mode: 0o700 });
		}
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
	const roots =
		process.platform === "win32" ? [tmpdir()] : [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];
	return roots.some((root) => {
		const rel = relative(root, path);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	});
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

Put temporary files there: intermediate results, throwaway scripts, downloaded or generated data, command output you want to keep. Use it instead of /tmp or the project, so the project stays clean and nothing collides with another session. You can read and write it without asking. It is deleted with the session, so you need not clean up after yourself, and anything the user should keep belongs in the project.`;
}

/** How long a scratchpad may sit untouched before the daemon removes it, whether or not its session still exists. */
export const SCRATCHPAD_RETENTION_DAYS = 30;

/**
 * The newest modification time anywhere in the folder (bounded: a scratchpad that holds a node_modules is not walked to
 * the bottom). A folder's own time only moves when an entry is added to it directly, so work in a subfolder would
 * otherwise look like idleness.
 */
export function lastActivityMs(dir: string, budget = { left: 5000 }, depth = 0): number {
	let newest = 0;
	try {
		newest = statSync(dir).mtimeMs;
		if (depth >= 6) return newest;
		for (const name of readdirSync(dir)) {
			if (budget.left-- <= 0) return newest;
			const path = join(dir, name);
			const stat = statSync(path);
			newest = Math.max(newest, stat.mtimeMs);
			if (stat.isDirectory()) newest = Math.max(newest, lastActivityMs(path, budget, depth + 1));
		}
	} catch {
		// Gone or unreadable mid-walk: what was seen stands.
	}
	return newest;
}

export interface ScratchpadListing {
	path: string;
	exists: boolean;
	files: Array<{ name: string; bytes: number }>;
	totalBytes: number;
	/** More entries than are listed. */
	truncated: boolean;
}

/** What is in a scratchpad, for `/scratchpad`: the biggest entries first, bounded. */
export function describeScratchpad(dir: string, limit = 15): ScratchpadListing {
	const files: Array<{ name: string; bytes: number }> = [];
	let total = 0;
	let seen = 0;
	const walk = (folder: string, depth: number): void => {
		let names: string[];
		try {
			names = readdirSync(folder);
		} catch {
			return;
		}
		for (const name of names) {
			if (seen >= 5000) return;
			const path = join(folder, name);
			try {
				const stat = statSync(path);
				if (stat.isDirectory()) {
					if (depth < 6) walk(path, depth + 1);
				} else {
					seen += 1;
					total += stat.size;
					files.push({ name: relative(dir, path), bytes: stat.size });
				}
			} catch {
				// vanished while listing
			}
		}
	};
	let exists = true;
	try {
		statSync(dir);
	} catch {
		exists = false;
	}
	if (exists) walk(dir, 0);
	files.sort((a, b) => b.bytes - a.bytes);
	return { path: dir, exists, files: files.slice(0, limit), totalBytes: total, truncated: files.length > limit };
}

/**
 * Empties a scratchpad but keeps the folder. Only a folder under the scratch root: a sandbox session's scratchpad is its
 * working folder, which is not this function's to empty.
 */
export function clearScratchpad(dir: string): boolean {
	const rel = relative(scratchpadRoot(), dir);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
	try {
		for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The text of `/scratchpad`: where it is and what is in it. */
export function formatScratchpadListing(listing: ScratchpadListing): string {
	if (!listing.exists) return `Scratchpad: ${listing.path}\nNot made yet: it is created when the agent first runs.`;
	if (listing.files.length === 0) return `Scratchpad: ${listing.path}\nEmpty.`;
	const rows = listing.files.map((f) => `  ${formatBytes(f.bytes).padStart(9)}  ${f.name}`);
	const more = listing.truncated ? "\n  ... and more" : "";
	return `Scratchpad: ${listing.path}\n${formatBytes(listing.totalBytes)} in files:\n${rows.join("\n")}${more}`;
}
