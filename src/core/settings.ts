/**
 * User settings persistence.
 * Saved to ~/.cast/settings.json
 * Loaded on startup, saved after model/reasoning changes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
	/** Web UI password — auto-generated on first `cast web` run. */
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
}

// ============================================================================
// File management
// ============================================================================

const SETTINGS_DIR = ".cast";
const SETTINGS_FILE = "settings.json";

function getSettingsPath(): string {
	return join(homedir(), SETTINGS_DIR, SETTINGS_FILE);
}

export function loadSettings(): Settings {
	const path = getSettingsPath();
	if (!existsSync(path)) return {};

	try {
		const s = JSON.parse(readFileSync(path, "utf-8")) as Settings;
		return migrateProviders(s);
	} catch {
		return {};
	}
}

/**
 * One-time migration: if `providers` is missing/empty but `providerUrl` +
 * `apiKey` exist (legacy single-provider settings), populate `providers`
 * so `/provider` can list and switch from the start.
 */
function migrateProviders(s: Settings): Settings {
	if (s.providers?.length) return s;
	if (s.providerUrl && s.apiKey) {
		return { ...s, providers: [{ name: "default", url: s.providerUrl, apiKey: s.apiKey }] };
	}
	return s;
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

export function updateSettings(partial: Partial<Settings>): void {
	const current = loadSettings();
	saveSettings({ ...current, ...partial });
}

/** true/false if this project's trust decision was already made, undefined if never asked. */
export function getProjectTrust(settings: Settings, projectPath: string): boolean | undefined {
	return settings.projectTrust?.[projectPath];
}

export function setProjectTrust(projectPath: string, trusted: boolean): void {
	const current = loadSettings();
	updateSettings({ projectTrust: { ...current.projectTrust, [projectPath]: trusted } });
}
