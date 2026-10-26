import { type Dirent, existsSync, type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { globalPersonasDir } from "./personas.ts";
import { findProjectRoot } from "./project-root.ts";
import { discoverProjectRuleDirs, globalRulesDir } from "./rules.ts";
import { loadSettings } from "./settings.ts";
import { builtinSkillsDir } from "./skills.ts";

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const CONTEXT_FILE_NAMES = new Set(CONTEXT_FILE_CANDIDATES.map((name) => name.toUpperCase()));
const RESOURCE_ROOT_NAMES = new Set([".CAST", ".AGENTS", ".CLAUDE", ".CURSOR"]);
const IGNORED_WALK_DIRS = new Set([".git", "node_modules", "vendor", ".venv", "venv"]);
const PATH_SEPARATOR_RE = /[\\/]/;
const DEBOUNCE_MS = 120;
const RESCAN_INTERVAL_MS = 2_000;

interface ResourceSnapshot {
	watchDirectories: Set<string>;
	resourceDirectories: Set<string>;
	parentFilters: Map<string, Set<string>>;
	signature: string;
}

function contextDirectories(cwd: string): Set<string> {
	const directories = new Set<string>();
	let current = resolve(cwd);
	while (true) {
		if (existsSync(current)) directories.add(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const home = homedir();
	directories.add(home);
	return directories;
}

function resourceRoots(
	cwd: string,
	extraPaths: string[],
): { directories: Set<string>; files: Set<string>; settingsSignature: string } {
	const home = homedir();
	const globalCast = join(home, ".cast");
	const projectCast = join(cwd, ".cast");
	const settings = loadSettings();
	const directories = new Set([
		join(globalCast, "skills"),
		globalRulesDir(),
		globalPersonasDir(),
		join(home, ".agents", "skills"),
		join(home, ".config", "agents", "skills"),
		join(home, ".claude", "skills"),
		join(projectCast, "skills"),
		join(projectCast, "rules"),
		join(projectCast, "personas"),
		join(cwd, ".agents", "skills"),
		join(cwd, ".claude", "skills"),
		join(cwd, ".cursor", "rules"),
	]);
	const projectRoot = findProjectRoot(cwd);
	directories.add(join(projectRoot, ".cast", "rules"));
	directories.add(join(projectRoot, ".cursor", "rules"));
	for (const { dir } of discoverProjectRuleDirs(projectRoot)) directories.add(dir);
	const files = new Set([
		join(globalCast, "mcp.json"),
		join(projectCast, "mcp.json"),
		join(globalCast, "hooks.json"),
		join(projectCast, "hooks.json"),
		join(globalCast, "ssh.json"),
		join(projectCast, "ssh.json"),
	]);
	for (const path of extraPaths) {
		const absolutePath = resolve(cwd, path);
		try {
			if (statSync(absolutePath).isDirectory()) directories.add(absolutePath);
			else files.add(absolutePath);
		} catch {
			if (extname(absolutePath)) files.add(absolutePath);
			else directories.add(absolutePath);
		}
	}
	return {
		directories,
		files,
		settingsSignature: JSON.stringify({
			disabledMcpServers: settings.disabledMcpServers ?? [],
			disabledSkills: settings.disabledSkills ?? [],
			disabledSkillSources: settings.disabledSkillSources ?? [],
			disabledHooks: settings.disabledHooks ?? [],
			projectTrust: settings.projectTrust ?? {},
		}),
	};
}

function buildSnapshot(cwd: string, extraPaths: string[]): ResourceSnapshot {
	const { directories: roots, files: rootFiles, settingsSignature } = resourceRoots(cwd, extraPaths);
	const watchDirectories = contextDirectories(cwd);
	const resourceDirectories = new Set<string>();
	const parentFilters = new Map<string, Set<string>>();
	const entries: Array<[string, number, number, number, number]> = [];
	const visited = new Set<string>();

	function addParentFilter(path: string): void {
		const parent = dirname(path);
		let names = parentFilters.get(parent);
		if (!names) {
			names = new Set();
			parentFilters.set(parent, names);
		}
		names.add(path.slice(parent.length + 1).toUpperCase());
		if (existsSync(parent)) watchDirectories.add(parent);
	}

	function addFile(path: string): void {
		addParentFilter(path);
		try {
			const stats = statSync(path);
			if (stats.isFile()) entries.push([path, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino]);
		} catch {
			// Missing resources are expected; a later directory event adds them.
		}
	}

	function walk(directory: string): void {
		if (visited.has(directory)) return;
		visited.add(directory);
		let entriesInDirectory: Dirent[];
		try {
			entriesInDirectory = readdirSync(directory, { withFileTypes: true });
		} catch {
			addParentFilter(directory);
			return;
		}

		watchDirectories.add(directory);
		resourceDirectories.add(directory);
		try {
			const stats = statSync(directory);
			entries.push([directory, stats.size, stats.mtimeMs, stats.ctimeMs, stats.ino]);
		} catch {
			// The directory may have been removed during the scan.
		}

		for (const entry of entriesInDirectory) {
			if (entry.isDirectory()) {
				if (!IGNORED_WALK_DIRS.has(entry.name)) walk(join(directory, entry.name));
				continue;
			}
			if (!entry.isFile()) continue;
			const path = join(directory, entry.name);
			if (extname(entry.name).toLowerCase() === ".md") addFile(path);
		}
	}

	for (const root of roots) walk(root);
	for (const file of rootFiles) addFile(file);
	addFile(join(homedir(), ".cast", "settings.json"));
	// Built-in skills ship with the running package. Watching their root keeps
	// development checkouts responsive without scanning the entire prompts tree.
	if (existsSync(builtinSkillsDir)) walk(builtinSkillsDir);

	for (const directory of contextDirectories(cwd)) {
		for (const name of CONTEXT_FILE_CANDIDATES) addFile(join(directory, name));
	}

	return {
		watchDirectories,
		resourceDirectories,
		parentFilters,
		signature: JSON.stringify({
			entries: entries.sort(([a], [b]) => a.localeCompare(b)),
			settings: settingsSignature,
		}),
	};
}

/**
 * Watches project instructions and loaded skill/rule/persona/MCP sources.
 * Directory watchers are non-recursive on purpose: recursive `fs.watch`
 * differs across Windows, macOS, and Linux. A periodic metadata scan is the
 * fallback for filesystems that miss native events or do not support watches.
 */
export function watchProjectContextFiles(
	cwd: string,
	onChange: () => void | Promise<void>,
	extraPaths: string[] = [],
): () => void {
	let closed = false;
	let snapshot = buildSnapshot(cwd, extraPaths);
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let forceCheckPending = false;
	const watchers = new Map<string, FSWatcher>();

	function checkForChanges(force = false): void {
		if (closed) return;
		const next = buildSnapshot(cwd, extraPaths);
		const changed = force || next.signature !== snapshot.signature;
		snapshot = next;
		refreshWatchers();
		if (!changed) return;
		try {
			void Promise.resolve(onChange()).catch((error: unknown) => {
				console.warn(`[context watcher] reload failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		} catch (error) {
			console.warn(`[context watcher] reload failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function scheduleCheck(force = true): void {
		if (closed) return;
		forceCheckPending ||= force;
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			const forceCheck = forceCheckPending;
			forceCheckPending = false;
			checkForChanges(forceCheck);
		}, DEBOUNCE_MS);
		debounceTimer.unref?.();
	}

	function refreshWatchers(): void {
		if (closed) return;
		for (const [directory, watcher] of watchers) {
			if (snapshot.watchDirectories.has(directory)) continue;
			watcher.close();
			watchers.delete(directory);
		}
		for (const directory of snapshot.watchDirectories) {
			if (watchers.has(directory)) continue;
			try {
				const watcher = watch(directory, { persistent: false, encoding: "utf8" }, (_event, filename) => {
					if (filename === null) {
						scheduleCheck();
						return;
					}
					const name = filename.toString().split(PATH_SEPARATOR_RE).at(-1)?.toUpperCase();
					if (!name) return;
					if (snapshot.resourceDirectories.has(directory)) {
						scheduleCheck();
						return;
					}
					if (
						CONTEXT_FILE_NAMES.has(name) ||
						RESOURCE_ROOT_NAMES.has(name) ||
						snapshot.parentFilters.get(directory)?.has(name)
					)
						scheduleCheck(name !== "SETTINGS.JSON");
				});
				watcher.on("error", () => {
					watcher.close();
					if (watchers.get(directory) === watcher) watchers.delete(directory);
				});
				watchers.set(directory, watcher);
			} catch {
				// The periodic metadata scan still detects changes without native watches.
			}
		}
	}

	refreshWatchers();
	const poll = setInterval(checkForChanges, RESCAN_INTERVAL_MS);
	poll.unref?.();

	return () => {
		if (closed) return;
		closed = true;
		clearInterval(poll);
		if (debounceTimer) clearTimeout(debounceTimer);
		for (const watcher of watchers.values()) watcher.close();
		watchers.clear();
	};
}
