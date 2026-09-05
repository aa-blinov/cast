/**
 * Project rules — Cursor-compatible `.cast/rules/*.md` files with frontmatter.
 *
 * Four rule types, matching Cursor's anatomy exactly:
 *   - `alwaysApply: true` → always injected (globs ignored)
 *   - `alwaysApply: false` + `globs` → auto-attach when matching files
 *     enter context; sticky once latched
 *   - `alwaysApply: false` + `description` (no globs) → lazy: model
 *     decides relevance, reads via read tool
 *   - `alwaysApply: false` (no globs, no description) → manual:
 *     only via @-mention or /rule:name
 *
 * Global rules load from `~/.cast/rules/`; project rules from
 * `<cwd>/.cast/rules/`. Both gated behind the unified project trust
 * decision (global always trusted, project needs trust prompt).
 *
 * Frontmatter is parsed by the shared YAML parser in frontmatter.ts.
 */

import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { promptsDir, readRequiredPrompt } from "./prompts.ts";

const REGEX_SPECIAL_CHARS_RE = /[.*+?^${}()|[\]\\]/g;
const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOTE_RE = /"/g;

// ============================================================================
// Constants
// ============================================================================

const RULES_INSTRUCTIONS = readRequiredPrompt(promptsDir, "rules-instructions.md");

// ============================================================================
// Types
// ============================================================================

export type RuleSource = "global" | "project";

/**
 * Apply mode — mirrors Cursor's four rule types exactly.
 *
 * - `always`: alwaysApply=true → injected every turn (globs ignored)
 * - `auto`: alwaysApply=false + globs → auto-attach when matching files
 *   enter context; sticky once latched for the session
 * - `lazy`: alwaysApply=false + description (no globs) → model decides
 *   relevance, reads via read tool
 * - `manual`: alwaysApply=false (no globs, no description) → @-mention
 *   or /rule:name only
 */
export type ApplyMode = "always" | "auto" | "lazy" | "manual";

export interface Rule {
	/** Human label — filename without .md (or frontmatter `name`). Not unique
	 * across scopes: two subtrees can each have a `style.md`. Use `id` as the key. */
	name: string;
	/**
	 * Unique catalog key. For root/global rules it equals `name`; for a nested
	 * rule it is `<scope>/<name>` (e.g. `apps/web/style`) so same-named rules in
	 * different subtrees coexist. Used for dedup, sticky tracking, and exact
	 * `/rule:` lookup; `@name` mentions still match by the bare `name`.
	 */
	id: string;
	description: string;
	filePath: string;
	/** Directory containing the rule file. */
	baseDir: string;
	source: RuleSource;
	/**
	 * Subtree this rule is scoped to, relative to the project root. Empty
	 * string = whole project (root `.cast/rules` or a global rule). A nested
	 * rule at `apps/web/.cast/rules/*` has scope `apps/web`: its always/auto
	 * injection only fires once a context file under `apps/web/` is seen.
	 */
	scope: string;
	alwaysApply: boolean;
	/** Glob patterns for auto-attach (Cursor-style globs field). */
	globs: string[];
	applyMode: ApplyMode;
}

// ============================================================================
// Paths
// ============================================================================

export function globalRulesDir(): string {
	return join(homedir(), ".cast", "rules");
}

export function projectRulesDir(targetCwd: string): string | undefined {
	const dir = join(targetCwd, ".cast", "rules");
	return dir !== globalRulesDir() ? dir : undefined;
}

/** True if `<cwd>/.cast/rules/` exists and contains at least one .md file. */
export function hasProjectRulesDir(cwd: string): boolean {
	const dir = projectRulesDir(cwd);
	if (!dir || !existsSync(dir)) return false;
	try {
		return readdirSync(dir).some((f) => f.endsWith(".md"));
	} catch {
		return false;
	}
}

// ============================================================================
// .cast/rules/*.md discovery
// ============================================================================

function classifyApplyMode(r: Rule): ApplyMode {
	// Cursor: "If alwaysApply is true, the rule is always included, ignoring
	// other fields."
	if (r.alwaysApply) return "always";
	// Cursor: Auto Attach — alwaysApply=false + globs (file pattern match)
	if (r.globs.length > 0) return "auto";
	// Cursor: Agent Requested — alwaysApply=false + description
	if (r.description) return "lazy";
	// Cursor: Manual — alwaysApply=false, no globs, no description
	return "manual";
}

/** `*.ts, *.tsx` → ["*.ts", "*.tsx"]. A glob never legitimately contains a comma. */
function splitGlobList(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const BOM_RE = /^\uFEFF/;
const SURROUNDING_QUOTES_RE = /^["']|["']$/g;
const FRONTMATTER_LINE_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/**
 * Last-resort reader for frontmatter YAML rejected as invalid.
 *
 * Cursor rule files are flat `key: value` pairs, and the values people write
 * there (`globs: *.tsx`, `globs: src/**\/*.ts,*.md`) are not valid YAML. Losing
 * every field over that is worse than reading the lines directly: quotes are
 * stripped, `true`/`false` become booleans, everything else stays a string.
 */
function parseCursorishFrontmatter(raw: string): Record<string, unknown> {
	const block = FRONTMATTER_BLOCK_RE.exec(raw.replace(BOM_RE, ""));
	if (!block?.[1]) return {};
	const out: Record<string, unknown> = {};
	for (const line of block[1].split("\n")) {
		const match = FRONTMATTER_LINE_RE.exec(line.trim());
		if (!match) continue;
		const key = match[1]!;
		const rawValue = match[2]!.trim().replace(SURROUNDING_QUOTES_RE, "");
		if (rawValue === "true" || rawValue === "false") out[key] = rawValue === "true";
		else if (rawValue) out[key] = rawValue;
	}
	return out;
}

function loadRuleFromFile(filePath: string, source: RuleSource, scope: string): Rule | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const parsed = parseFrontmatter(raw);
	// `globs: *.tsx` is what Cursor's own rule files write, and YAML reads a
	// leading `*` as an alias — so the whole block fails to parse and every
	// field with it. Fall back to reading the fields off the raw lines, which is
	// all a Cursor rule's frontmatter ever is: flat `key: value` pairs.
	const frontmatter = parsed.errors.length > 0 ? parseCursorishFrontmatter(raw) : parsed.frontmatter;
	const name = frontmatter.name && typeof frontmatter.name === "string" ? frontmatter.name : basename(filePath, ".md");
	const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	const alwaysApply = frontmatter["always-apply"] === true || frontmatter.alwaysApply === true;

	// Globs arrive as an inline YAML array ["a", "b"], a single string, or —
	// Cursor's usual shape — one comma-separated string (`*.ts,*.tsx`), which
	// used to be kept whole and could then never match anything.
	let globs: string[] = [];
	const globsVal = frontmatter.globs ?? frontmatter.paths;
	if (Array.isArray(globsVal)) {
		globs = globsVal.flatMap((glob) => (typeof glob === "string" ? splitGlobList(glob) : []));
	} else if (typeof globsVal === "string" && globsVal) {
		globs = splitGlobList(globsVal);
	}

	const rule: Rule = {
		name,
		id: scope ? `${scope}/${name}` : name,
		description,
		filePath,
		baseDir: dirname(filePath),
		source,
		scope,
		alwaysApply,
		globs,
		applyMode: "manual", // overwritten below
	};
	rule.applyMode = classifyApplyMode(rule);
	return rule;
}

function loadRulesFromDir(dir: string, source: RuleSource, scope: string): Rule[] {
	if (!existsSync(dir)) return [];

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const rules: Rule[] = [];
	for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const rule = loadRuleFromFile(join(dir, entry.name), source, scope);
		if (rule) rules.push(rule);
	}
	return rules;
}

/** Directory names never descended into when discovering nested `.cast/rules`. */
const DISCOVERY_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".cast",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"coverage",
	".cache",
	".turbo",
	"vendor",
	".venv",
	"venv",
	"__pycache__",
	"target",
]);

/**
 * Walk `cwd` for every `.cast/rules` directory — the root one plus any nested
 * in subdirectories (Cursor's nested-rules feature). Each is returned with the
 * subtree it scopes (relative to `cwd`, `""` for the root). Bounded by depth
 * and an ignore-list so a large monorepo doesn't pay a full-tree scan.
 */
/**
 * Ceiling on how many directories one discovery pass may look at.
 *
 * The walk is depth-bounded but was otherwise unbounded in width, and it runs
 * on startup *and* on every subagent spawn. A normal project costs nothing
 * (cast's own tree is 68 directories, 13ms), but running cast straight from a
 * home directory — which people do — walked 9,392 of them: 333ms warm, 2s on
 * a cold filesystem cache, repeated per subagent.
 */
const MAX_SCANNED_DIRS = 4000;

export function discoverProjectRuleDirs(cwd: string, maxDepth = 8): Array<{ dir: string; scope: string }> {
	const found: Array<{ dir: string; scope: string }> = [];
	// Breadth-first so the budget spends itself on the levels nearest the root
	// — where rules actually live — instead of exhausting itself down one deep
	// branch. (A single level wider than the budget is still cut mid-level;
	// nothing can be found beyond a ceiling, only spent more usefully.)
	const queue: Array<{ absDir: string; scope: string; depth: number }> = [{ absDir: cwd, scope: "", depth: 0 }];
	let scanned = 0;

	while (queue.length > 0) {
		const { absDir, scope, depth } = queue.shift()!;
		const rulesDir = join(absDir, ".cast", "rules");
		if (existsSync(rulesDir)) found.push({ dir: rulesDir, scope });
		if (depth >= maxDepth || scanned >= MAX_SCANNED_DIRS) continue;

		let entries: Dirent[];
		try {
			entries = readdirSync(absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			if (e.name.startsWith(".") || DISCOVERY_IGNORE_DIRS.has(e.name)) continue;
			if (++scanned > MAX_SCANNED_DIRS) break;
			queue.push({ absDir: join(absDir, e.name), scope: scope ? `${scope}/${e.name}` : e.name, depth: depth + 1 });
		}
	}

	return found;
}

export interface LoadRulesOptions {
	/** `~/.cast/rules` — always loaded (user's own global rules), scope "". */
	globalDir?: string;
	/** A single `<cwd>/.cast/rules` dir loaded flat at scope "" (no nested walk). */
	projectDir?: string;
	/** Project root: when set, discovers the root plus all nested `.cast/rules`
	 * (each scoped to its subtree). Takes precedence over `projectDir`. */
	projectCwd?: string;
}

/**
 * Load rules from .cast/rules/ directories. Returns the full list; callers
 * split by applyMode. Rules are keyed by `id` (scope-qualified), so a nested
 * `apps/web/style` and a root `style` coexist; within one scope, project beats
 * global and the first-loaded file wins.
 */
export function loadDirectoryRules(options: LoadRulesOptions): Rule[] {
	const ruleMap = new Map<string, Rule>();

	function addAll(rules: Rule[]) {
		for (const rule of rules) {
			if (ruleMap.has(rule.id)) continue; // first-loaded wins
			ruleMap.set(rule.id, rule);
		}
	}

	// project > global (same priority as skills). Nested project dirs are
	// discovered when projectCwd is given; otherwise fall back to the flat dir.
	if (options.projectCwd) {
		for (const { dir, scope } of discoverProjectRuleDirs(options.projectCwd)) {
			addAll(loadRulesFromDir(dir, "project", scope));
		}
	} else if (options.projectDir) {
		addAll(loadRulesFromDir(options.projectDir, "project", ""));
	}
	if (options.globalDir) addAll(loadRulesFromDir(options.globalDir, "global", ""));

	return Array.from(ruleMap.values());
}

// ============================================================================
// Glob matching — simplified port of coddy's MatchesAny
// ============================================================================

/**
 * Convert a glob pattern to a regex source. A lone `*` does not cross
 * path separators; a double star matches across them.
 *
 * The double-star-slash pattern (e.g. `src/components/[star][star]/[star].tsx`)
 * matches zero or more intermediate segments, so it finds both
 * `src/components/App.tsx` and `src/components/foo/Bar.tsx`.
 */
function globToRegExpSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				i++;
				// Double-star-slash matches zero or more path segments.
				// Double-star at end matches everything remaining.
				if (glob[i + 1] === "/") {
					i++;
					out += "(.*\\/)?";
				} else if (i === glob.length - 1) {
					out += ".*";
				} else {
					out += ".*";
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(REGEX_SPECIAL_CHARS_RE, "\\$&");
		}
	}
	return out;
}

/** Check if a file path matches a glob pattern. */
export function fileMatchesGlob(pattern: string, filePath: string): boolean {
	// Try full path match
	const re = new RegExp(`^${globToRegExpSource(pattern)}$`);
	if (re.test(filePath)) return true;
	// Try basename match for `**/*.ext` patterns
	const simplePattern = pattern.startsWith("**/") ? pattern.slice(3) : pattern;
	const simpleRe = new RegExp(`^${globToRegExpSource(simplePattern)}$`);
	const base = filePath.split("/").pop() ?? filePath;
	if (simpleRe.test(base)) return true;
	// Try the simplified pattern against the full path
	return simpleRe.test(filePath);
}

/**
 * Check if any context file matches any of the rule's globs.
 *
 * Context files are relative to the project root, but a nested rule's globs are
 * written relative to the rule's own subtree — `apps/web/.cast/rules/style.md`
 * saying `globs: src/**\/*.ts` means `apps/web/src/**\/*.ts`. Matching only
 * against the root-relative path made every path-shaped glob in a nested rule
 * dead: it could not match `apps/web/src/a.ts` (the prefix is missing from the
 * pattern) and files outside the subtree are already excluded by the scope
 * gate. Each file is therefore tried root-relative *and* scope-relative; a
 * basename-shaped glob (`*.ts`) matched either way and is unaffected.
 */
export function matchesRuleGlobs(r: Rule, contextFiles: string[]): boolean {
	if (r.globs.length === 0) return false;
	const prefix = r.scope ? `${r.scope}/` : "";
	for (const pattern of r.globs) {
		for (const file of contextFiles) {
			if (fileMatchesGlob(pattern, file)) return true;
			if (prefix && file.startsWith(prefix) && fileMatchesGlob(pattern, file.slice(prefix.length))) return true;
		}
	}
	return false;
}

// ============================================================================
// Auto rule selection (sticky + glob-aware)
// ============================================================================

/**
 * True if the rule's scope subtree contains at least one of the context files.
 * An unscoped rule (scope `""` — root or global) always passes. A nested rule
 * only passes once a file under its subtree is in context.
 */
export function ruleScopeActive(scope: string, contextFiles: string[]): boolean {
	if (!scope) return true;
	const prefix = `${scope}/`;
	return contextFiles.some((f) => f === scope || f.startsWith(prefix));
}

/**
 * Returns rules that should auto-apply this turn.
 * - always mode: included whenever its scope is active (unscoped ⇒ always)
 * - auto mode: included when its scope is active AND a context file matches globs
 *
 * Nested rules stay dormant until a file from their subtree enters context —
 * that's the whole point of Cursor's nested rules.
 */
export function matchAutoRules(catalog: Rule[], contextFiles: string[]): Rule[] {
	const out: Rule[] = [];
	for (const r of catalog) {
		if (!ruleScopeActive(r.scope, contextFiles)) continue;
		if (r.applyMode === "always") {
			out.push(r);
		} else if (r.applyMode === "auto" && matchesRuleGlobs(r, contextFiles)) {
			out.push(r);
		}
	}
	return out;
}

/**
 * Merge newly matched auto rules into sticky set by id.
 * Once a rule is sticky, it stays for the rest of the session.
 */
export function unionStickyRules(sticky: Rule[], newly: Rule[]): Rule[] {
	if (newly.length === 0) return sticky;
	const seen = new Set(sticky.map((r) => r.id));
	const out = [...sticky];
	for (const r of newly) {
		if (!seen.has(r.id)) {
			seen.add(r.id);
			out.push(r);
		}
	}
	return out;
}

// ============================================================================
// @-mention selection
// ============================================================================

const AT_MENTION_RE = /(?:^|[\s([{])@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g;

/**
 * Extract @ruleName tokens from user text (skips code fences).
 */
export function parseAtMentions(text: string): string[] {
	const lines = text.split("\n");
	let inFence = false;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of lines) {
		const trim = raw.trim();
		if (trim.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		for (const m of raw.matchAll(AT_MENTION_RE)) {
			const name = m[1]!;
			if (!seen.has(name)) {
				seen.add(name);
				out.push(name);
			}
		}
	}
	return out;
}

/**
 * Return non-always rules referenced via @name in userText. Matching is by the
 * bare `name` (the @-mention grammar has no `/`), so a name shared across
 * subtrees pulls in every scope's copy; results are deduped by `id`.
 */
export function selectMentionedRules(catalog: Rule[], userText: string): Rule[] {
	const names = new Set(parseAtMentions(userText).map((n) => n.toLowerCase()));
	if (names.size === 0) return [];
	const out: Rule[] = [];
	const seen = new Set<string>();
	for (const r of catalog) {
		if (r.applyMode === "always") continue; // always rules are already injected
		if (!names.has(r.name.toLowerCase())) continue;
		if (seen.has(r.id)) continue;
		seen.add(r.id);
		out.push(r);
	}
	return out;
}

// ============================================================================
// System prompt injection
// ============================================================================

function escapeXml(str: string): string {
	return str
		.replace(AMP_RE, "&amp;")
		.replace(LT_RE, "&lt;")
		.replace(GT_RE, "&gt;")
		.replace(QUOTE_RE, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Format always-apply rules for direct injection into the system prompt.
 * Returns an empty string when there are none.
 */
export function formatAlwaysApplyRules(rules: Rule[]): string {
	const parts = renderRuleBodies(rules.filter((r) => r.applyMode === "always"));
	if (parts.length === 0) return "";
	return `\n\n<rules>\n${parts.join("\n\n")}\n</rules>`;
}

/**
 * Ceiling on one rule's injected body.
 *
 * An always-apply rule is pasted into the system prompt on *every* request, so
 * its size is a per-turn tax paid for the life of the session. Nothing bounded
 * it: a 3MB file went in whole — about 750k tokens, past most context windows
 * and expensive in the ones it fits. 64KB is roughly 16k tokens, far more than
 * any instruction needs, and the truncation says so in-band so neither the
 * model nor the user is left thinking they read the whole rule.
 */
export const MAX_RULE_BODY_CHARS = 64 * 1024;

function clampRuleBody(body: string, filePath: string): string {
	if (body.length <= MAX_RULE_BODY_CHARS) return body;
	return `${body.slice(0, MAX_RULE_BODY_CHARS)}\n\n[Rule truncated at ${MAX_RULE_BODY_CHARS} characters — ${filePath} is ${body.length} characters. Split it into focused rules, or have the model read the file when it needs the rest.]`;
}

/** Read each rule's body (frontmatter stripped), dropping empty/unreadable ones. */
function renderRuleBodies(rules: Rule[]): string[] {
	const parts: string[] = [];
	for (const rule of rules) {
		try {
			const { body } = parseFrontmatter(readFileSync(rule.filePath, "utf-8"));
			if (body.trim()) parts.push(clampRuleBody(body.trim(), rule.filePath));
		} catch {
			// Unreadable — skip.
		}
	}
	return parts;
}

/**
 * Build the complete `<rules>` section for a single turn: the sticky set
 * (auto-attached rules, plus always-apply rules once their scope is active —
 * see matchAutoRules, which scope-gates both the same way and is what feeds
 * `sticky`) followed by any @-mentioned rules, deduplicated by id. A
 * root-scope (unscoped) always-apply rule is active from the very first
 * turn regardless of contextFiles, since `ruleScopeActive("", ...)` is
 * unconditionally true — so it reaches `sticky` on turn one and never drops
 * out. Returns "" when nothing applies.
 */
export function formatRulesForTurn(sticky: Rule[], mentioned: Rule[]): string {
	const seen = new Set<string>();
	const ordered: Rule[] = [];
	const add = (r: Rule) => {
		if (seen.has(r.id)) return;
		seen.add(r.id);
		ordered.push(r);
	};
	for (const r of sticky) add(r);
	for (const r of mentioned) add(r);

	const parts = renderRuleBodies(ordered);
	if (parts.length === 0) return "";
	return `\n\n<rules>\n${parts.join("\n\n")}\n</rules>`;
}

/**
 * Format lazy (description-only) rules for the system prompt. The model
 * sees name + description and uses the read tool to load the full content
 * when relevant — same pattern as skills.
 */
export function formatLazyRulesForPrompt(rules: Rule[]): string {
	const lazy = rules.filter((r) => r.applyMode === "lazy");
	if (lazy.length === 0) return "";

	const lines = ["", "", RULES_INSTRUCTIONS, "", "<available_rules>"];
	for (const rule of lazy) {
		lines.push("  <rule>");
		lines.push(`    <name>${escapeXml(rule.name)}</name>`);
		lines.push(`    <description>${escapeXml(rule.description)}</description>`);
		lines.push(`    <location>${escapeXml(rule.filePath)}</location>`);
		lines.push("  </rule>");
	}
	lines.push("</available_rules>");
	return lines.join("\n");
}

/** Read a rule's body (frontmatter stripped) for /rule:name invocation. */
export function readRuleBody(rule: Rule): string {
	return parseFrontmatter(readFileSync(rule.filePath, "utf-8")).body;
}

/**
 * Format a rule's full content for /rule:name invocation.
 *
 * The catalog is built once per turn, so by the time someone types
 * `/rule:name` the file may be gone — uninstalled, a worktree switch, a branch
 * that never had it. That used to throw ENOENT out of the command handler
 * (unhandled in the TUI, a failed command over the bridge); it is reported as
 * a rule problem instead.
 */
export function formatRuleInvocation(rule: Rule): string {
	let content: string;
	try {
		content = clampRuleBody(readRuleBody(rule), rule.filePath);
	} catch {
		return `<rule name="${escapeXml(rule.name)}" location="${escapeXml(rule.filePath)}">\nThis rule's file could not be read (it may have been moved or deleted). Continue without it, and mention that it was unavailable.\n</rule>`;
	}
	return `<rule name="${escapeXml(rule.name)}" location="${escapeXml(rule.filePath)}">\nReferences are relative to ${rule.baseDir}.\n\n${content}\n</rule>`;
}
