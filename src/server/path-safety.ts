/**
 * Path containment for the file routes: keeping a session's file browser from
 * reading, downloading, uploading or deleting anything outside its own cwd, no
 * matter what `..`-laden path (or symlink) a request goes through.
 */

import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative } from "node:path";

function within(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** realpath of `path`, or of its closest existing ancestor when it doesn't
 * exist yet — a rename destination or a not-yet-created directory still has
 * to be judged by where its parent actually lives. */
function realPathOrNearest(path: string): string {
	let current = path;
	for (;;) {
		try {
			return realpathSync(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			current = parent;
		}
	}
}

async function realPathOrNearestAsync(path: string): Promise<string> {
	let current = path;
	for (;;) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: each step depends on the previous one failing
			return await realpath(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return path;
			current = parent;
		}
	}
}

/** True whenever `target` is `root` itself or somewhere underneath it. */
export function isInsideRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return false;
	// The lexical check above can't see through a symlink, and every
	// consumer follows one (stat, createReadStream, rm, rename) — so a link
	// inside the cwd pointing at, say, /etc let the file browser list,
	// download and delete outside the project, which is the one thing this
	// check exists to prevent. Compare resolved paths too; a link the user put
	// inside their own project to another of their own directories now reads as
	// outside, which is the intended reading of "outside its own cwd".
	return within(realPathOrNearest(root), realPathOrNearest(target));
}

/** The same check without blocking the event loop (realpath walks every component). */
export async function isInsideRootAsync(root: string, target: string): Promise<boolean> {
	const rel = relative(root, target);
	if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return false;
	const [realRoot, realTarget] = await Promise.all([realPathOrNearestAsync(root), realPathOrNearestAsync(target)]);
	return within(realRoot, realTarget);
}
