/**
 * User settings persistence.
 * Saved to ~/.cast/settings.json
 * Loaded on startup, saved after model/reasoning changes.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReasoningFormat } from "./vendors.ts";

// ============================================================================
// Settings schema
// ============================================================================

export type PermissionMode = "default" | "bypass";

export interface StatusBarConfig {
	visible: string[];
	order: string[];
	sides: Record<string, "left" | "right">;
}

export interface Provider {
	name: string;
	url: string;
	apiKey: string;
	/** Reasoning request dialect. `auto` is safe for ordinary OpenAI-compatible endpoints. */
	reasoningFormat?: ReasoningFormat;
}

export interface Settings {
	/** Last used model */
	model?: string;
	/** Provider name for the main model (falls back to active provider if unset). */
	modelProvider?: string;
	/** Model used for subagents (falls back to model if unset). */
	subagentModel?: string;
	/** Provider name for the subagent model (falls back to active provider if unset). */
	subagentModelProvider?: string;
	/** Model used while plan mode is active (falls back to model if unset) —
	 * lets planning run on a stronger model than day-to-day building. */
	planModel?: string;
	/** Provider name for the plan model (falls back to active provider if unset). */
	planModelProvider?: string;
	/** Last used reasoning level */
	reasoningLevel?: string;
	/** Last used persona name (see personas.ts) — defaults to DEFAULT_PERSONA when unset. */
	persona?: string;
	/** Last used provider URL */
	providerUrl?: string;
	/** Last used provider API key */
	apiKey?: string;
	/** Saved providers for quick switching via /provider. */
	providers?: Provider[];
	/** Last working directory */
	cwd?: string;
	/**
	 * "bypass" skips the confirmation prompt for bash commands that match a
	 * known-dangerous pattern (rm -rf, sudo, force-push, ...). Defaults to
	 * "default" (gated) when unset. Set via `/permissions bypass`, which
	 * requires typing "yes" after a warning first.
	 */
	permissionMode?: PermissionMode;
	/**
	 * Per-project trust decision, keyed by absolute project path. A single
	 * flag gates all project-local resources: skills (.cast/skills/),
	 * MCP servers (.cast/mcp.json), and context files (AGENTS.md,
	 * CLAUDE.md). Asked once per project, remembered in settings.json.
	 * Global resources (~/.cast/) need no trust check.
	 */
	projectTrust?: Record<string, boolean>;
	/** Updated automatically on each run */
	updatedAt?: string;
	/** Active color theme id (see src/ui/themes/registry.ts). */
	theme?: string;
	/** When false, web_search and web_fetch tools are not advertised to the model. */
	webTools?: boolean;
	/**
	 * Search backend for web_search. "ddg" (default when unset) scrapes
	 * DuckDuckGo's HTML endpoint — free, no key, but rate-limited to ~4
	 * requests per IP before a CAPTCHA blocks further scraping. "tavily"
	 * uses the Tavily Search API (needs `tavilyApiKey`) — a generous,
	 * recurring free tier (1000 requests/month) instead of a hard per-IP cap.
	 * "brave" uses the Brave Search API (needs `braveApiKey`) — an actual
	 * general web index (not an AI-search aggregator like Tavily), free tier
	 * varies by plan/region.
	 */
	searchProvider?: "ddg" | "tavily" | "brave";
	/** Tavily API key — required when searchProvider is "tavily". Get one at https://app.tavily.com */
	tavilyApiKey?: string;
	/** Brave Search API key — required when searchProvider is "brave". Get one at https://api-dashboard.search.brave.com */
	braveApiKey?: string;
	/**
	 * web_fetch backend. "jina" (default) proxies through Jina Reader
	 * (r.jina.ai) — no key, handles JS-rendered pages, always returns markdown.
	 * "local" fetches the URL directly from this process (no third party sees
	 * the URL) and converts HTML to the requested format itself — same
	 * approach as opencode's webfetch tool: a Cloudflare-challenge retry with
	 * a plain User-Agent, a 5MB response cap, and a content-type check that
	 * rejects images/binaries instead of returning them as "text".
	 */
	webFetchProvider?: "jina" | "local";
	/** MCP server names the user has disabled via /mcp toggle. Persisted so
	 * they stay disabled across sessions and /reload. */
	disabledMcpServers?: string[];
	/** Skill names disabled via /skills toggle. Still discovered for the picker;
	 * omitted from the agent catalog and /skill: invocation until re-enabled. */
	disabledSkills?: string[];
	/** Hook group ids (see hookGroupId in hooks.ts) disabled via /hooks toggle.
	 * A group's id is content-derived, so it survives edits to unrelated hooks
	 * in the same file. */
	disabledHooks?: string[];
	/**
	 * Installed marketplace plugins keyed by `name@marketplace`.
	 * `true`/absent-after-install = enabled; `false` = installed but disabled.
	 * Package lives under ~/.cast/plugins/; see plugins.ts.
	 */
	enabledPlugins?: Record<string, boolean>;
	/** Status bar segment configuration: which are visible, order, and sides. */
	statusBar?: StatusBarConfig;
	/** @deprecated Agent mode moved to SessionState.mode — the mode is per-task
	 * session state, and storing it globally leaked plan mode across projects.
	 * Kept only so old settings.json files still parse. */
	mode?: "plan" | "build";
	/** Web UI password — auto-generated on first `cast server` run. */
	serverToken?: string;
	/** @deprecated Server password, renamed to serverToken. Read as a fallback
	 * so existing settings.json files keep working; migrated on load. */
	webPassword?: string;
	/**
	 * Persona used by the web UI's "Quick session" button — skips the persona
	 * picker entirely and opens straight into a fresh sandbox directory.
	 * Defaults to DEFAULT_PERSONA (core/personas.ts) when unset.
	 */
	quickSessionPersona?: string;
	/**
	 * Whether to show reasoning blocks in the transcript. Defaults to false
	 * (reasoning models stream a lot of auxiliary thinking that clutters the
	 * view). Toggled via /reasoning-display (/rd) and persisted so the
	 * preference survives restarts.
	 */
	showReasoning?: boolean;
	/** Whether durable project memory is active across TUI and Web UI. */
	memoryEnabled?: boolean;
	/** Whether background memory extraction, checkpoint writing, and maintenance may write. */
	memoryWriteEnabled?: boolean;
	/** Maximum estimated tokens reserved for automatically injected memory context. */
	memoryPromptBudget?: number;
	/** Relative BM25 score floor for dropping weak common-word matches. */
	memorySearchScoreFloor?: number;
	/** Reconcile project memory files before search operations. */
	memoryReconcileOnSearch?: boolean;
	/** Index Claude Code memory files (~/.claude/projects/<slug>/memory) into search. */
	memoryCcIndex?: boolean;
	/** Automatically consolidate project memory when a new top-level session starts. */
	memoryDreamAuto?: boolean;
	/** Minimum days between automatic dream runs (default: 7; 0 runs every new session). */
	memoryDreamIntervalDays?: number;
	/** Automatically package repeated workflows when a new top-level session starts. */
	memoryDistillAuto?: boolean;
	/** Minimum days between automatic distill runs (default: 30; 0 runs every new session). */
	memoryDistillIntervalDays?: number;
	/** Use the parent's full prompt prefix for checkpoint writers; false uses only the post-checkpoint delta. */
	checkpointFork?: boolean;
	/** Checkpoint writer trigger points as percentages of the context window (MiMo-style ladder). */
	checkpointThresholds?: number[];
}

// ============================================================================
// File management
// ============================================================================

const SETTINGS_DIR = ".cast";
const SETTINGS_FILE = "settings.json";
const SETTINGS_LOCK_WAIT_MS = 5_000;
const SETTINGS_LOCK_STALE_MS = 30_000;

function getSettingsPath(): string {
	return join(homedir(), SETTINGS_DIR, SETTINGS_FILE);
}

function withSettingsLock<T>(work: () => T): T {
	const lockPath = `${getSettingsPath()}.lock`;
	mkdirSync(join(homedir(), SETTINGS_DIR), { recursive: true });
	const wait = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + SETTINGS_LOCK_WAIT_MS;
	let acquired = false;
	while (!acquired) {
		try {
			const fd = openSync(lockPath, "wx");
			closeSync(fd);
			acquired = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > SETTINGS_LOCK_STALE_MS) unlinkSync(lockPath);
			} catch {
				// Another process may have released or replaced the lock between stat and unlink.
			}
			if (Date.now() >= deadline) throw new Error("Timed out waiting for settings lock");
			Atomics.wait(wait, 0, 0, 10);
		}
	}
	try {
		return work();
	} finally {
		try {
			unlinkSync(lockPath);
		} catch {
			// The stale-lock recovery path may already have removed this lock.
		}
	}
}

export function loadSettings(): Settings {
	const path = getSettingsPath();
	if (!existsSync(path)) return {};

	try {
		const s = JSON.parse(readFileSync(path, "utf-8")) as Settings;
		return migrateSettings(s);
	} catch {
		return {};
	}
}

/**
 * One-time migrations applied on every load (idempotent — each only acts on
 * the legacy shape it targets).
 */
function migrateSettings(s: Settings): Settings {
	let next = s;
	// `providers` missing/empty but `providerUrl` + `apiKey` exist (legacy
	// single-provider settings): populate `providers` so `/provider` can list
	// and switch from the start.
	if (!next.providers?.length && next.providerUrl && next.apiKey) {
		next = { ...next, providers: [{ name: "default", url: next.providerUrl, apiKey: next.apiKey }] };
	}
	// Older provider switching wrote the active URL/key without updating the
	// main model's provider name. Prefer the matching saved row so startup does
	// not route a model through a stale provider after that upgrade.
	if (next.providerUrl && next.apiKey && next.providers?.length) {
		const active = next.providers.find((p) => p.url === next.providerUrl && p.apiKey === next.apiKey);
		if (active && next.modelProvider && next.modelProvider !== active.name) {
			next = { ...next, modelProvider: active.name };
		}
	}
	// `webPassword` → `serverToken` (renamed with the daemon command). Read the
	// old key so existing settings keep working; promote it to the new name on
	// load. Returning the migrated object means the in-memory copy (and the
	// next updateSettings) writes the new key.
	if (!next.serverToken && next.webPassword) {
		next = { ...next, serverToken: next.webPassword };
	}
	return next;
}

function saveSettings(settings: Settings): void {
	const dir = join(homedir(), SETTINGS_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const path = getSettingsPath();
	const merged = { ...settings, updatedAt: new Date().toISOString() };
	// Write to a temp file then rename over the target — rename is atomic within
	// a filesystem, so a crash mid-write can't truncate settings.json (loadSettings
	// falls back to {} on a parse error, silently losing the user's config).
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, path);
}

export function updateSettings(partial: Partial<Settings> | ((current: Settings) => Partial<Settings>)): void {
	withSettingsLock(() => {
		const current = loadSettings();
		const update = typeof partial === "function" ? partial(current) : partial;
		saveSettings({ ...current, ...update });
	});
}

/** Existing settings remain enabled; only an explicit false disables memory. */
export function isMemoryEnabled(settings: Settings = loadSettings()): boolean {
	return settings.memoryEnabled !== false;
}

export function isMemoryWriteEnabled(settings: Settings = loadSettings()): boolean {
	return isMemoryEnabled(settings) && settings.memoryWriteEnabled !== false;
}

export function memoryPromptBudget(settings: Settings = loadSettings()): number {
	const value = settings.memoryPromptBudget;
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(256, Math.min(Math.round(value), 16_384))
		: 4_096;
}

export function memorySearchScoreFloor(settings: Settings = loadSettings()): number {
	const value = settings.memorySearchScoreFloor;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(value, 1)) : 0.15;
}

export function memoryReconcileOnSearch(settings: Settings = loadSettings()): boolean {
	return settings.memoryReconcileOnSearch !== false;
}

export function memoryCcIndex(settings: Settings = loadSettings()): boolean {
	return settings.memoryCcIndex === true;
}

export function memoryDreamAuto(settings: Settings = loadSettings()): boolean {
	return settings.memoryDreamAuto === true;
}

export function memoryDreamIntervalDays(settings: Settings = loadSettings()): number {
	const value = settings.memoryDreamIntervalDays;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), 3_650)) : 7;
}

export function memoryDistillAuto(settings: Settings = loadSettings()): boolean {
	return settings.memoryDistillAuto === true;
}

export function memoryDistillIntervalDays(settings: Settings = loadSettings()): number {
	const value = settings.memoryDistillIntervalDays;
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), 3_650)) : 30;
}

export function checkpointFork(settings: Settings = loadSettings()): boolean {
	return settings.checkpointFork === true;
}

export function checkpointThresholdsSetting(settings: Settings = loadSettings()): number[] | undefined {
	const value = settings.checkpointThresholds;
	if (!Array.isArray(value)) return undefined;
	const valid = value.filter(
		(entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0 && entry <= 100,
	);
	if (valid.length === 0) return undefined;
	return [...new Set(valid)].sort((a, b) => a - b);
}

/** true/false if this project's trust decision was already made, undefined if never asked. */
export function getProjectTrust(settings: Settings, projectPath: string): boolean | undefined {
	return settings.projectTrust?.[projectPath];
}

export function setProjectTrust(projectPath: string, trusted: boolean): void {
	const current = loadSettings();
	updateSettings({ projectTrust: { ...current.projectTrust, [projectPath]: trusted } });
}
