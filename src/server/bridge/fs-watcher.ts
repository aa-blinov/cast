/**
 * File-system watcher for sessions that are idle but have connected clients
 * (or hooks that care about fs_change). Fires `fs_change` SSE events so the
 * UI's Changes tab and Files tree pick up edits that happened outside of an
 * agent turn (manual editor, CI hook, etc). Suspended while a turn runs so
 * it never races `tool_end`.
 *
 * Moved out of server/bridge.ts as the second of three planned extractions
 * (broadcaster / fs-watcher / idle). fs-watcher consumes `broadcast` from
 * the broadcaster factory as a dep, and `idle` (planned next) will
 * consume `stopFsWatcher` from this factory as a dep. The watcher state
 * itself (the maps of directory watchers and debounce timers, the
 * 500ms debounce window) lives inside this module — bridge.ts only
 * needs to invoke the three exported methods.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { invalidateProjectFiles, listIgnoredPaths, listProjectFiles } from "../../core/file-search.ts";
import { runHooksForEvent } from "../../core/hooks.ts";
import { resolveHooksForCwd } from "../../core/project.ts";
import type { WebAgentSession, WebEvent } from "../bridge.ts";
import { type DirWatcher, watchDirectories } from "./dir-watcher.ts";

export interface FsWatcherDeps {
	sessions: Map<string, WebAgentSession>;
	cwd: string;
	trustForSessionCwd: (sessionCwd: string) => boolean;
	broadcast: (ws: WebAgentSession, event: WebEvent) => void;
	/** Called at the end of syncFsWatcher so the same call site that toggles
	 * the directory watcher also re-triggers the idle eviction timer. The
	 * bridge wires this to idleEvictor.syncIdleSessionEviction — kept as a
	 * callback rather than a direct import so the two factories stay
	 * decoupled (the original behaviour of "every session-state transition
	 * also re-evaluates idle eviction" is preserved by the call, not by a
	 * cross-module import). */
	onIdle: (ws: WebAgentSession) => void;
}

export interface FsWatcher {
	startFsWatcher: (ws: WebAgentSession) => void;
	stopFsWatcher: (sessionId: string) => void;
	syncFsWatcher: (ws: WebAgentSession) => void;
	/** Lets bridge.ts wire the onIdle callback after the idleEvictor factory
	 * has been constructed — fsWatcher and idleEvictor have a circular dep
	 * that this setter resolves (one direction at construction time, the
	 * other direction patched in here). */
	setOnIdle: (callback: (ws: WebAgentSession) => void) => void;
}

const TRAILING_SLASH_RE = /\/+$/;

export function createFsWatcher(deps: FsWatcherDeps): FsWatcher {
	const fsWatchers = new Map<string, DirWatcher>();
	const fsDebounceTimers = new Map<string, NodeJS.Timeout>();
	/** Sessions whose watcher is waiting for git's ignore list; stop cancels the start. */
	const starting = new Set<string>();
	const FS_DEBOUNCE_MS = 500;
	// Mutable holder — bridge.ts patches this in via setOnIdle once the
	// idleEvictor factory exists. Defaults to a no-op so construction order
	// doesn't matter.
	let onIdle: (ws: WebAgentSession) => void = deps.onIdle;

	/** Debounce + broadcast handler shared by every recursive watcher. Looks
	 * the session up on every event so we always operate on the live ws — the
	 * Map entry is replaced by re-hydration under the same id (see the race in
	 * `hydrateSession`), and a captured `ws` reference would point at a stale
	 * object whose listeners set is empty. */
	function makeFsCallback(sessionId: string): (eventName: string, filePath: string) => void {
		return (eventName, filePath) => {
			const existing = fsDebounceTimers.get(sessionId);
			if (existing) clearTimeout(existing);
			fsDebounceTimers.set(
				sessionId,
				setTimeout(() => {
					fsDebounceTimers.delete(sessionId);
					const ws = deps.sessions.get(sessionId);
					if (!ws || ws.status !== "idle") return;
					// Files appeared, moved or went: the cached search index is stale.
					invalidateProjectFiles(ws.session.cwd ?? deps.cwd);
					deps.broadcast(ws, { type: "fs_change" });
					const hookEvent = eventName === "addDir" ? "DirectoryAdded" : "FileChanged";
					const hooks = resolveHooksForCwd(
						ws.session.cwd ?? deps.cwd,
						deps.trustForSessionCwd(ws.session.cwd ?? deps.cwd),
					);
					void runHooksForEvent(hooks, {
						event: hookEvent,
						cwd: ws.session.cwd ?? deps.cwd,
						sessionId: ws.id,
						matchTarget: basename(filePath),
						payload: { file_path: filePath, file_name: basename(filePath), change_type: eventName },
					});
				}, FS_DEBOUNCE_MS),
			);
		};
	}

	function startFsWatcher(ws: WebAgentSession): void {
		if (fsWatchers.has(ws.id) || starting.has(ws.id)) return;
		const sessionCwd = ws.session.cwd;
		if (!sessionCwd || !existsSync(sessionCwd)) return;
		starting.add(ws.id);
		// Git's file and ignore lists first: they replace a walk of the tree, which
		// ran (stat by stat) on the one thread every session shares.
		void Promise.all([listIgnoredPaths(sessionCwd), listProjectFiles(sessionCwd)])
			.then(([ignoredByGit, index]) => {
				if (!starting.delete(ws.id) || fsWatchers.has(ws.id)) return;
				watchProject(ws, sessionCwd, ignoredByGit, index.dirs);
			})
			.catch(() => {
				starting.delete(ws.id);
			});
	}

	function watchProject(ws: WebAgentSession, sessionCwd: string, ignoredByGit: string[], dirs: string[]): void {
		try {
			// We exclude the usual noise (.git, node_modules, build outputs) so an
			// `npm i` or git gc doesn't fire 100k events, plus whatever git ignores.
			const ignoreSegments = new Set([
				"node_modules",
				".git",
				"dist",
				"build",
				".next",
				".cache",
				"__pycache__",
				".venv",
				"venv",
				".tox",
				".mypy_cache",
			]);
			const ignoredRoots = ignoredByGit.map((entry) => join(sessionCwd, entry.replace(TRAILING_SLASH_RE, "")));
			const isIgnored = (path: string): boolean =>
				path.split("/").some((p) => ignoreSegments.has(p)) ||
				ignoredRoots.some((root) => path === root || path.startsWith(`${root}/`));
			const onChange = makeFsCallback(ws.id);
			const watcher = watchDirectories(
				sessionCwd,
				dirs.map((dir) => join(sessionCwd, dir)),
				isIgnored,
				onChange,
				() => stopFsWatcher(ws.id),
			);
			fsWatchers.set(ws.id, watcher);
		} catch {
			// cwd may not exist (e.g. sandbox removed); ignore silently.
		}
	}

	function stopFsWatcher(sessionId: string): void {
		starting.delete(sessionId);
		fsWatchers.get(sessionId)?.close();
		fsWatchers.delete(sessionId);
		const t = fsDebounceTimers.get(sessionId);
		if (t) {
			clearTimeout(t);
			fsDebounceTimers.delete(sessionId);
		}
	}

	/** Toggles the idle watcher as the session enters/leaves a turn. */
	function syncFsWatcher(ws: WebAgentSession): void {
		const hooks = resolveHooksForCwd(ws.session.cwd ?? deps.cwd, deps.trustForSessionCwd(ws.session.cwd ?? deps.cwd));
		const needsFileHooks = Boolean(hooks.FileChanged?.length || hooks.DirectoryAdded?.length);
		if (ws.status === "idle" && (ws.listeners.size > 0 || needsFileHooks)) startFsWatcher(ws);
		else stopFsWatcher(ws.id);
		onIdle(ws);
	}

	function setOnIdle(callback: (ws: WebAgentSession) => void): void {
		onIdle = callback;
	}

	return { startFsWatcher, stopFsWatcher, syncFsWatcher, setOnIdle };
}
