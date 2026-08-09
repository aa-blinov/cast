/**
 * YAML frontmatter parser shared by skills.ts, personas.ts, and rules.ts.
 * Agent Skills requires nested `metadata` mappings, so a line-oriented parser
 * would silently lose valid standard fields.
 */

import { parseDocument } from "yaml";

const REGEX_SPECIAL_CHAR_RE = /[.+?^${}()|[\]\\]/;
const BOM_LEADING_RE = /^\uFEFF/;
const CRLF_RE = /\r\n/g;
const LEADING_NEWLINE_RE = /^\n/;
const CLOSING_FRONTMATTER_RE = /^---[ \t]*$(?:\n|$)/m;

export interface FrontmatterMap {
	[key: string]: FrontmatterValue;
}

export interface FrontmatterList extends Array<FrontmatterValue> {}

export type FrontmatterValue = string | number | boolean | null | FrontmatterList | FrontmatterMap;

export interface ParsedFrontmatter {
	frontmatter: FrontmatterMap;
	body: string;
	/** YAML syntax and shape errors. Callers decide whether an invalid file is fatal. */
	errors: string[];
}

/**
 * Optional tool allowlist from persona/subagent frontmatter.
 * `undefined` = field omitted → all tools available.
 * `[]` = explicitly empty → no tools.
 * Non-array values are treated as omitted (all tools).
 * Entries may be exact names (`read`) or `*`-globs (`plan_*`, `web_*`).
 */
export function parseToolsAllowlist(frontmatter: Record<string, FrontmatterValue>): string[] | undefined {
	const value = frontmatter.tools;
	if (!Array.isArray(value)) return undefined;
	return (
		value
			.map((s) => String(s).trim())
			.filter(Boolean)
			// Pre-0.6.12 name — keep old persona frontmatter working.
			.map((s) => (s === "find" ? "glob" : s))
	);
}

/**
 * Same allowlist semantics as `parseToolsAllowlist` (undefined = omitted →
 * no restriction, `[]` = explicitly nothing allowed, exact names or
 * `*`-globs) for any other persona frontmatter field that names things by
 * a list — `skills:`, `mcp:`, `subagentTypes:`. Kept generic instead of one
 * copy-pasted parser per field.
 */
export function parseNameAllowlist(frontmatter: Record<string, FrontmatterValue>, field: string): string[] | undefined {
	const value = frontmatter[field];
	if (!Array.isArray(value)) return undefined;
	return value.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Whether a builtin tool name is covered by a persona/subagent `tools:` list.
 * Exact match, or shell-style `*` globs (`plan_*` → `plan_done`, `web_*` →
 * `web_search`, `*` → everything).
 */
export function matchesToolsAllowlist(name: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (pattern === name) return true;
		if (!pattern.includes("*")) continue;
		let body = "";
		for (const ch of pattern) {
			if (ch === "*") body += ".*";
			else if (REGEX_SPECIAL_CHAR_RE.test(ch)) body += `\\${ch}`;
			else body += ch;
		}
		if (new RegExp(`^${body}$`).test(name)) return true;
	}
	return false;
}

/**
 * Whether AGENTS.md / CLAUDE.md project context should be injected.
 * Defaults to true; only an explicit `agentsMd: false` disables it.
 */
export function parseAgentsMd(frontmatter: Record<string, FrontmatterValue>): boolean {
	return frontmatter.agentsMd !== false;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	// Strip a UTF-8 BOM: Windows editors (Notepad, PowerShell Out-File) prepend
	// one, and `﻿---` failing the startsWith check silently discarded the
	// whole frontmatter — a skill would load with no name or description.
	const normalized = content.replace(BOM_LEADING_RE, "").replace(CRLF_RE, "\n");
	if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized, errors: [] };

	const closing = CLOSING_FRONTMATTER_RE.exec(normalized.slice(4));
	if (!closing || closing.index === undefined) return { frontmatter: {}, body: normalized, errors: [] };

	const yamlBlock = normalized.slice(4, 4 + closing.index);
	const body = normalized.slice(4 + closing.index + closing[0].length).replace(LEADING_NEWLINE_RE, "");
	const document = parseDocument(yamlBlock, { prettyErrors: false, uniqueKeys: true });
	const errors = document.errors.map((error) => error.message);
	if (errors.length > 0) return { frontmatter: {}, body, errors };

	const value = document.toJS();
	if (value === null || value === undefined) return { frontmatter: {}, body, errors: [] };
	if (typeof value !== "object" || Array.isArray(value)) {
		return { frontmatter: {}, body, errors: ["frontmatter must be a YAML mapping"] };
	}
	return { frontmatter: value as Record<string, FrontmatterValue>, body, errors: [] };
}
