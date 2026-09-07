/**
 * One definition of "the project" for every subsystem that needs one.
 *
 * Before this, each subsystem answered the question differently and a session
 * started in a subdirectory paid for it: `AGENTS.md` was inherited from every
 * ancestor (context-files.ts walks up to `/`), while `.cast/rules` was only
 * ever read from `<cwd>` down and project memory was keyed on a hash of the
 * exact `cwd`. So `cd apps/web && cast` in a monorepo silently lost the
 * repository's rules and started from an empty MEMORY.md — the file whose own
 * template says it is "shared by all sessions" — and a project-scoped history
 * search (`WHERE s.cwd = ?`) could not see sessions from the root.
 *
 * The root is the nearest ancestor that looks like a project checkout, so a
 * nested project inside a monorepo still wins over the outer one.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

const rootCache = new Map<string, string>();

function normalize(dir: string): string {
	const resolved = resolve(dir);
	return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * The project root for `cwd`, or `cwd` itself when nothing above it looks like
 * one.
 *
 * The home directory is never a root, whichever markers it has: `~/.cast` is
 * the *global* configuration directory, and a dotfiles repository would
 * otherwise make every directory under `$HOME` one enormous project sharing
 * one memory. The search also stops at the home directory rather than walking
 * into `/home` or `/`, for the same reason.
 */
export function findProjectRoot(cwd: string): string {
	const start = normalize(cwd);
	const cached = rootCache.get(start);
	if (cached !== undefined) return cached;

	const home = normalize(homedir());
	const chain: string[] = [];
	let dir = start;
	while (true) {
		chain.push(dir);
		if (dir === home) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const candidates = chain.filter((d) => d !== home);

	// `.git` first, nearest one wins: a submodule or a nested checkout inside a
	// monorepo is its own project, which is exactly what its own `.git` says.
	const gitRoot = candidates.find((d) => existsSync(resolve(d, ".git")));
	// Without any checkout, `.cast` marks the project — but the *highest* one,
	// not the nearest. `.cast/rules` in a subdirectory is the documented way to
	// write rules scoped to that subtree, so treating it as a root would split
	// the project in two and hide the outer rules from the inner directory,
	// which is the bug this whole module exists to fix.
	const castRoot = gitRoot ? undefined : candidates.filter((d) => existsSync(resolve(d, ".cast"))).at(-1);

	const root = gitRoot ?? castRoot ?? start;
	rootCache.set(start, root);
	return root;
}

/**
 * Forget cached roots. A root is derived from the filesystem, so creating a
 * `.git` or `.cast` directory mid-session changes the answer — `/reload` and
 * the tests both need to see that.
 */
export function clearProjectRootCache(): void {
	rootCache.clear();
}

/** True when `path` is `root` or lives underneath it. */
export function isUnderProjectRoot(root: string, path: string): boolean {
	const normalizedRoot = normalize(root);
	const normalizedPath = normalize(path);
	return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}
