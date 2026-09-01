/**
 * Plugin marketplaces — Grok/Claude-shaped install for cast.
 *
 * Catalog sources live in ~/.cast/plugins/known_marketplaces.json.
 * Marketplace checkouts: ~/.cast/plugins/marketplaces/<name>/
 * Remote plugin checkouts: ~/.cast/plugins/installs/<marketplace>/<plugin>/
 *
 * UX: `/plugin install name@marketplace` (same shape as Claude/Grok).
 * Skills and hooks (`<root>/hooks.json`) are fully wired from installed
 * plugins; MCP servers/agents bundled inside a plugin are not read yet.
 */

import { execFile, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Settings } from "./settings.ts";

const DOTGIT_RE = /\.git$/i;
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\//i;
const GITHUB_SSH_RE = /^git@github\.com:/i;
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PATH_SEP_RE = /[/\\]/;
const SANITIZE_RE = /[^a-zA-Z0-9._-]/g;

const MARKETPLACE_MANIFESTS = [
	".cast-plugin/marketplace.json",
	".grok-plugin/marketplace.json",
	".claude-plugin/marketplace.json",
	".agents/plugins/marketplace.json", // Codex
] as const;

/**
 * Bundled default catalogs (Codex / Claude / Grok) — always present, seeded
 * once into ~/.cast/plugins on first plugin command (not on every startup,
 * so offline launches stay fast). Unlike user-added marketplaces, these
 * can't be removed: no trash icon in the UI, and removeMarketplace rejects
 * them outright. Re-seeded on every call until all three exist, so a
 * first-run offline failure gets retried on the next /plugin use.
 */
export const DEFAULT_MARKETPLACE_SOURCES: ReadonlyArray<{ source: string; label: string }> = [
	{ source: "jeremylongshore/claude-code-plugins-plus-skills", label: "community" },
	{ source: "anthropics/claude-plugins-official", label: "claude" },
	{ source: "xai-org/plugin-marketplace", label: "grok" },
];

export interface PluginsPaths {
	root: string;
}

export function defaultPluginsPaths(): PluginsPaths {
	return { root: join(homedir(), ".cast", "plugins") };
}

function marketplacesDir(paths: PluginsPaths): string {
	return join(paths.root, "marketplaces");
}

function installsDir(paths: PluginsPaths): string {
	return join(paths.root, "installs");
}

function knownMarketplacesPath(paths: PluginsPaths): string {
	return join(paths.root, "known_marketplaces.json");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnownMarketplace {
	name: string;
	/** Absolute path or github `owner/repo` or git URL used to fetch it. */
	source: string;
	/** Local checkout path. */
	path: string;
	installedAt: string;
	/** One of the bundled Codex/Claude/Grok catalogs — not user-removable. */
	isDefault?: boolean;
}

export interface MarketplacePluginEntry {
	name: string;
	description?: string;
	/** Resolved absolute root of the plugin package (skills live here or in skills/). */
	root: string;
	/** Original source descriptor for display / reinstall. */
	sourceLabel: string;
}

export interface MarketplaceCatalog {
	name: string;
	description?: string;
	plugins: MarketplacePluginEntry[];
	/** Directory the marketplace was loaded from. */
	dir: string;
}

export type PluginId = `${string}@${string}`;

export function pluginId(plugin: string, marketplace: string): PluginId {
	return `${plugin}@${marketplace}`;
}

export function parsePluginRef(ref: string): { plugin: string; marketplace: string } | null {
	const at = ref.lastIndexOf("@");
	if (at <= 0 || at === ref.length - 1) return null;
	const plugin = ref.slice(0, at).trim();
	const marketplace = ref.slice(at + 1).trim();
	if (!plugin || !marketplace) return null;
	return { plugin, marketplace };
}

// ---------------------------------------------------------------------------
// known_marketplaces.json
// ---------------------------------------------------------------------------

function readKnownMarketplaces(paths: PluginsPaths): Record<string, KnownMarketplace> {
	const file = knownMarketplacesPath(paths);
	if (!existsSync(file)) return {};
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		return raw as Record<string, KnownMarketplace>;
	} catch {
		return {};
	}
}

function writeKnownMarketplaces(paths: PluginsPaths, data: Record<string, KnownMarketplace>): void {
	mkdirSync(paths.root, { recursive: true });
	writeFileSync(knownMarketplacesPath(paths), JSON.stringify(data, null, 2), "utf-8");
}

export function listKnownMarketplaces(paths: PluginsPaths = defaultPluginsPaths()): KnownMarketplace[] {
	return Object.values(readKnownMarketplaces(paths)).sort((a, b) => a.name.localeCompare(b.name));
}

export interface EnsureDefaultsResult {
	/** Marketplace names newly cloned/registered. */
	added: string[];
	/** Per-source errors (offline, missing manifest, …). */
	errors: string[];
}

/**
 * Clone + register any of the default Codex/Claude/Grok marketplaces not
 * already known. Cheap no-op once all three exist (a single JSON read, no
 * network) — safe to call on every `/plugin` use rather than gating behind
 * a one-shot flag, so a source that failed on a previous offline run gets
 * retried automatically instead of needing a manual re-add.
 */
export async function ensureDefaultMarketplaces(
	paths: PluginsPaths = defaultPluginsPaths(),
	sources: ReadonlyArray<{ source: string; label: string }> = DEFAULT_MARKETPLACE_SOURCES,
): Promise<EnsureDefaultsResult> {
	const known = readKnownMarketplaces(paths);
	const added: string[] = [];
	const errors: string[] = [];
	for (const { source, label } of sources) {
		const alreadyKnown = Object.values(known).some(
			(k) => k.isDefault && normalizeSourceKey(k.source) === normalizeSourceKey(source),
		);
		if (alreadyKnown) continue;
		try {
			// Sequential on purpose, not just habit: addMarketplace does an
			// unlocked read-modify-write of the shared known-marketplaces JSON
			// file (readKnownMarketplaces → mutate → writeKnownMarketplaces) —
			// running these concurrently via Promise.all would race two writes
			// against the same file and silently drop whichever finished first.
			// biome-ignore lint/performance/noAwaitInLoops: shared-file read-modify-write below requires serialization, see comment above
			const mp = await addMarketplace(source, paths, { isDefault: true });
			added.push(`${mp.name} (${label})`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${label} (${source}): ${message}`);
		}
	}
	return { added, errors };
}

function normalizeSourceKey(source: string): string {
	return source.trim().replace(DOTGIT_RE, "").replace(GITHUB_HTTPS_RE, "").replace(GITHUB_SSH_RE, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Marketplace manifest parsing
// ---------------------------------------------------------------------------

interface RawPluginSourceObject {
	source?: string;
	type?: string;
	url?: string;
	repo?: string;
	sha?: string;
	ref?: string;
	path?: string;
}

interface RawMarketplacePlugin {
	name?: string;
	description?: string;
	source?: string | RawPluginSourceObject;
}

interface RawMarketplace {
	name?: string;
	description?: string;
	plugins?: RawMarketplacePlugin[];
}

function findMarketplaceManifest(dir: string): string | null {
	for (const rel of MARKETPLACE_MANIFESTS) {
		const p = join(dir, rel);
		if (existsSync(p)) return p;
	}
	return null;
}

function githubUrl(repo: string): string {
	return `https://github.com/${repo}.git`;
}

function resolveGitUrl(source: string): string {
	if (source.startsWith("git@") || source.startsWith("http://") || source.startsWith("https://")) return source;
	if (REPO_SLUG_RE.test(source)) return githubUrl(source);
	return source;
}

function sourceLabel(source: string | RawPluginSourceObject): string {
	if (typeof source === "string") return source;
	if (source.url) return source.path ? `${source.url}#${source.path}` : source.url;
	if (source.repo) return source.path ? `${source.repo}#${source.path}` : source.repo;
	if (source.path) return source.path;
	return JSON.stringify(source);
}

/**
 * Parse a marketplace checkout into a catalog. Relative plugin sources resolve
 * against the marketplace dir; remote sources are recorded but not fetched yet.
 */
export function loadMarketplaceCatalog(dir: string): MarketplaceCatalog {
	const manifestPath = findMarketplaceManifest(dir);
	if (!manifestPath) {
		throw new Error(`No marketplace.json under ${dir} (looked for ${MARKETPLACE_MANIFESTS.join(", ")})`);
	}
	const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as RawMarketplace;
	const name = typeof raw.name === "string" && raw.name ? raw.name : basename(dir);
	const plugins: MarketplacePluginEntry[] = [];
	for (const entry of raw.plugins ?? []) {
		if (!entry || typeof entry.name !== "string" || !entry.name) continue;
		if (entry.source === undefined || entry.source === null) continue;
		const root = resolvePluginRootFromSource(dir, entry.source);
		plugins.push({
			name: entry.name,
			description: typeof entry.description === "string" ? entry.description : undefined,
			root,
			sourceLabel: sourceLabel(entry.source),
		});
	}
	return {
		name,
		description: typeof raw.description === "string" ? raw.description : undefined,
		plugins,
		dir,
	};
}

/**
 * For catalog listing we need a root even for remote-only plugins — use a
 * sentinel under installs that installPlugin will populate. Relative/local
 * sources resolve immediately against the marketplace checkout.
 */
function resolvePluginRootFromSource(marketplaceDir: string, source: string | RawPluginSourceObject): string {
	if (typeof source === "string") {
		if (source.startsWith("./") || source.startsWith("../") || (!source.includes(":") && !source.includes("@"))) {
			return resolve(marketplaceDir, source);
		}
		// Bare github-ish string treated as remote — root filled at install.
		return "";
	}
	const kind = source.source ?? source.type;
	if (kind === "local" || (source.path && !source.url && !source.repo && kind !== "url" && kind !== "git-subdir")) {
		if (!source.path) throw new Error("local plugin source missing path");
		return resolve(marketplaceDir, source.path);
	}
	if (typeof source.path === "string" && (kind === "url" || kind === "git-subdir" || source.url || source.repo)) {
		// Remote with subdir — install clones then joins path; placeholder empty.
		return "";
	}
	if (source.url || source.repo || kind === "url" || kind === "github" || kind === "git-subdir") {
		return "";
	}
	if (source.path) return resolve(marketplaceDir, source.path);
	return "";
}

function rawPluginSource(
	marketplaceDir: string,
	pluginName: string,
): { entry: RawMarketplacePlugin; source: string | RawPluginSourceObject } {
	const catalog = loadMarketplaceCatalog(marketplaceDir);
	const manifestPath = findMarketplaceManifest(marketplaceDir);
	if (!manifestPath) throw new Error("marketplace manifest missing");
	const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as RawMarketplace;
	const entry = (raw.plugins ?? []).find((p) => p.name === pluginName);
	if (!entry?.source) {
		const names = catalog.plugins.map((p) => p.name).join(", ");
		throw new Error(`Plugin "${pluginName}" not in marketplace "${catalog.name}". Available: ${names || "(none)"}`);
	}
	return { entry, source: entry.source };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Directory-safe staging name derived from a marketplace source. Handles
 * Windows local paths too: `C:\dev\my-marketplace` must not yield a name
 * containing `\` or `:` (invalid in a directory name) — split on both
 * separators and strip anything else unsafe.
 */
export function stagingNameFor(source: string): string {
	const last = source.split(PATH_SEP_RE).filter(Boolean).pop() ?? "";
	const cleaned = last.replace(DOTGIT_RE, "").replace(SANITIZE_RE, "-");
	return cleaned || "marketplace";
}

function _runGit(args: string[], cwd?: string): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const err = error as { stderr?: Buffer | string; message?: string; code?: string };
		// git missing entirely (common on Windows) — a raw "spawn git ENOENT"
		// tells the user nothing about what to install.
		if (err.code === "ENOENT") {
			throw new Error(
				"git is not installed or not in PATH — plugin marketplaces are cloned with git. " +
					"Install git (on Windows: Git for Windows) and retry.",
			);
		}
		const stderr = err.stderr ? String(err.stderr).trim() : "";
		throw new Error(stderr || err.message || `git ${args.join(" ")} failed`);
	}
}

const execFileP = promisify(execFile);
// promisify(execFile)'s generated types don't accept `stdio` in options, so
// type the wrapper explicitly; the runtime options are what execFileSync used.
const execFileT = execFileP as (
	file: string,
	args: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv; encoding?: BufferEncoding; stdio?: Array<"ignore" | "pipe"> },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/** Async `git <args>` — marketplace clones/pulls can take seconds and must
 * not freeze the daemon's event loop while git works. Same error mapping as
 * the sync runGit. */
async function runGitAsync(args: string[], cwd?: string): Promise<string> {
	try {
		const out = await execFileT("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return out.stdout.toString().trim();
	} catch (error) {
		const err = error as { stderr?: Buffer | string; message?: string; code?: string };
		if (err.code === "ENOENT") {
			throw new Error(
				"git is not installed or not in PATH — plugin marketplaces are cloned with git. " +
					"Install git (on Windows: Git for Windows) and retry.",
			);
		}
		const stderr = err.stderr ? String(err.stderr).trim() : "";
		throw new Error(stderr || err.message || `git ${args.join(" ")} failed`);
	}
}

async function freshClone(url: string, dest: string, sha?: string): Promise<void> {
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	if (sha) {
		await runGitAsync(["clone", "--filter=blob:none", url, dest]);
		await runGitAsync(["fetch", "--depth", "1", "origin", sha], dest);
		await runGitAsync(["checkout", "--force", sha], dest);
	} else {
		await runGitAsync(["clone", "--depth", "1", url, dest]);
	}
}

// Two calls targeting the same `dest` (two tabs both installing the same
// not-yet-known marketplace, a reload racing an install) would otherwise run
// two concurrent `git clone`s into the same directory — a write-write
// collision that leaves a corrupt repo neither call intended. Serializing per
// destination lets the second call see the first's finished (or
// self-healed) result instead of racing it.
const cloneQueues = new Map<string, Promise<unknown>>();

async function cloneOrUpdate(url: string, dest: string, sha?: string): Promise<void> {
	const key = resolve(dest);
	const prior = cloneQueues.get(key) ?? Promise.resolve();
	const run = prior.then(
		() => cloneOrUpdateUnlocked(url, dest, sha),
		() => cloneOrUpdateUnlocked(url, dest, sha),
	);
	cloneQueues.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

async function cloneOrUpdateUnlocked(url: string, dest: string, sha?: string): Promise<void> {
	mkdirSync(join(dest, ".."), { recursive: true });
	if (existsSync(join(dest, ".git"))) {
		try {
			await runGitAsync(["fetch", "--depth", "1", "origin", sha ?? "HEAD"], dest);
			if (sha) {
				await runGitAsync(["checkout", "--force", sha], dest);
			} else {
				await runGitAsync(["pull", "--ff-only"], dest);
			}
			return;
		} catch {
			// A .git directory that exists but can't fetch/checkout/pull is
			// most often a clone that was interrupted (process killed,
			// network drop) partway through — git creates .git/ early and
			// fills it in progressively, so its mere presence doesn't mean
			// the repo is usable. There's nothing to salvage from a broken
			// clone; fall through to the same fresh-clone path a first
			// install takes, rather than leaving the marketplace permanently
			// stuck failing every subsequent update.
		}
	}
	await freshClone(url, dest, sha);
}

function copyLocalPlugin(src: string, dest: string): void {
	if (!existsSync(src)) throw new Error(`Plugin path does not exist: ${src}`);
	mkdirSync(join(dest, ".."), { recursive: true });
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	cpSync(src, dest, { recursive: true });
}

// ---------------------------------------------------------------------------
// Marketplace add / remove / update
// ---------------------------------------------------------------------------

export async function addMarketplace(
	source: string,
	paths: PluginsPaths = defaultPluginsPaths(),
	opts: { isDefault?: boolean } = {},
): Promise<KnownMarketplace> {
	mkdirSync(marketplacesDir(paths), { recursive: true });

	const abs = isAbsolute(source) || source.startsWith(".") ? resolve(source) : null;
	if (abs && existsSync(abs) && statSync(abs).isDirectory()) {
		const catalog = loadMarketplaceCatalog(abs);
		const dest = join(marketplacesDir(paths), catalog.name);
		if (resolve(abs) !== resolve(dest)) {
			copyLocalPlugin(abs, dest);
		}
		const known: KnownMarketplace = {
			name: catalog.name,
			source: abs,
			path: dest,
			installedAt: new Date().toISOString(),
			...(opts.isDefault ? { isDefault: true } : {}),
		};
		const all = readKnownMarketplaces(paths);
		all[catalog.name] = known;
		writeKnownMarketplaces(paths, all);
		return known;
	}

	const url = resolveGitUrl(source);
	const staging = join(marketplacesDir(paths), `.staging-${stagingNameFor(source)}-${process.pid}`);
	try {
		if (existsSync(staging)) rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		await runGitAsync(["clone", "--depth", "1", url, staging]);
		const catalog = loadMarketplaceCatalog(staging);
		const dest = join(marketplacesDir(paths), catalog.name);
		// Retries: on Windows an antivirus/indexer briefly holding a handle on
		// freshly-cloned files makes rm/rename fail with EPERM/EBUSY — a couple
		// of spaced attempts is the standard workaround.
		if (existsSync(dest)) rmSync(dest, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		// rename staging → dest
		cpSync(staging, dest, { recursive: true });
		rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		const known: KnownMarketplace = {
			name: catalog.name,
			source,
			path: dest,
			installedAt: new Date().toISOString(),
			...(opts.isDefault ? { isDefault: true } : {}),
		};
		const all = readKnownMarketplaces(paths);
		all[catalog.name] = known;
		writeKnownMarketplaces(paths, all);
		return known;
	} catch (error) {
		if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
		throw error;
	}
}

/**
 * Drop a catalog, its install tree, and matching `installed.json` rows.
 * Returns plugin ids that were removed (for settings cleanup).
 */
export function removeMarketplace(name: string, paths: PluginsPaths = defaultPluginsPaths()): string[] {
	const all = readKnownMarketplaces(paths);
	const entry = all[name];
	if (!entry) throw new Error(`Unknown marketplace "${name}"`);
	if (entry.isDefault) throw new Error(`"${name}" is a default marketplace and can't be removed`);
	delete all[name];
	writeKnownMarketplaces(paths, all);
	if (existsSync(entry.path)) rmSync(entry.path, { recursive: true, force: true });
	const installs = join(installsDir(paths), name);
	if (existsSync(installs)) rmSync(installs, { recursive: true, force: true });

	const meta = readInstallMeta(paths);
	const removedIds: string[] = [];
	for (const id of Object.keys(meta)) {
		const parsed = parsePluginRef(id);
		if (parsed?.marketplace === name) {
			delete meta[id as PluginId];
			removedIds.push(id);
		}
	}
	if (removedIds.length > 0) writeInstallMeta(paths, meta);
	return removedIds;
}

export async function updateMarketplace(
	name: string,
	paths: PluginsPaths = defaultPluginsPaths(),
): Promise<KnownMarketplace> {
	const all = readKnownMarketplaces(paths);
	const entry = all[name];
	if (!entry) throw new Error(`Unknown marketplace "${name}"`);
	if (existsSync(join(entry.path, ".git"))) {
		await runGitAsync(["pull", "--ff-only"], entry.path);
	} else if (entry.source.startsWith("/") || entry.source.startsWith(".")) {
		const abs = resolve(entry.source);
		if (existsSync(abs)) copyLocalPlugin(abs, entry.path);
	} else {
		await cloneOrUpdate(resolveGitUrl(entry.source), entry.path);
	}
	const catalog = loadMarketplaceCatalog(entry.path);
	const updated = { ...entry, name: catalog.name, installedAt: new Date().toISOString() };
	all[name] = updated;
	if (catalog.name !== name) {
		delete all[name];
		all[catalog.name] = updated;
	}
	writeKnownMarketplaces(paths, all);
	return updated;
}

export function getMarketplaceCatalog(name: string, paths: PluginsPaths = defaultPluginsPaths()): MarketplaceCatalog {
	const entry = readKnownMarketplaces(paths)[name];
	if (!entry) throw new Error(`Unknown marketplace "${name}". Add it with /plugin marketplace add <source>`);
	return loadMarketplaceCatalog(entry.path);
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

function installRootFor(paths: PluginsPaths, marketplace: string, plugin: string): string {
	return join(installsDir(paths), marketplace, plugin);
}

async function materializePlugin(
	marketplaceDir: string,
	marketplaceName: string,
	pluginName: string,
	paths: PluginsPaths,
): Promise<string> {
	const { source } = rawPluginSource(marketplaceDir, pluginName);
	const dest = installRootFor(paths, marketplaceName, pluginName);

	if (typeof source === "string") {
		if (source.startsWith("./") || source.startsWith("../")) {
			const src = resolve(marketplaceDir, source);
			copyLocalPlugin(src, dest);
			return dest;
		}
		const url = resolveGitUrl(source);
		await cloneOrUpdate(url, dest);
		return dest;
	}

	const kind = source.source ?? source.type;
	if (kind === "local" || (source.path && !source.url && !source.repo && kind !== "url" && kind !== "git-subdir")) {
		const src = resolve(marketplaceDir, source.path!);
		copyLocalPlugin(src, dest);
		return dest;
	}

	const url = source.url ? source.url : source.repo ? githubUrl(source.repo) : null;
	if (!url) {
		if (source.path) {
			const src = resolve(marketplaceDir, source.path);
			copyLocalPlugin(src, dest);
			return dest;
		}
		throw new Error(`Unsupported plugin source for "${pluginName}"`);
	}

	await cloneOrUpdate(url, dest, source.sha);
	if (source.path) {
		const nested = join(dest, source.path);
		if (!existsSync(nested)) throw new Error(`Plugin subpath missing after clone: ${source.path}`);
		// Expose nested path as the install root via a marker file? Simpler: return nested.
		return nested;
	}
	return dest;
}

/** Record of an installed plugin on disk + settings. */
export interface InstalledPlugin {
	id: PluginId;
	plugin: string;
	marketplace: string;
	root: string;
	enabled: boolean;
	description?: string;
}

function readInstallMeta(paths: PluginsPaths): Record<PluginId, { root: string; description?: string }> {
	const file = join(paths.root, "installed.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf-8")) as Record<PluginId, { root: string; description?: string }>;
	} catch {
		return {};
	}
}

function writeInstallMeta(paths: PluginsPaths, data: Record<PluginId, { root: string; description?: string }>): void {
	mkdirSync(paths.root, { recursive: true });
	writeFileSync(join(paths.root, "installed.json"), JSON.stringify(data, null, 2), "utf-8");
}

export async function installPlugin(
	ref: string,
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): Promise<{ id: PluginId; root: string; description?: string; enabledPlugins: Record<string, boolean> }> {
	const parsed = parsePluginRef(ref);
	if (!parsed) throw new Error(`Invalid plugin ref "${ref}". Use name@marketplace`);
	const { plugin, marketplace } = parsed;
	const mp = readKnownMarketplaces(paths)[marketplace];
	if (!mp) throw new Error(`Unknown marketplace "${marketplace}". Add it with /plugin marketplace add <source>`);

	const catalog = loadMarketplaceCatalog(mp.path);
	const entry = catalog.plugins.find((p) => p.name === plugin);
	if (!entry) {
		throw new Error(`Plugin "${plugin}" not found in "${marketplace}". Try /plugin marketplace list`);
	}

	const root = await materializePlugin(mp.path, marketplace, plugin, paths);
	const id = pluginId(plugin, marketplace);
	const meta = readInstallMeta(paths);
	meta[id] = { root, description: entry.description };
	writeInstallMeta(paths, meta);

	return {
		id,
		root,
		description: entry.description,
		enabledPlugins: { ...(settings.enabledPlugins ?? {}), [id]: true },
	};
}

export function uninstallPlugin(
	ref: string,
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): { id: PluginId; enabledPlugins: Record<string, boolean> } {
	const parsed = parsePluginRef(ref);
	if (!parsed) throw new Error(`Invalid plugin ref "${ref}". Use name@marketplace`);
	const id = pluginId(parsed.plugin, parsed.marketplace);
	const meta = readInstallMeta(paths);
	const record = meta[id];
	if (record) {
		const installBase = installRootFor(paths, parsed.marketplace, parsed.plugin);
		if (existsSync(installBase)) rmSync(installBase, { recursive: true, force: true });
		delete meta[id];
		writeInstallMeta(paths, meta);
	}
	const enabled = { ...(settings.enabledPlugins ?? {}) };
	delete enabled[id];
	return { id, enabledPlugins: enabled };
}

export function setPluginEnabled(
	ref: string,
	enabled: boolean,
	settings: Settings,
): { id: PluginId; enabledPlugins: Record<string, boolean> } {
	const parsed = parsePluginRef(ref);
	if (!parsed) throw new Error(`Invalid plugin ref "${ref}". Use name@marketplace`);
	const id = pluginId(parsed.plugin, parsed.marketplace);
	const next = { ...(settings.enabledPlugins ?? {}), [id]: enabled };
	return { id, enabledPlugins: next };
}

export function listInstalledPlugins(
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): InstalledPlugin[] {
	const meta = readInstallMeta(paths);
	const enabledMap = settings.enabledPlugins ?? {};
	const out: InstalledPlugin[] = [];
	for (const [id, info] of Object.entries(meta)) {
		const parsed = parsePluginRef(id);
		if (!parsed) continue;
		out.push({
			id: id as PluginId,
			plugin: parsed.plugin,
			marketplace: parsed.marketplace,
			root: info.root,
			enabled: enabledMap[id] !== false,
			description: info.description,
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Skill root for one installed plugin (`skills/` when present, else plugin root). */
function pluginSkillRoot(pluginRoot: string): string | null {
	if (!existsSync(pluginRoot)) return null;
	const skillsSub = join(pluginRoot, "skills");
	if (existsSync(skillsSub) && statSync(skillsSub).isDirectory()) return skillsSub;
	return pluginRoot;
}

/**
 * Skill directories contributed by enabled installed plugins.
 * Prefers `<root>/skills` when present, else the plugin root.
 */
export function pluginSkillDirs(settings: Settings, paths: PluginsPaths = defaultPluginsPaths()): string[] {
	return pluginSkillContributions(settings, paths)
		.filter((c) => c.enabled)
		.map((c) => c.dir);
}

/**
 * Skill roots from all installed plugins (enabled and disabled).
 * Disabled packs still appear in `/skills` as locked rows until the pack is re-enabled.
 */
export function pluginSkillContributions(
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): Array<{ dir: string; pluginId: string; enabled: boolean }> {
	const out: Array<{ dir: string; pluginId: string; enabled: boolean }> = [];
	for (const plugin of listInstalledPlugins(settings, paths)) {
		const dir = pluginSkillRoot(plugin.root);
		if (!dir) continue;
		out.push({ dir, pluginId: plugin.id, enabled: plugin.enabled });
	}
	return out;
}

/**
 * `<root>/hooks/hooks.json` when present — Claude Code's real convention for
 * plugin-contributed hooks (verified against installed marketplace plugins,
 * e.g. anthropics/claude-plugins-official's "hookify", "ralph-loop", …).
 * Falls back to a bare `<root>/hooks.json` for a plugin authored against
 * cast's own docs before this was corrected.
 */
function pluginHookFile(pluginRoot: string): string | null {
	const nested = join(pluginRoot, "hooks", "hooks.json");
	if (existsSync(nested)) return nested;
	const flat = join(pluginRoot, "hooks.json");
	return existsSync(flat) ? flat : null;
}

/**
 * `hooks.json` paths (with their plugin's install root, for CAST_PLUGIN_ROOT)
 * from enabled installed plugins, for merging into the hook config the same
 * way `pluginSkillDirs` feeds skill discovery.
 */
export function pluginHookFiles(
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): Array<{ path: string; pluginRoot: string; pluginId: string }> {
	const out: Array<{ path: string; pluginRoot: string; pluginId: string }> = [];
	for (const plugin of listInstalledPlugins(settings, paths)) {
		if (!plugin.enabled) continue;
		const file = pluginHookFile(plugin.root);
		if (file)
			out.push({ path: file, pluginRoot: plugin.root, pluginId: pluginId(plugin.plugin, plugin.marketplace) });
	}
	return out;
}

/** List plugin names in a known marketplace (for /plugin marketplace list detail). */
export function listMarketplacePlugins(
	name: string,
	paths: PluginsPaths = defaultPluginsPaths(),
): MarketplacePluginEntry[] {
	return getMarketplaceCatalog(name, paths).plugins;
}

/** Discover marketplace dirs on disk that aren't in known_marketplaces (repair). */
export function scanMarketplaceDirs(paths: PluginsPaths = defaultPluginsPaths()): string[] {
	const dir = marketplacesDir(paths);
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((n) => !n.startsWith("."))
		.map((n) => join(dir, n))
		.filter((p) => findMarketplaceManifest(p));
}
