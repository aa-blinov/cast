/**
 * Project files for the composer's `@` picker, TUI and web alike. The list
 * comes from git when the directory is a repository (so .gitignore holds and
 * untracked new files still show), else from ripgrep, else a bounded walk.
 */

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { score } from "../pickers/match.ts";

const MAX_FILES = 50_000;
const CACHE_MS = 5_000;
const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target"]);

const cache = new Map<string, { at: number; files: string[] }>();

function lines(cmd: string, args: string[], cwd: string, separator = "\n"): string[] | undefined {
	const run = spawnSync(cmd, args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 5_000 });
	if (run.status !== 0 || run.error) return undefined;
	return run.stdout.split(separator).filter(Boolean);
}

function walk(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0 && out.length < MAX_FILES) {
		const dir = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!WALK_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
			} else if (entry.isFile()) out.push(relative(root, join(dir, entry.name)));
		}
	}
	return out;
}

export function listProjectFiles(cwd: string): string[] {
	const hit = cache.get(cwd);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
	const files =
		// -z: unquoted paths, so a name with spaces or non-ASCII comes back as is.
		(
			lines("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, "\0") ??
			lines("rg", ["--files"], cwd) ??
			walk(cwd)
		).slice(0, MAX_FILES);
	cache.set(cwd, { at: Date.now(), files });
	return files;
}

/** Best matches first: a hit in the file name beats one in the directories. */
export function searchProjectFiles(cwd: string, query: string, limit = 50): string[] {
	const files = listProjectFiles(cwd);
	const q = query.toLowerCase();
	if (!q) return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
	const ranked: { path: string; rank: number }[] = [];
	for (const path of files) {
		const lower = path.toLowerCase();
		const inName = score(basename(lower), q);
		const rank = inName >= 0 ? inName + 1000 : score(lower, q);
		if (rank >= 0) ranked.push({ path, rank });
	}
	ranked.sort((a, b) => b.rank - a.rank || a.path.length - b.path.length);
	return ranked.slice(0, limit).map((r) => r.path);
}
