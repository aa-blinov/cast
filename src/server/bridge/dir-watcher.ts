/**
 * Watches a project's directories, not its files.
 *
 * chokidar puts a watch on every file it walks and `stat`s each one on the
 * daemon's only thread: on a 30 000-file project that was seconds of 200 to
 * 450ms stalls each time a session went idle, for every session. Linux
 * reports a change to any file in a watched directory, so one `fs.watch` per
 * directory sees the same edits: a project of 30 000 files in a few hundred
 * folders costs a few hundred watches, set up from git's file list instead of
 * a walk. A folder created later is noticed through its parent and walked
 * asynchronously.
 */

import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/** Below the common `fs.inotify.max_user_watches` of 8192, which the editor and everything else on the machine share. */
export const MAX_WATCHED_DIRS = 4000;
const WALK_YIELD_EVERY = 50;

export type DirChange = "change" | "addDir";

export interface DirWatcher {
	close: () => void;
	/** How many directories are watched. */
	size: () => number;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function watchDirectories(
	root: string,
	initialDirs: string[],
	isIgnored: (path: string) => boolean,
	onChange: (kind: DirChange, path: string) => void,
	onError: () => void,
	maxDirs = MAX_WATCHED_DIRS,
): DirWatcher {
	const watchers = new Map<string, FSWatcher>();
	// When each watch went up. macOS reports the directory and everything in
	// it as changes the moment a watch starts, and the index was built from
	// that same state a moment earlier — so an entry older than the watch is
	// the state that was already there, not a change.
	const startedAt = new Map<string, number>();
	let closed = false;

	function drop(dir: string): void {
		for (const [path, watcher] of watchers) {
			if (path !== dir && !path.startsWith(`${dir}/`)) continue;
			try {
				watcher.close();
			} catch {
				// already closed
			}
			watchers.delete(path);
		}
	}

	function add(dir: string): void {
		if (closed || watchers.has(dir) || watchers.size >= maxDirs || isIgnored(dir)) return;
		try {
			// A wall-clock timestamp with sub-millisecond precision: a file's
			// mtime carries one, and Date.now() truncates — the entry that was
			// already there would look newer than the watch by a fraction.
			const since = performance.timeOrigin + performance.now();
			const watcher = watch(dir, (event, filename) => handle(dir, event, filename, since));
			watcher.on("error", () => {
				drop(dir);
				// The root going away (a removed sandbox) leaves nothing to watch.
				if (dir === root) onError();
			});
			watchers.set(dir, watcher);
			startedAt.set(dir, since);
		} catch {
			// A folder that vanished between the listing and the watch, or one we can't read.
		}
	}

	/** Watches `dir` and everything below it that isn't ignored, yielding to the loop as it goes. */
	async function addTree(start: string): Promise<void> {
		const stack = [start];
		let visited = 0;
		while (stack.length > 0 && !closed && watchers.size < maxDirs) {
			const dir = stack.pop() as string;
			if (isIgnored(dir)) continue;
			add(dir);
			try {
				for (const entry of await readdir(dir, { withFileTypes: true })) {
					if (entry.isDirectory()) stack.push(join(dir, entry.name));
				}
			} catch {
				continue;
			}
			// biome-ignore lint/performance/noAwaitInLoops: yielding to the event loop is the reason for the await
			if (++visited % WALK_YIELD_EVERY === 0) await yieldToLoop();
		}
	}

	function handle(dir: string, event: string, filename: string | Buffer | null, since: number): void {
		if (closed) return;
		if (!filename) {
			onChange("change", dir);
			return;
		}
		const name = filename.toString();
		// macOS names the watched directory itself when something inside it
		// changes. That is the directory, not a file in it: joining the name
		// onto the path would report a file that does not exist.
		const path = name === basename(dir) ? dir : join(dir, name);
		if (isIgnored(path) || closed) return;
		// A rename is a create or a delete; only a stat says which, and whether
		// what appeared is a folder that needs watching too.
		// The answer can arrive after close(): a closed watcher reports nothing, however late the stat comes back.
		stat(path).then(
			(info) => {
				if (closed) return;
				// Older than the watch: this is the state that was already
				// there, which macOS reports when the watch starts. A file
				// counts by its ctime (the inode's change time), so one that
				// was copied in with its mtime preserved still counts as new;
				// the directory itself counts by its mtime, which is what
				// changes when an entry is added to or removed from it.
				if (path === dir ? info.mtimeMs < since : info.ctimeMs < since) return;
				if (event !== "rename") {
					onChange("change", path);
					return;
				}
				if (info.isDirectory()) {
					onChange("addDir", path);
					void addTree(path);
				} else onChange("change", path);
			},
			() => {
				if (closed) return;
				drop(path);
				onChange("change", path);
			},
		);
	}

	add(root);
	for (const dir of initialDirs) add(dir);

	return {
		close: () => {
			closed = true;
			for (const watcher of watchers.values()) {
				try {
					watcher.close();
				} catch {
					// already closed
				}
			}
			watchers.clear();
		},
		size: () => watchers.size,
	};
}
