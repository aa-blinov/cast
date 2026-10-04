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
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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
/** What the skill list may cost in the system prompt, in characters (about 5k tokens). */
const SKILLS_LISTING_BUDGET = 20_000;
const MIN_LISTING_DESCRIPTION_LENGTH = 160;
/** The tags around one listed skill, besides its name and description. */
const LISTING_ENTRY_OVERHEAD = 70;
const MAX_COMPATIBILITY_LENGTH = 500;
const RECOMMENDED_MAX_BODY_LINES = 500;

// Instructions injected into the system prompt alongside the discovered
// skill list — content, not code, so it lives in prompts/ with the other
// prompt files instead of as inline strings here.
const SKILLS_INSTRUCTIONS = readRequiredPrompt(promptsDir, "skills-instructions.md");

export const builtinSkillsDir = join(promptsDir, "skills");

export type SkillSource = "builtin" | "global" | "project" | "agents" | "claude" | "path";

/** What a user can switch off in settings (`disabledSkillSources`): each
 *  family covers its global and project directories. `--skill` paths stay. */
export type SkillSourceFamily = "builtin" | "cast" | "agents" | "claude";
export const SKILL_SOURCE_FAMILIES: SkillSourceFamily[] = ["builtin", "cast", "agents", "claude"];

export const SKILL_SOURCE_LABELS: Record<SkillSourceFamily, string> = {
	builtin: "Built-in (shipped with cast)",
	cast: "cast: ~/.cast/skills, .cast/skills",
	agents: "skills.sh: ~/.agents/skills, .agents/skills",
	claude: "Claude Code: ~/.claude/skills, .claude/skills",
};

export function isSkillSourceFamily(value: string): value is SkillSourceFamily {
	return (SKILL_SOURCE_FAMILIES as string[]).includes(value);
}

/** Every family, whether it is on, for `/skills sources` on each surface. */
export function listSkillSources(
	disabled: readonly SkillSourceFamily[] = [],
): Array<{ family: SkillSourceFamily; label: string; enabled: boolean }> {
	return SKILL_SOURCE_FAMILIES.map((family) => ({
		family,
		label: SKILL_SOURCE_LABELS[family],
		enabled: !disabled.includes(family),
	}));
}

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
	/**
	 * Cached skill body (frontmatter stripped) — read once at discovery time so
	 * `/skill:name` and the skill tool don't I/O on every invocation. Stale
	 * only if the file changes on disk between discoveries; `/reload`
	 * re-discovers and naturally invalidates.
	 */
	body?: string;
}

export interface SkillDiagnostic {
	message: string;
	path: string;
	/** An error kept the skill from loading; a warning left it loaded (or shadowed it by another of the same name). */
	severity: "error" | "warning";
}

/** What `/skills problems` says: skills that did not load, then the notes about ones that did. Empty when all is well. */
export function formatSkillDiagnostics(diagnostics: SkillDiagnostic[], home?: string): string {
	const show = (d: SkillDiagnostic) =>
		`  ${home && d.path.startsWith(home) ? `~${d.path.slice(home.length)}` : d.path}: ${d.message}`;
	const errors = diagnostics.filter((d) => d.severity === "error");
	const warnings = diagnostics.filter((d) => d.severity === "warning");
	const blocks: string[] = [];
	if (errors.length > 0) {
		blocks.push(
			`Could not load ${errors.length} skill${errors.length === 1 ? "" : "s"}:\n${errors.map(show).join("\n")}`,
		);
	}
	if (warnings.length > 0) blocks.push(`Notes:\n${warnings.map(show).join("\n")}`);
	return blocks.join("\n\n");
}

/**
 * Read a skill's body (frontmatter stripped) — uses the cached body if it was
 * loaded by `loadSkillFromFile`, falls back to a disk read for legacy callers.
 * `/reload` re-discovers skills, so a stale cache is naturally invalidated.
 */
function readSkillBody(skill: Skill): string {
	return skill.body ?? parseFrontmatter(readFileSync(skill.filePath, "utf-8")).body;
}

/** User-managed skills that `/skills uninstall` may delete (not builtin or --skill). */
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

const ARGUMENT_HINT_LINE_RE = /^(argument-hint:[ \t]*)(\[.*\])[ \t]*$/m;

/**
 * `argument-hint: [issue-number]` is how Claude Code's documentation writes the field, and it is a YAML flow list, not
 * a string (`[file] [format]`, the other form it shows, is not YAML at all). Read as YAML either lost the whole skill,
 * so a hint written in brackets and left unquoted is read as the text it is.
 */
function quoteBracketedArgumentHint(raw: string): string {
	const end = raw.indexOf("\n---", 4);
	if (!raw.startsWith("---") || end === -1) return raw;
	const head = raw
		.slice(0, end)
		.replace(
			ARGUMENT_HINT_LINE_RE,
			(_, key: string, value: string) => `${key}"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
		);
	return head + raw.slice(end);
}

function loadSkillFromFile(
	filePath: string,
	source: SkillSource,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		diagnostics.push({
			message: error instanceof Error ? error.message : String(error),
			path: filePath,
			severity: "error",
		});
		return { skill: null, diagnostics };
	}

	const { frontmatter, body, errors: yamlErrors } = parseFrontmatter(quoteBracketedArgumentHint(raw));
	for (const message of yamlErrors)
		diagnostics.push({ message: `invalid YAML frontmatter: ${message}`, path: filePath, severity: "error" });
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
	let description = declaredDescription ?? firstParagraph(body);
	// Too long is a nuisance, not a reason to lose the skill: it is cut (as the listing cuts it anyway) and said so.
	if (description && description.length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push({
			message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length}); it was cut`,
			path: filePath,
			severity: "warning",
		});
		description = description.slice(0, MAX_DESCRIPTION_LENGTH);
	}

	for (const error of validateSkillDescription(description))
		diagnostics.push({ message: error, path: filePath, severity: "error" });
	for (const error of validateSkillName(name)) diagnostics.push({ message: error, path: filePath, severity: "error" });
	const argumentHint = validateOptionalString(frontmatter, "argument-hint");
	const argumentNames = validateNameList(frontmatter, "arguments");
	const paths = validateGlobList(frontmatter, "paths");
	const skillHooks = coerceHooksObject(frontmatter.hooks, "project");
	const license = validateOptionalString(frontmatter, "license");
	const compatibility = validateOptionalString(frontmatter, "compatibility");
	if (compatibility.value && compatibility.value.length > MAX_COMPATIBILITY_LENGTH) {
		diagnostics.push({
			message: `compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters (${compatibility.value.length}); it was left out`,
			path: filePath,
			severity: "warning",
		});
		compatibility.value = undefined;
	}
	const allowedTools = validateToolList(frontmatter, "allowed-tools");
	const disallowedTools = validateToolList(frontmatter, "disallowed-tools");
	const metadata = validateMetadata(frontmatter.metadata);
	for (const result of [license, compatibility, allowedTools, disallowedTools, argumentHint, paths, metadata]) {
		for (const message of result.errors) diagnostics.push({ message, path: filePath, severity: "error" });
	}
	const hasValidationErrors = diagnostics.some((d) => d.severity === "error");

	if (body.split("\n").length > RECOMMENDED_MAX_BODY_LINES) {
		diagnostics.push({
			message: `body exceeds the recommended ${RECOMMENDED_MAX_BODY_LINES}-line progressive-disclosure limit`,
			path: filePath,
			severity: "warning",
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
function isDirectoryTarget(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function loadSkillsFromDirInternal(
	dir: string,
	source: SkillSource,
	visited: Set<string> = new Set(),
): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };
	// Symlinks are followed (below), so a link back up the tree must not loop.
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		return { skills, diagnostics };
	}
	if (visited.has(real)) return { skills, diagnostics };
	visited.add(real);

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		diagnostics.push({
			message: error instanceof Error ? error.message : String(error),
			path: dir,
			severity: "error",
		});
		return { skills, diagnostics };
	}

	if (
		entries.some(
			(e) => e.name === "SKILL.md" && (e.isFile() || (e.isSymbolicLink() && existsSync(join(dir, "SKILL.md")))),
		)
	) {
		const result = loadSkillFromFile(join(dir, "SKILL.md"), source);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);

		// A skill linked in (a dotfiles checkout, another tool's install) is a
		// symlink, which readdir doesn't report as a directory: followed, or it
		// silently never loaded. A dangling link is skipped.
		const isDir = entry.isDirectory() || (entry.isSymbolicLink() && isDirectoryTarget(fullPath));
		if (isDir) {
			const result = loadSkillsFromDirInternal(fullPath, source, visited);
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
	/** `<cwd>/.claude/skills` — Claude Code's project skills. Trust-gated like `projectDir`. */
	claudeProjectDir?: string;
	/** `~/.claude/skills` — Claude Code's user skills, same SKILL.md format. */
	claudeGlobalDir?: string;
	/** Explicit `--skill <directory>` packages — load even with `--no-skills`. */
	extraPaths: string[];
}

function sameRealPath(a: string, b: string): boolean {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/**
 * Load skills from every configured location. On a name collision the
 * first-loaded skill wins:
 * `.cast` project > `.agents` project > `.claude` project > `.cast` global >
 * `.agents` global > `.claude` global > builtin > `--skill` paths.
 */
export function loadSkills(options: LoadSkillsOptions): { skills: Skill[]; diagnostics: SkillDiagnostic[] } {
	const skillMap = new Map<string, Skill>();
	const diagnostics: SkillDiagnostic[] = [];

	function addAll(result: { skills: Skill[]; diagnostics: SkillDiagnostic[] }) {
		diagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const taken = skillMap.get(skill.name);
			if (taken) {
				// `skills add` links one install into several agents' directories: the same skill seen twice.
				if (sameRealPath(taken.baseDir, skill.baseDir)) continue;
				diagnostics.push({
					message: `skill name "${skill.name}" collision — keeping the first one loaded`,
					path: skill.filePath,
					severity: "warning",
				});
				continue;
			}
			skillMap.set(skill.name, skill);
		}
	}

	// Highest priority first (see JSDoc).
	if (options.projectDir) addAll(loadSkillsFromDirInternal(options.projectDir, "project"));
	if (options.agentsProjectDir) addAll(loadSkillsFromDirInternal(options.agentsProjectDir, "agents"));
	if (options.claudeProjectDir) addAll(loadSkillsFromDirInternal(options.claudeProjectDir, "claude"));
	if (options.globalDir) addAll(loadSkillsFromDirInternal(options.globalDir, "global"));
	for (const dir of options.agentsGlobalDirs ?? []) {
		addAll(loadSkillsFromDirInternal(dir, "agents"));
	}
	if (options.claudeGlobalDir) addAll(loadSkillsFromDirInternal(options.claudeGlobalDir, "claude"));
	if (options.builtinDir) addAll(loadSkillsFromDirInternal(options.builtinDir, "builtin"));

	for (const rawPath of options.extraPaths) {
		if (!existsSync(rawPath)) {
			diagnostics.push({ message: "skill path does not exist", path: rawPath, severity: "error" });
			continue;
		}
		const stats = statSync(rawPath);
		if (stats.isDirectory()) {
			const skillPath = join(rawPath, "SKILL.md");
			if (!existsSync(skillPath)) {
				diagnostics.push({ message: "skill directory must contain SKILL.md", path: rawPath, severity: "error" });
				continue;
			}
			const result = loadSkillFromFile(skillPath, "path");
			if (result.skill) addAll({ skills: [result.skill], diagnostics: result.diagnostics });
			else diagnostics.push(...result.diagnostics);
		} else {
			diagnostics.push({
				message: "skill path must be a directory containing SKILL.md",
				path: rawPath,
				severity: "error",
			});
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

	// Every turn pays for this list, so it has a budget: past it each description is cut to an even share, never
	// below a line's worth, and the names always stay. A hundred skills used to cost the system prompt ~14k tokens.
	const combined = visible.map((s) => (s.whenToUse ? `${s.description} — ${s.whenToUse}` : s.description));
	const fixed = visible.reduce((n, s) => n + s.name.length + LISTING_ENTRY_OVERHEAD, 0);
	const evenShare = Math.max(
		MIN_LISTING_DESCRIPTION_LENGTH,
		Math.floor((SKILLS_LISTING_BUDGET - fixed) / visible.length),
	);
	const cap = Math.min(MAX_LISTING_DESCRIPTION_LENGTH, evenShare);
	const lines = ["", "", SKILLS_INSTRUCTIONS, "", "<available_skills>"];
	for (const [index, skill] of visible.entries()) {
		const full = combined[index]!;
		// The spec's own cut is plain; the budget's is marked so the model knows the text was shortened.
		const desc =
			full.length <= cap
				? full
				: cap === MAX_LISTING_DESCRIPTION_LENGTH
					? full.slice(0, cap)
					: `${full.slice(0, cap - 1).trimEnd()}…`;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(desc)}</description>`);
		// No <location>: the skill tool loads by name and reports the path
		// itself. The install paths here outnumbered the one working
		// directory, and a model asked to "commit my changes" opened with
		// `cd <cast install> && git status` and committed there.
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
 * Substitute placeholders in a skill body with the invocation's arguments and paths: $ARGUMENTS (the full string),
 * $ARGUMENTS[0] / $0 (indexed), $name (declared in `arguments`), ${CAST_SKILL_DIR}, ${CAST_SESSION_ID} and
 * ${CAST_PROJECT_DIR} (each also spelled CLAUDE_*).
 */
export interface SubstitutionContext {
	/** Project root — the spec's `${CLAUDE_PROJECT_DIR}`. */
	projectDir?: string;
	/** Named positional arguments declared in `arguments` frontmatter. */
	argumentNames?: string[];
}

// One pass over the body, so a value that was just put in (a path, whatever the user typed) is never read again as a
// placeholder: an argument of "$ARGUMENTS x" or "costs $5" came out garbled when each placeholder had its own pass.
const PLACEHOLDER_RE =
	/\$\{(?:CAST|CLAUDE)_(SKILL_DIR|SESSION_ID|PROJECT_DIR)\}|\$ARGUMENTS\[(\d+)\]|\$(\d+)(?![A-Za-z0-9_])|\$([A-Za-z_][A-Za-z0-9_]*)/g;

function substituteArguments(
	content: string,
	args: string | undefined,
	baseDir: string,
	sessionId?: string,
	context: SubstitutionContext = {},
): { text: string; consumedArguments: boolean } {
	const parsed = parseArguments(args ?? "");
	const names = new Map((context.argumentNames ?? []).map((name, index) => [name, index]));
	let consumedArguments = false;
	// An unresolved placeholder must never reach the model: it reads as an instruction ("substitute the arguments")
	// for something that already happened. Every one is replaced, with an empty string when there is nothing to put
	// there (a skill invoked without `args`, or outside a session). The project dir is the one exception: without a
	// project it stays as written, since there is nothing true to say.
	const text = content.replace(
		PLACEHOLDER_RE,
		(match, special?: string, index?: string, bare?: string, name?: string): string => {
			if (special === "SKILL_DIR") return baseDir;
			if (special === "SESSION_ID") return sessionId ?? "";
			if (special === "PROJECT_DIR") return context.projectDir ?? match;
			if (index !== undefined) {
				consumedArguments = true;
				return parsed[Number.parseInt(index, 10)] ?? "";
			}
			if (bare !== undefined) {
				consumedArguments = true;
				return parsed[Number.parseInt(bare, 10)] ?? "";
			}
			if (name === undefined) return match;
			if (name === "ARGUMENTS") {
				consumedArguments = true;
				return args ?? "";
			}
			if (names.has(name)) {
				consumedArguments = true;
				return parsed[names.get(name)!] ?? "";
			}
			return match;
		},
	);
	return { text, consumedArguments };
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
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/** The body's lines with whether each sits inside a fenced code block: an example of `!`cmd`` in one is text to show, not to run. */
function markFences(content: string): Array<{ text: string; fenced: boolean }> {
	let open: string | undefined;
	return content.split("\n").map((text) => {
		const fence = FENCE_RE.exec(text)?.[1];
		if (fence && !open) {
			open = fence;
			return { text, fenced: true };
		}
		if (fence && fence === open) {
			open = undefined;
			return { text, fenced: true };
		}
		return { text, fenced: open !== undefined };
	});
}

async function runInlineCommands(content: string, cwd: string | undefined, gate: InlineCommandGate): Promise<string> {
	const lines = markFences(content);
	const matches = lines.filter((l) => !l.fenced).flatMap((l) => [...l.text.matchAll(BASH_INJECTION_RE)]);
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
	return lines
		.map((l) =>
			l.fenced ? l.text : l.text.replace(BASH_INJECTION_RE, (_, command: string) => outputs.get(command) ?? ""),
		)
		.join("\n");
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
	const { text: substituted, consumedArguments } = substituteArguments(
		readSkillBody(skill),
		additionalArgs,
		skill.baseDir,
		sessionId,
		{ ...context, argumentNames: skill.argumentNames },
	);
	const allowedTools = skill.allowedTools ? ` allowed-tools="${escapeXml(skill.allowedTools)}"` : "";
	// What was typed, on the tag: the body may have consumed it ($ARGUMENTS), and the
	// thread shows `/name args`, not the file.
	const typed = additionalArgs?.trim() ? ` arguments="${escapeXml(additionalArgs.trim())}"` : "";
	const block = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}"${typed}${allowedTools}>\nReferences are relative to ${skill.baseDir}.\n\n${substituted}\n</skill>`;
	// Arguments the body had no place for are appended rather than dropped. Only an argument placeholder counts as a
	// place: a body that merely names its own directory has not asked for what was typed.
	if (additionalArgs?.trim() && !consumedArguments) {
		return `${block}\n\nUser: ${additionalArgs}`;
	}
	return block;
}
