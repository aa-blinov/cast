/**
 * Agent Skills (https://agentskills.io/specification) — self-contained
 * capability packages the agent loads on demand. Mirrors pi's implementation
 * (packages/coding-agent/src/core/skills.ts in the pi-mono monorepo):
 * directories with a SKILL.md (frontmatter + instructions), discovered from
 * a global dir, a project dir, and explicit --skill paths, then summarized
 * into the system prompt so the model knows what's available without paying
 * for the full content until it actually reads one.
 *
 * Frontmatter is parsed by the shared YAML parser in frontmatter.ts.
 */

import { execFile } from "node:child_process";
import { type Dirent, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { matchesToolsAllowlist, parseFrontmatter } from "./frontmatter.ts";
import { coerceHooksObject, type HooksFile } from "./hooks.ts";
import { checkDangerousBash } from "./permissions.ts";
import { checkReadOnlyCommand } from "./plan.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";
import { fileMatchesGlob } from "./rules.ts";

const SLUG_RE = /^[a-z0-9-]+$/;

const execFileAsync = promisify(execFile);
const LIST_SPLIT_RE = /[\s,]+/;
const ARGUMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAGRAPH_SPLIT_RE = /\n\s*\n/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
/** Spec: the combined `description` + `when_to_use` text is truncated at this
 * length in the skill listing, to bound what every turn pays for skills it
 * may never use. Only `description` was capped, so a long `when_to_use` rode
 * into the system prompt uncapped. */
const MAX_LISTING_DESCRIPTION_LENGTH = 1536;
const MAX_COMPATIBILITY_LENGTH = 500;
const RECOMMENDED_MAX_BODY_LINES = 500;

// Instructions injected into the system prompt alongside the discovered
// skill list — content, not code, so it lives in prompts/ with the other
// prompt files instead of as inline strings here.
const SKILLS_INSTRUCTIONS = readRequiredPrompt(promptsDir, "skills-instructions.md");

export const builtinSkillsDir = join(promptsDir, "skills");

export type SkillSource = "builtin" | "global" | "project" | "agents" | "plugin" | "path";

export interface Skill {
	name: string;
	description: string;
	/** Extended description for model matching — shown alongside description in the skill listing. */
	whenToUse?: string;
	/** Optional Agent Skills metadata retained for clients and skill UIs. */
	license?: string;
	compatibility?: string;
	metadata?: Record<string, string>;
	/** Experimental Agent Skills field; its permission semantics are client-specific. */
	allowedTools?: string;
	filePath: string;
	/** Directory containing the skill file — relative paths inside it resolve against this. */
	baseDir: string;
	source: SkillSource;
	disableModelInvocation: boolean;
	/** False when only the model may invoke this skill — it stays out of the
	 * slash-command menu and `/name` does not run it. Spec field
	 * `user-invocable`; default true. */
	userInvocable: boolean;
	/** Hooks the skill registers when invoked, in hooks.json's shape. */
	hooks?: HooksFile;
	/** Glob patterns limiting when the skill is offered: it is listed only
	 * while a file matching one of them is in context (`paths`). */
	paths?: string[];
	/** Tools removed from the model's pool while this skill is active
	 * (`disallowed-tools`), space-separated. */
	disallowedTools?: string;
	/** Autocomplete hint for the arguments this skill expects (`argument-hint`). */
	argumentHint?: string;
	/** Named positional arguments (`arguments`), mapped to `$name` placeholders
	 * in body order. */
	argumentNames?: string[];
	/** Marketplace plugin id (`name@marketplace`) when `source === "plugin"`. */
	pluginId?: string;
	/** False when the contributing plugin pack is disabled via `/plugin`. */
	pluginEnabled?: boolean;
	/**
	 * Cached skill body (frontmatter stripped) — read once at discovery time so
	 * `/skill:name` and the skill tool don't I/O on every invocation. Stale
	 * only if the file changes on disk between discoveries; `/reload`
	 * re-discovers and naturally invalidates.
	 */
	body?: string;
}

/** One plugin pack's skill root for `loadSkills`. */
export interface PluginSkillContribution {
	dir: string;
	pluginId: string;
	enabled: boolean;
}

export interface SkillDiagnostic {
	message: string;
	path: string;
}

/**
 * Read a skill's body (frontmatter stripped) — uses the cached body if it was
 * loaded by `loadSkillFromFile`, falls back to a disk read for legacy callers.
 * `/reload` re-discovers skills, so a stale cache is naturally invalidated.
 */
function readSkillBody(skill: Skill): string {
	return skill.body ?? parseFrontmatter(readFileSync(skill.filePath, "utf-8")).body;
}

/** User-managed skills that `/skills uninstall` may delete (not builtin/plugin/--skill). */
export function isUninstallableSkill(skill: Skill): boolean {
	return skill.source === "global" || skill.source === "project" || skill.source === "agents";
}

/**
 * Delete a global/project Agent Skills package from disk.
 */
export function uninstallUserSkill(skill: Skill): void {
	if (!isUninstallableSkill(skill)) {
		throw new Error(`Cannot uninstall ${skill.source} skill "${skill.name}"`);
	}
	if (!existsSync(skill.filePath)) {
		throw new Error(`Skill file missing: ${skill.filePath}`);
	}
	rmSync(skill.baseDir, { recursive: true, force: true });
}

// ============================================================================
// Validation — required Agent Skills fields must be valid before the package
// reaches the model. A malformed skill is unsafe to guess at because its
// name is part of the dispatch protocol.
// ============================================================================

function validateSkillName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!SLUG_RE.test(name)) errors.push("name must be lowercase a-z, 0-9, hyphens only");
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateSkillDescription(description: string | undefined): string[] {
	if (!description || description.trim() === "") return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters`];
	return [];
}

function validateOptionalString(
	frontmatter: Record<string, unknown>,
	field: string,
	maxLength?: number,
): { value: string | undefined; errors: string[] } {
	const raw = frontmatter[field];
	if (raw === undefined) return { value: undefined, errors: [] };
	if (typeof raw !== "string" || raw.trim() === "")
		return { value: undefined, errors: [`${field} must be a non-empty string`] };
	if (maxLength !== undefined && raw.length > maxLength) {
		return { value: undefined, errors: [`${field} exceeds ${maxLength} characters (${raw.length})`] };
	}
	return { value: raw, errors: [] };
}

/**
 * `allowed-tools` per spec: "a space- or comma-separated string, or a YAML
 * list". Only the string form was accepted, so the list form — which is what
 * a multi-tool grant is usually written as — was reported as invalid and took
 * the whole skill down with it.
 */
function validateToolList(
	frontmatter: Record<string, unknown>,
	field: string,
): { value: string | undefined; errors: string[] } {
	const raw = frontmatter[field];
	if (raw === undefined) return { value: undefined, errors: [] };
	if (Array.isArray(raw)) {
		const entries = raw.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
		if (entries.length !== raw.length) {
			return { value: undefined, errors: [`${field} list entries must be non-empty strings`] };
		}
		return { value: entries.join(" "), errors: [] };
	}
	return validateOptionalString(frontmatter, field);
}

/**
 * Booleans in skill frontmatter accept `yes`/`no`/`on`/`off`/`1`/`0` in any
 * case as well as `true`/`false`. Only a literal `true` counted before, so a
 * skill marked `disable-model-invocation: yes` — the author saying "only the
 * user may run this" — stayed model-invocable.
 */
function parseSpecBoolean(value: unknown, fallback = false): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value === 1;
	if (typeof value !== "string") return fallback;
	const text = value.trim().toLowerCase();
	if (["true", "yes", "on", "1"].includes(text)) return true;
	if (["false", "no", "off", "0"].includes(text)) return false;
	return fallback;
}

/** `paths` per spec: "a comma-separated string or a YAML list" of globs. */
function validateGlobList(
	frontmatter: Record<string, unknown>,
	field: string,
): { value: string[] | undefined; errors: string[] } {
	const raw = frontmatter[field];
	if (raw === undefined) return { value: undefined, errors: [] };
	const entries = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(LIST_SPLIT_RE).filter(Boolean)
			: undefined;
	if (!entries) return { value: undefined, errors: [`${field} must be a comma-separated string or a YAML list`] };
	const globs = entries.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
	if (globs.length !== entries.length) {
		return { value: undefined, errors: [`${field} entries must be non-empty glob strings`] };
	}
	return { value: globs.length > 0 ? globs : undefined, errors: [] };
}

/** `arguments` per spec: "a space-separated string or a YAML list". Names map
 * to argument positions in order, so `arguments: [issue, branch]` makes
 * `$issue` the first argument and `$branch` the second. */
function validateNameList(
	frontmatter: Record<string, unknown>,
	field: string,
): { value: string[] | undefined; errors: string[] } {
	const raw = frontmatter[field];
	if (raw === undefined) return { value: undefined, errors: [] };
	const entries = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(LIST_SPLIT_RE).filter(Boolean)
			: undefined;
	if (!entries) return { value: undefined, errors: [`${field} must be a space-separated string or a YAML list`] };
	const names = entries.filter((entry): entry is string => typeof entry === "string" && ARGUMENT_NAME_RE.test(entry));
	if (names.length !== entries.length) {
		return { value: undefined, errors: [`${field} entries must be names matching [A-Za-z_][A-Za-z0-9_]*`] };
	}
	return { value: names.length > 0 ? names : undefined, errors: [] };
}

/** First non-empty paragraph of a skill body — the spec's fallback description. */
function firstParagraph(body: string): string | undefined {
	for (const block of body.split(PARAGRAPH_SPLIT_RE)) {
		const text = block.trim();
		if (text) return text.length > MAX_DESCRIPTION_LENGTH ? text.slice(0, MAX_DESCRIPTION_LENGTH) : text;
	}
	return undefined;
}

function validateMetadata(value: unknown): { value: Record<string, string> | undefined; errors: string[] } {
	if (value === undefined) return { value: undefined, errors: [] };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { value: undefined, errors: ["metadata must be a mapping of string keys to string values"] };
	}
	const metadata: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			return { value: undefined, errors: ["metadata must be a mapping of string keys to string values"] };
		}
		metadata[key] = entry;
	}
	return { value: metadata, errors: [] };
}

// ============================================================================
// Discovery
// ============================================================================

function loadSkillFromFile(
	filePath: string,
	source: SkillSource,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		diagnostics.push({ message: error instanceof Error ? error.message : String(error), path: filePath });
		return { skill: null, diagnostics };
	}

	const { frontmatter, body, errors: yamlErrors } = parseFrontmatter(raw);
	for (const message of yamlErrors)
		diagnostics.push({ message: `invalid YAML frontmatter: ${message}`, path: filePath });
	if (yamlErrors.length > 0) return { skill: null, diagnostics };
	const parentDirName = basename(dirname(filePath));
	// Per the Agent Skills spec, `name` is optional and defaults to the
	// directory name, and `description` is only *recommended* — when it is
	// absent the first paragraph of the body stands in. cast required both and
	// additionally demanded that `name` equal the directory, so skills written
	// to the published spec (anthropics/skills, skills.sh packages) were
	// dropped at load with a diagnostic nobody reads.
	const declaredName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : undefined;
	const name = declaredName || parentDirName;
	const declaredDescription =
		typeof frontmatter.description === "string" && frontmatter.description.trim() !== ""
			? frontmatter.description
			: undefined;
	const description = declaredDescription ?? firstParagraph(body);

	for (const error of validateSkillDescription(description)) diagnostics.push({ message: error, path: filePath });
	for (const error of validateSkillName(name)) diagnostics.push({ message: error, path: filePath });
	const argumentHint = validateOptionalString(frontmatter, "argument-hint");
	const argumentNames = validateNameList(frontmatter, "arguments");
	const paths = validateGlobList(frontmatter, "paths");
	const skillHooks = coerceHooksObject(frontmatter.hooks, source === "plugin" ? "plugin" : "project");
	const license = validateOptionalString(frontmatter, "license");
	const compatibility = validateOptionalString(frontmatter, "compatibility", MAX_COMPATIBILITY_LENGTH);
	const allowedTools = validateToolList(frontmatter, "allowed-tools");
	const disallowedTools = validateToolList(frontmatter, "disallowed-tools");
	const metadata = validateMetadata(frontmatter.metadata);
	for (const result of [license, compatibility, allowedTools, disallowedTools, argumentHint, paths, metadata]) {
		for (const message of result.errors) diagnostics.push({ message, path: filePath });
	}
	const hasValidationErrors = diagnostics.length > 0;

	if (body.split("\n").length > RECOMMENDED_MAX_BODY_LINES) {
		diagnostics.push({
			message: `body exceeds the recommended ${RECOMMENDED_MAX_BODY_LINES}-line progressive-disclosure limit`,
			path: filePath,
		});
	}

	if (hasValidationErrors) return { skill: null, diagnostics };

	return {
		skill: {
			name,
			description: description!,
			whenToUse: typeof frontmatter.when_to_use === "string" ? frontmatter.when_to_use : undefined,
			license: license.value,
			compatibility: compatibility.value,
			metadata: metadata.value,
			allowedTools: allowedTools.value,
			disallowedTools: disallowedTools.value,
			filePath,
			baseDir: dirname(filePath),
			source,
			disableModelInvocation: parseSpecBoolean(frontmatter["disable-model-invocation"]),
			userInvocable: parseSpecBoolean(frontmatter["user-invocable"], true),
			argumentHint: argumentHint.value,
			argumentNames: argumentNames.value,
			paths: paths.value,
			...(Object.keys(skillHooks).length > 0 ? { hooks: skillHooks } : {}),
			body,
		},
		diagnostics,
	};
}

/**
 * Discovery rule: a directory containing SKILL.md is a skill root and
 * recursion stops there. Other directories are containers only: recurse into
 * them to find skill roots, never treating arbitrary Markdown as a package.
 */
function loadSkillsFromDirInternal(
	dir: string,
	source: SkillSource,
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({ message: error instanceof Error ? error.message : String(error), path: dir });
		return { skills, diagnostics };
	}

	if (entries.some((e) => e.name === "SKILL.md" && e.isFile())) {
		const result = loadSkillFromFile(join(dir, "SKILL.md"), source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			const result = loadSkillsFromDirInternal(fullPath, source);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
		}
	}

	return { skills, diagnostics };
}

export interface LoadSkillsOptions {
	/** `prompts/skills/` — ships with cast, always loaded. */
	builtinDir?: string;
	/** `~/.cast/skills` — omit only for `--no-skills`; needs no trust prompt (the user put it there themselves). */
	globalDir?: string;
	/** `<cwd>/.cast/skills` — omit entirely if `--no-skills` or the project isn't trusted yet. */
	projectDir?: string;
	/**
	 * `<cwd>/.agents/skills` — skills.sh universal project path (e.g. `npx skills add`).
	 * Trust-gated like `projectDir`.
	 */
	agentsProjectDir?: string;
	/**
	 * Universal global paths (`~/.config/agents/skills`, `~/.agents/skills`).
	 * First listed wins on collision within this tier.
	 */
	agentsGlobalDirs?: string[];
	/**
	 * Marketplace plugin skill roots (enabled and disabled). Disabled packs
	 * still load for the `/skills` picker with `pluginEnabled: false`.
	 */
	pluginContributions?: PluginSkillContribution[];
	/** @deprecated Prefer `pluginContributions` — string dirs load as enabled plugin skills. */
	pluginDirs?: string[];
	/** Explicit `--skill <directory>` packages — load even with `--no-skills`. */
	extraPaths: string[];
}

/**
 * Load skills from every configured location. On a name collision the
 * first-loaded skill wins:
 * `.cast` project > `.agents` project > `.cast` global > `.agents` global >
 * plugin > builtin > `--skill` paths.
 */
export function loadSkills(options: LoadSkillsOptions): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skillMap = new Map<string, Skill>();
	const diagnostics: SkillDiagnostic[] = [];

	function addAll(result: { skills: Skill[]; diagnostics: SkillDiagnostic[] }) {
		diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			if (skillMap.has(skill.name)) {
				diagnostics.push({
					message: `skill name "${skill.name}" collision — keeping the first one loaded`,
					path: skill.filePath,
				});
				continue;
			}
			skillMap.set(skill.name, skill);
		}
	}

	// Highest priority first (see JSDoc).
	if (options.projectDir) addAll(loadSkillsFromDirInternal(options.projectDir, "project"));
	if (options.agentsProjectDir) addAll(loadSkillsFromDirInternal(options.agentsProjectDir, "agents"));
	if (options.globalDir) addAll(loadSkillsFromDirInternal(options.globalDir, "global"));
	for (const dir of options.agentsGlobalDirs ?? []) {
		addAll(loadSkillsFromDirInternal(dir, "agents"));
	}
	const pluginContributions: PluginSkillContribution[] = [
		...(options.pluginContributions ?? []),
		...(options.pluginDirs ?? []).map((dir) => ({ dir, pluginId: "", enabled: true })),
	];
	for (const contrib of pluginContributions) {
		const loaded = loadSkillsFromDirInternal(contrib.dir, "plugin");
		for (const skill of loaded.skills) {
			if (contrib.pluginId) skill.pluginId = contrib.pluginId;
			skill.pluginEnabled = contrib.enabled;
		}
		addAll(loaded);
	}
	if (options.builtinDir) addAll(loadSkillsFromDirInternal(options.builtinDir, "builtin"));

	for (const rawPath of options.extraPaths) {
		if (!existsSync(rawPath)) {
			diagnostics.push({ message: "skill path does not exist", path: rawPath });
			continue;
		}
		const stats = statSync(rawPath);
		if (stats.isDirectory()) {
			const skillPath = join(rawPath, "SKILL.md");
			if (!existsSync(skillPath)) {
				diagnostics.push({ message: "skill directory must contain SKILL.md", path: rawPath });
				continue;
			}
			const result = loadSkillFromFile(skillPath, "path");
			if (result.skill) addAll({ skills: [result.skill], diagnostics: result.diagnostics });
			else diagnostics.push(...result.diagnostics);
		} else {
			diagnostics.push({ message: "skill path must be a directory containing SKILL.md", path: rawPath });
		}
	}

	const skills = Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
	return { skills, diagnostics };
}

// ============================================================================
// System prompt injection
// ============================================================================

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Skills with `disable-model-invocation: true` are omitted — usable only via
 * /skill:name. `personaSkillsAllowlist` (a persona's `skills:` frontmatter,
 * when set) additionally drops anything the active persona can't invoke —
 * keeps what's described here in sync with what loop.ts actually enforces,
 * so the model isn't pointed at a skill it'll then get rejected for calling.
 */
/**
 * A `paths`-scoped skill is only offered while a file it claims is in
 * context — the spec's "Claude loads the skill automatically only when
 * working with files matching the patterns". A skill without `paths` is
 * always offered, as before.
 */
export function skillMatchesContext(skill: Skill, contextFiles: string[]): boolean {
	if (!skill.paths?.length) return true;
	return contextFiles.some((file) => skill.paths!.some((pattern) => fileMatchesGlob(pattern, file)));
}

export function formatSkillsForPrompt(
	skills: Skill[],
	personaSkillsAllowlist?: string[],
	contextFiles: string[] = [],
): string {
	let visible = skills.filter((s) => !s.disableModelInvocation && skillMatchesContext(s, contextFiles));
	if (personaSkillsAllowlist !== undefined) {
		visible = visible.filter((s) => matchesToolsAllowlist(s.name, personaSkillsAllowlist));
	}
	if (visible.length === 0) return "";

	const lines = ["", "", SKILLS_INSTRUCTIONS, "", "<available_skills>"];
	for (const skill of visible) {
		const combined = skill.whenToUse ? `${skill.description} — ${skill.whenToUse}` : skill.description;
		const desc =
			combined.length > MAX_LISTING_DESCRIPTION_LENGTH
				? combined.slice(0, MAX_LISTING_DESCRIPTION_LENGTH)
				: combined;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(desc)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/**
 * Parse an arguments string into an array. Handles quoted strings.
 * "foo bar baz" => ["foo", "bar", "baz"]
 * 'foo "hello world" baz' => ["foo", "hello world", "baz"]
 */
function parseArguments(args: string): string[] {
	if (!args?.trim()) return [];
	const result: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	for (const ch of args) {
		if (inQuote) {
			if (ch === inQuote) {
				inQuote = null;
			} else {
				current += ch;
			}
		} else if (ch === '"' || ch === "'") {
			inQuote = ch;
		} else if (ch === " " || ch === "\t") {
			if (current) {
				result.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current) result.push(current);
	return result;
}

/**
 * Substitute $ARGUMENTS placeholders in content with actual argument values.
 * Supports: $ARGUMENTS (full string), $ARGUMENTS[0]/$0 (indexed), ${CAST_SKILL_DIR},
 * ${CAST_SESSION_ID} (the active session's id, when provided).
 * Returns the substituted content. Caller decides what to do if no placeholders matched.
 */
export interface SubstitutionContext {
	/** Project root — the spec's `${CLAUDE_PROJECT_DIR}`. */
	projectDir?: string;
	/** Installed plugin root for a plugin skill — `${CLAUDE_PLUGIN_ROOT}`. */
	pluginRoot?: string;
	/** Named positional arguments declared in `arguments` frontmatter. */
	argumentNames?: string[];
}

function substituteArguments(
	content: string,
	args: string | undefined,
	baseDir: string,
	sessionId?: string,
	context: SubstitutionContext = {},
): string {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
	content = content.replaceAll("${CAST_SKILL_DIR}", baseDir);
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
	content = content.replaceAll("${CLAUDE_SKILL_DIR}", baseDir);
	// An unresolved placeholder must never reach the model: it reads as an
	// instruction ("substitute the arguments") for something that already
	// happened, or as literal text the skill author never meant to show. Every
	// placeholder is replaced, with an empty string when there is nothing to
	// put there — both for a skill invoked without `args` (the tool's `args`
	// is optional) and outside a session.
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
	content = content.replaceAll("${CAST_SESSION_ID}", sessionId ?? "");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
	content = content.replaceAll("${CLAUDE_SESSION_ID}", sessionId ?? "");

	if (context.projectDir) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
		content = content.replaceAll("${CLAUDE_PROJECT_DIR}", context.projectDir);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
		content = content.replaceAll("${CAST_PROJECT_DIR}", context.projectDir);
	}
	if (context.pluginRoot) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder for skill template variable, not JS template
		content = content.replaceAll("${CLAUDE_PLUGIN_ROOT}", context.pluginRoot);
	}

	const parsed = parseArguments(args ?? "");

	// Named arguments (`arguments: [issue, branch]` → `$issue`, `$branch`),
	// substituted before the positional forms so a name is never mistaken for
	// bare text. Declared-but-missing names resolve to an empty string, like
	// every other placeholder.
	for (const [index, argName] of (context.argumentNames ?? []).entries()) {
		content = content.replaceAll(`$${argName}`, parsed[index] ?? "");
	}

	// $ARGUMENTS[0], $ARGUMENTS[1], etc.
	content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, idx) => parsed[parseInt(idx, 10)] ?? "");

	// $0, $1, etc. (but not $0x or $10+ which are different patterns)
	content = content.replace(/\$(\d+)(?!\w)/g, (_, idx) => parsed[parseInt(idx, 10)] ?? "");

	// $ARGUMENTS — full string
	content = content.replaceAll("$ARGUMENTS", args ?? "");

	return content;
}

const BASH_INJECTION_RE = /!`([^`\n]+)`/g;
/** Ceilings on inline command execution: a skill body is a prompt fragment,
 * not a build script. */
const MAX_INJECTED_COMMANDS = 10;
const INJECTION_TIMEOUT_MS = 10_000;
const MAX_INJECTION_OUTPUT_CHARS = 2000;

/** How an inline command is cleared to run. Supplied by the caller so a skill
 * body goes through exactly the gates the `bash` tool does, rather than
 * bypassing them by virtue of living in a skill. */
export interface InlineCommandGate {
	/** Plan mode / a read-only subagent: only inspection commands may run. */
	readOnly?: boolean;
	/** Same confirmation callback the bash tool uses for dangerous patterns. */
	confirm?: (command: string, reason: string) => Promise<boolean>;
}

/**
 * Run the `` !`command` `` blocks a skill body declares and splice their
 * output in, the way the skill expects to be read. Left unexecuted, the model
 * sees the literal text and treats it as a fact or an instruction — a body
 * saying `` Node: !`node --version` `` reads as though the version had been
 * checked.
 */
async function runInlineCommands(content: string, cwd: string | undefined, gate: InlineCommandGate): Promise<string> {
	const matches = [...content.matchAll(BASH_INJECTION_RE)];
	if (matches.length === 0) return content;
	const outputs = new Map<string, string>();
	let executed = 0;
	for (const match of matches) {
		const command = match[1]!;
		if (outputs.has(command)) continue;
		if (executed >= MAX_INJECTED_COMMANDS) {
			outputs.set(command, `[not run — a skill may run at most ${MAX_INJECTED_COMMANDS} inline commands]`);
			continue;
		}
		executed++;
		// The same two gates the bash tool applies. A skill body is untrusted
		// input like any other — most of them only probe the environment
		// (`node --version`), which is exactly why refusing them wholesale was
		// the wrong call, but a skill must not be a way *around* the checks a
		// plain bash call would face.
		if (gate.readOnly) {
			// biome-ignore lint/performance/noAwaitInLoops: each command is checked before the next runs
			const verdict = await checkReadOnlyCommand(command);
			if (!verdict.ok) {
				outputs.set(command, `[not run — plan mode allows read-only commands only: ${verdict.reason}]`);
				continue;
			}
		}
		const danger = checkDangerousBash(command);
		if (danger) {
			const approved = gate.confirm ? await gate.confirm(command, danger) : false;
			if (!approved) {
				outputs.set(command, `[not run — matches a dangerous pattern (${danger}) and was not confirmed]`);
				continue;
			}
		}
		try {
			// Sequential on purpose: a skill's blocks routinely probe the same
			// environment in order ("is X installed" then "which version"), and
			// running a body's commands in parallel would reorder side effects
			// the author wrote as a sequence.
			const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
				cwd,
				timeout: INJECTION_TIMEOUT_MS,
				encoding: "utf-8",
				maxBuffer: MAX_INJECTION_OUTPUT_CHARS * 4,
			});
			const text = (stdout || stderr || "").trim();
			outputs.set(
				command,
				text.length > MAX_INJECTION_OUTPUT_CHARS ? `${text.slice(0, MAX_INJECTION_OUTPUT_CHARS)}…` : text,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			outputs.set(command, `[command failed: ${message.split("\n")[0]}]`);
		}
	}
	return content.replace(BASH_INJECTION_RE, (_, command: string) => outputs.get(command) ?? "");
}

/** Format a skill's full content for `/skill:name` invocation, optionally with trailing user args. */
/**
 * `formatSkillInvocation` plus the inline `` !`command` `` blocks executed.
 * Async because running them is; callers that cannot await keep using the
 * synchronous form, which leaves the blocks untouched.
 */
export async function renderSkillInvocation(
	skill: Skill,
	additionalArgs?: string,
	sessionId?: string,
	context: Omit<SubstitutionContext, "argumentNames"> & { gate?: InlineCommandGate } = {},
): Promise<string> {
	const rendered = formatSkillInvocation(skill, additionalArgs, sessionId, context);
	return runInlineCommands(rendered, context.projectDir, context.gate ?? {});
}

export function formatSkillInvocation(
	skill: Skill,
	additionalArgs?: string,
	sessionId?: string,
	context: Omit<SubstitutionContext, "argumentNames"> = {},
): string {
	const content = readSkillBody(skill);
	const substituted = substituteArguments(content, additionalArgs, skill.baseDir, sessionId, {
		...context,
		argumentNames: skill.argumentNames,
	});
	// Check if any $ARGUMENTS placeholders were actually substituted
	const hadPlaceholders =
		content.includes("$ARGUMENTS") ||
		content.includes("$0") ||
		// biome-ignore lint/suspicious/noTemplateCurlyInString: checking for literal placeholder in content
		content.includes("${CLAUDE_SKILL_DIR}") ||
		// biome-ignore lint/suspicious/noTemplateCurlyInString: checking for literal placeholder in content
		content.includes("${CAST_SESSION_ID}");
	const allowedTools = skill.allowedTools ? ` allowed-tools="${escapeXml(skill.allowedTools)}"` : "";
	const block = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}"${allowedTools}>\nReferences are relative to ${skill.baseDir}.\n\n${substituted}\n</skill>`;
	// If args were provided but no $ARGUMENTS placeholder consumed them, append as User: line
	if (additionalArgs && !hadPlaceholders) {
		return `${block}\n\nUser: ${additionalArgs}`;
	}
	return block;
}
