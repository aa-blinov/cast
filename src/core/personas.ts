/**
 * Personas — swappable agent definitions: system prompt plus optional
 * capability knobs from frontmatter (`tools`, `agentsMd`, `subagents`).
 * When `tools` is omitted all builtins are available; when set, only listed
 * builtin names are advertised and executable (MCP tools are unaffected).
 *
 * Personas are loaded from three sources (highest priority first):
 *   1. Project:  <cwd>/.cast/personas/*.md  (trust-gated, like skills)
 *   2. Global:   ~/.cast/personas/*.md       (always loaded)
 *   3. Builtin:  prompts/personas/*.md       (ships with cast)
 *
 * Frontmatter: name, label, description, subagents, tools, agentsMd.
 * Only one persona is active at a time; its body becomes the system prompt.
 * Shared error-handling + file-tool guidance is appended via
 * `withSharedToolPrompt` (same append used for subagents).
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAgentsMd, parseFrontmatter, parseToolsAllowlist } from "./frontmatter.ts";
import { promptsDir, withSharedToolPrompt } from "./prompts.ts";

export type PersonaSource = "builtin" | "global" | "project";

export interface Persona {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
	source: PersonaSource;
	/** Absolute path to the .md file this persona was loaded from. */
	filePath: string;
	/** Whether this persona can use the `task` tool to delegate to sub-agents. Defaults to false. */
	subagents: boolean;
	/**
	 * Optional allowlist for built-in tools from frontmatter
	 * (`tools: [read, grep, plan_*, web_*]`). Exact names or `*`-globs.
	 * `undefined` = all builtins; when set, only matching builtin names are
	 * advertised and executable. Connected MCP tools are never filtered here.
	 */
	tools?: string[];
	/**
	 * Whether to inject AGENTS.md / CLAUDE.md into the system prompt.
	 * Defaults to true; set `agentsMd: false` in frontmatter to disable.
	 */
	agentsMd: boolean;
}

export const DEFAULT_PERSONA = "coding";

export const globalPersonasDir = join(homedir(), ".cast", "personas");

const PROMPTS_DIR = promptsDir;

// Shared error-handling + file-tool / hashline guidance is appended via
// `withSharedToolPrompt` so personas and subagents stay on the same contract.

/**
 * Read fresh from prompts/fallback-persona.md, a sibling of prompts/personas/
 * rather than a file inside it — this only ever gets used when
 * prompts/personas/ itself fails to read (a broken/partial install), so it
 * can't rely on anything under that specific directory, but a sibling file
 * is unaffected by that failure and reads fine. If prompts/ itself is gone
 * (a much more broken install than what triggers this path at all), the
 * hardcoded literal below is the true last resort.
 */
function readFallbackPersonaPrompt(): string {
	try {
		return readFileSync(join(PROMPTS_DIR, "fallback-persona.md"), "utf-8").trim();
	} catch {
		return "You are a helpful coding assistant.";
	}
}

const FALLBACK_PERSONA: Persona = {
	name: DEFAULT_PERSONA,
	label: "Coding agent",
	description: "Default persona.",
	systemPrompt: withSharedToolPrompt(readFallbackPersonaPrompt()),
	source: "builtin",
	filePath: "",
	subagents: false,
	agentsMd: true,
};

function builtinPersonasDir(): string {
	return join(PROMPTS_DIR, "personas");
}

function loadPersonaFromFile(filePath: string, source: PersonaSource): Persona | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter(raw);
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : undefined;
	if (!name) return null;

	return {
		name,
		label: typeof frontmatter.label === "string" && frontmatter.label ? frontmatter.label : name,
		description: typeof frontmatter.description === "string" ? frontmatter.description : "",
		systemPrompt: withSharedToolPrompt(body),
		source,
		filePath,
		subagents: frontmatter.subagents === true,
		tools: parseToolsAllowlist(frontmatter),
		agentsMd: parseAgentsMd(frontmatter),
	};
}

/**
 * Load all .md personas from a directory, returning them sorted by label.
 * Silently returns an empty array if the directory doesn't exist.
 */
function loadPersonasFromDir(dir: string, source: PersonaSource): Persona[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files
		.map((f) => loadPersonaFromFile(join(dir, f), source))
		.filter((p): p is Persona => p !== null)
		.sort((a, b) => a.label.localeCompare(b.label));
}

export interface LoadPersonasOptions {
	/** `prompts/personas/` — the shipped built-in personas. */
	builtinDir?: string;
	/** `~/.cast/personas/` — always loaded. */
	globalDir?: string;
	/** `<cwd>/.cast/personas/` — omit if project isn't trusted or dir missing. */
	projectDir?: string;
}

/**
 * Load and merge personas from all configured sources. On a name collision
 * the first-loaded persona wins (project, then global, then builtin) —
 * matches the skills collision policy.
 */
export function loadPersonas(options: LoadPersonasOptions = {}): Persona[] {
	const builtinDir = options.builtinDir ?? builtinPersonasDir();
	const personaMap = new Map<string, Persona>();

	// Highest priority first: project > global > builtin.
	const sources: { dir: string | undefined; source: PersonaSource }[] = [
		{ dir: options.projectDir, source: "project" },
		{ dir: options.globalDir, source: "global" },
		{ dir: builtinDir, source: "builtin" },
	];

	for (const { dir, source } of sources) {
		if (!dir) continue;
		for (const persona of loadPersonasFromDir(dir, source)) {
			if (!personaMap.has(persona.name)) personaMap.set(persona.name, persona);
		}
	}

	const personas = Array.from(personaMap.values());
	// Sort with DEFAULT_PERSONA first, then alphabetically by label (what the user sees).
	personas.sort((a, b) =>
		a.name === DEFAULT_PERSONA ? -1 : b.name === DEFAULT_PERSONA ? 1 : a.label.localeCompare(b.label),
	);
	return personas.length > 0 ? personas : [FALLBACK_PERSONA];
}

/**
 * Convenience wrapper: load all personas and find one by name.
 * Callers that already have the list should use .find() instead.
 */
export function findPersona(name: string, options?: LoadPersonasOptions): Persona | undefined {
	return loadPersonas(options).find((p) => p.name === name);
}

/** Backward-compatible convenience: load all personas from all sources. */
export function listPersonas(options?: LoadPersonasOptions): Persona[] {
	return loadPersonas(options);
}
