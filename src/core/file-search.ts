/**
 * Project files for the composer's `@` picker (TUI and web) and the web file
 * explorer's search. The list comes from git when the directory is a
 * repository (so .gitignore holds and untracked new files still show), else
 * from ripgrep, else a bounded walk.
 *
 * Nothing here blocks the event loop: the daemon serves every session from
 * one thread, so a synchronous `git ls-files` (or a walk of node_modules) in
 * a large repository froze every open session and the TUI's own input for as
 * long as it took. Listing runs in a child process or through async readdir,
 * one listing is shared by every request that arrives while it runs, and
 * ranking hands control back to the loop every few thousand paths.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { score } from "../pickers/match.ts";

const MAX_FILES = 250_000;
/** What a walk that includes ignored files may collect before it stops. */
const MAX_FILES_INCLUDING_IGNORED = 200_000;
const CACHE_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15_000;
/** Paths ranked between yields to the event loop. */
const YIELD_EVERY = 4_000;
const WHITESPACE_RE = /\s+/;
const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target"]);

export interface ProjectFiles {
	files: string[];
	/** Every directory that holds one of the files, `a/b` and `a` alike. */
	dirs: string[];
	/** True when the listing stopped at its cap: there are more files than these. */
	capped: boolean;
}

interface CacheEntry {
	at: number;
	value?: ProjectFiles;
	pending?: Promise<ProjectFiles>;
}

const cache = new Map<string, CacheEntry>();

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** stdout of a command as separator-split lines; undefined when it fails or times out. */
function lines(cmd: string, args: string[], cwd: string, separator = "\n"): Promise<string[] | undefined> {
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			resolve(undefined);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (value: string[] | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, COMMAND_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > 64 * 1024 * 1024) {
				child.kill("SIGKILL");
				finish(undefined);
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			if (code !== 0) return finish(undefined);
			finish(Buffer.concat(chunks).toString("utf-8").split(separator).filter(Boolean));
		});
	});
}

/** An async walk. `skip` names directories not entered; the cap bounds the memory it can use. */
async function walk(
	root: string,
	skip: ReadonlySet<string>,
	cap: number,
): Promise<{ files: string[]; capped: boolean }> {
	const files: string[] = [];
	const stack = [root];
	let capped = false;
	while (stack.length > 0) {
		if (files.length >= cap) {
			capped = true;
			break;
		}
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			// biome-ignore lint/performance/noAwaitInLoops: one directory at a time keeps the walk's memory and load bounded
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!skip.has(entry.name)) stack.push(join(dir, entry.name));
			} else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative(root, join(dir, entry.name)));
		}
	}
	return { files, capped };
}

function directoriesOf(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		for (let dir = dirname(file); dir !== "." && dir !== "/" && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
	}
	return [...dirs];
}

async function build(cwd: string, includeIgnored: boolean): Promise<ProjectFiles> {
	if (includeIgnored) {
		const { files, capped } = await walk(cwd, new Set([".git"]), MAX_FILES_INCLUDING_IGNORED);
		return { files, dirs: directoriesOf(files), capped };
	}
	// -z: unquoted paths, so a name with spaces or non-ASCII comes back as is.
	// --cached lists what the index has, files deleted from disk included;
	// --deleted names exactly those, so they can be taken back out.
	const [listed, deleted] = await Promise.all([
		lines("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, "\0"),
		lines("git", ["ls-files", "-z", "--deleted"], cwd, "\0"),
	]);
	if (listed) {
		const gone = new Set(deleted ?? []);
		const files = (gone.size > 0 ? listed.filter((file) => !gone.has(file)) : listed).slice(0, MAX_FILES);
		return { files, dirs: directoriesOf(files), capped: listed.length > MAX_FILES };
	}
	const ripgrep = await lines("rg", ["--files"], cwd);
	if (ripgrep) {
		const files = ripgrep.slice(0, MAX_FILES);
		return { files, dirs: directoriesOf(files), capped: ripgrep.length > MAX_FILES };
	}
	const walked = await walk(cwd, WALK_SKIP, MAX_FILES);
	return { files: walked.files, dirs: directoriesOf(walked.files), capped: walked.capped };
}

/**
 * The project's files (and the directories holding them). Cached for a few
 * seconds and shared: any number of callers arriving while one listing runs
 * wait for that one instead of each starting their own.
 */
export function listProjectFiles(cwd: string, options: { includeIgnored?: boolean } = {}): Promise<ProjectFiles> {
	const key = `${cwd}\u0000${options.includeIgnored ? "all" : "tracked"}`;
	const hit = cache.get(key);
	if (hit?.pending) return hit.pending;
	if (hit?.value && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
	const pending = build(cwd, options.includeIgnored === true).then(
		(value) => {
			cache.set(key, { at: Date.now(), value });
			return value;
		},
		(error) => {
			cache.delete(key);
			throw error;
		},
	);
	cache.set(key, { at: hit?.at ?? 0, value: hit?.value, pending });
	// A listing is a few MB in a big repository: forget the ones nobody asked for lately.
	for (const [other, entry] of cache) if (!entry.pending && Date.now() - entry.at > 60_000) cache.delete(other);
	return pending;
}

/**
 * What git ignores under `cwd`, as paths relative to it (a directory ends in
 * `/`, and is listed once instead of file by file). Empty outside a repository.
 * For the idle file watcher, which otherwise walks ignored trees: one nested
 * build folder of 11 000 files kept a daemon busy for two seconds after every
 * turn.
 */
export async function listIgnoredPaths(cwd: string): Promise<string[]> {
	return (
		(await lines(
			"git",
			["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
			cwd,
			"\0",
		)) ?? []
	);
}

/** Forget the cached listings of a project: files were created, moved or deleted. */
export function invalidateProjectFiles(cwd: string): void {
	cache.delete(`${cwd}\u0000tracked`);
	cache.delete(`${cwd}\u0000all`);
}

/** Best matches first: a hit in the file name beats one in the directories. */
export async function searchProjectFiles(cwd: string, query: string, limit = 50): Promise<string[]> {
	const { files } = await listProjectFiles(cwd);
	const q = query.toLowerCase();
	if (!q) return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
	const ranked: { path: string; rank: number }[] = [];
	for (let i = 0; i < files.length; i++) {
		const path = files[i] as string;
		const lower = path.toLowerCase();
		const inName = score(basename(lower), q);
		const rank = inName >= 0 ? inName + 1000 : score(lower, q);
		if (rank >= 0) ranked.push({ path, rank });
		// biome-ignore lint/performance/noAwaitInLoops: yielding to the event loop is the reason for the await
		if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
	}
	ranked.sort((a, b) => b.rank - a.rank || a.path.length - b.path.length);
	return ranked.slice(0, limit).map((r) => r.path);
}

export interface NameMatch {
	path: string;
	type: "file" | "dir";
}

/**
 * The explorer's search: every whitespace-separated word must appear in the
 * path, case-insensitively (`lsp test` finds `test/lsp.test.ts`). Names beat
 * directories, then shorter paths. `total` counts every match, so the caller
 * can say "showing 200 of 1,437" instead of pretending 200 was all there was.
 */
export async function searchProjectNames(
	cwd: string,
	query: string,
	options: { limit?: number; includeIgnored?: boolean } = {},
): Promise<{ results: NameMatch[]; total: number; truncated: boolean }> {
	const limit = options.limit ?? 200;
	const words = query.toLowerCase().split(WHITESPACE_RE).filter(Boolean);
	if (words.length === 0) return { results: [], total: 0, truncated: false };
	const index = await listProjectFiles(cwd, { includeIgnored: options.includeIgnored });
	const candidates: NameMatch[] = [
		...index.dirs.map((path) => ({ path, type: "dir" as const })),
		...index.files.map((path) => ({ path, type: "file" as const })),
	];
	const hits: { match: NameMatch; rank: number }[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const match = candidates[i] as NameMatch;
		const lower = match.path.toLowerCase();
		if (words.every((word) => lower.includes(word))) {
			const name = basename(lower);
			hits.push({ match, rank: words.every((word) => name.includes(word)) ? 1 : 0 });
		}
		// biome-ignore lint/performance/noAwaitInLoops: yielding to the event loop is the reason for the await
		if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
	}
	hits.sort(
		(a, b) =>
			b.rank - a.rank || a.match.path.length - b.match.path.length || a.match.path.localeCompare(b.match.path),
	);
	return {
		results: hits.slice(0, limit).map((h) => h.match),
		total: hits.length,
		// Fewer hits than asked for can still be an incomplete answer: the index itself stopped at its cap.
		truncated: hits.length > limit || index.capped,
	};
}
