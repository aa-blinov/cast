/**
 * Plugin marketplaces — Grok/Claude-shaped install for cast.
 *
 * Catalog sources live in ~/.cast/plugins/known_marketplaces.json.
 * Marketplace checkouts: ~/.cast/plugins/marketplaces/<name>/
 * Remote plugin checkouts: ~/.cast/plugins/installs/<marketplace>/<plugin>/
 *
 * UX: `/plugin install name@marketplace` (same shape as Claude/Grok).
 * MVP loads skills from installed plugins; MCP/hooks/agents can come later.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Settings } from "./settings.ts";

const MARKETPLACE_MANIFESTS = [
	".cast-plugin/marketplace.json",
	".grok-plugin/marketplace.json",
	".claude-plugin/marketplace.json",
	".agents/plugins/marketplace.json", // Codex
] as const;

/**
 * Bundled default catalogs (Codex / Claude / Grok). Seeded once into
 * ~/.cast/plugins on first plugin command — not on every startup, so offline
 * launches stay fast. Users can `/plugin marketplace remove` any of them;
 * we do not re-add after a successful seed.
 */
export const DEFAULT_MARKETPLACE_SOURCES: ReadonlyArray<{ source: string; label: string }> = [
	{ source: "openai/plugins", label: "codex" },
	{ source: "anthropics/claude-plugins-official", label: "claude" },
	{ source: "xai-org/plugin-marketplace", label: "grok" },
];

function defaultsSeedPath(paths: PluginsPaths): string {
	return join(paths.root, "defaults-seeded.json");
}

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
	/** True when this call performed the one-shot seed (success or permanent skip). */
	seeded: boolean;
}

/**
 * Clone + register the default Codex/Claude/Grok marketplaces if we have not
 * seeded before. Retries on the next call when every source failed (typical:
 * no network on first run). Partial success still writes the flag so we do not
 * re-clone on every `/plugin` — failed sources can be added manually.
 */
export function ensureDefaultMarketplaces(
	paths: PluginsPaths = defaultPluginsPaths(),
	sources: ReadonlyArray<{ source: string; label: string }> = DEFAULT_MARKETPLACE_SOURCES,
): EnsureDefaultsResult {
	const flag = defaultsSeedPath(paths);
	if (existsSync(flag)) {
		return { added: [], errors: [], seeded: false };
	}

	mkdirSync(paths.root, { recursive: true });
	const knownSources = new Set(Object.values(readKnownMarketplaces(paths)).map((k) => normalizeSourceKey(k.source)));
	const added: string[] = [];
	const errors: string[] = [];

	for (const { source, label } of sources) {
		const key = normalizeSourceKey(source);
		if (knownSources.has(key)) continue;
		try {
			const mp = addMarketplace(source, paths);
			knownSources.add(key);
			knownSources.add(normalizeSourceKey(mp.source));
			added.push(`${mp.name} (${label})`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`${label} (${source}): ${message}`);
		}
	}

	const afterKeys = new Set(Object.values(readKnownMarketplaces(paths)).map((k) => normalizeSourceKey(k.source)));
	const allPresent = sources.every((s) => afterKeys.has(normalizeSourceKey(s.source)));
	if (!allPresent && added.length === 0) {
		return { added, errors, seeded: false };
	}

	writeFileSync(
		flag,
		JSON.stringify(
			{
				seededAt: new Date().toISOString(),
				sources: sources.map((s) => s.source),
				added,
				errors,
			},
			null,
			2,
		),
		"utf-8",
	);
	return { added, errors, seeded: true };
}

function normalizeSourceKey(source: string): string {
	return source
		.trim()
		.replace(/\.git$/i, "")
		.replace(/^https?:\/\/github\.com\//i, "")
		.replace(/^git@github\.com:/i, "")
		.toLowerCase();
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
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) return githubUrl(source);
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
	const last = source.split(/[/\\]/).filter(Boolean).pop() ?? "";
	const cleaned = last.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "-");
	return cleaned || "marketplace";
}

function runGit(args: string[], cwd?: string): string {
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

function cloneOrUpdate(url: string, dest: string, sha?: string): void {
	mkdirSync(join(dest, ".."), { recursive: true });
	if (existsSync(join(dest, ".git"))) {
		runGit(["fetch", "--depth", "1", "origin", sha ?? "HEAD"], dest);
		if (sha) {
			runGit(["checkout", "--force", sha], dest);
		} else {
			runGit(["pull", "--ff-only"], dest);
		}
		return;
	}
	if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
	if (sha) {
		runGit(["clone", "--filter=blob:none", url, dest]);
		runGit(["fetch", "--depth", "1", "origin", sha], dest);
		runGit(["checkout", "--force", sha], dest);
	} else {
		runGit(["clone", "--depth", "1", url, dest]);
	}
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

export function addMarketplace(source: string, paths: PluginsPaths = defaultPluginsPaths()): KnownMarketplace {
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
		runGit(["clone", "--depth", "1", url, staging]);
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

export function updateMarketplace(name: string, paths: PluginsPaths = defaultPluginsPaths()): KnownMarketplace {
	const all = readKnownMarketplaces(paths);
	const entry = all[name];
	if (!entry) throw new Error(`Unknown marketplace "${name}"`);
	if (existsSync(join(entry.path, ".git"))) {
		runGit(["pull", "--ff-only"], entry.path);
	} else if (entry.source.startsWith("/") || entry.source.startsWith(".")) {
		const abs = resolve(entry.source);
		if (existsSync(abs)) copyLocalPlugin(abs, entry.path);
	} else {
		cloneOrUpdate(resolveGitUrl(entry.source), entry.path);
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

function materializePlugin(
	marketplaceDir: string,
	marketplaceName: string,
	pluginName: string,
	paths: PluginsPaths,
): string {
	const { source } = rawPluginSource(marketplaceDir, pluginName);
	const dest = installRootFor(paths, marketplaceName, pluginName);

	if (typeof source === "string") {
		if (source.startsWith("./") || source.startsWith("../")) {
			const src = resolve(marketplaceDir, source);
			copyLocalPlugin(src, dest);
			return dest;
		}
		const url = resolveGitUrl(source);
		cloneOrUpdate(url, dest);
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

	cloneOrUpdate(url, dest, source.sha);
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

export function installPlugin(
	ref: string,
	settings: Settings,
	paths: PluginsPaths = defaultPluginsPaths(),
): { id: PluginId; root: string; description?: string; enabledPlugins: Record<string, boolean> } {
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

	const root = materializePlugin(mp.path, marketplace, plugin, paths);
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
