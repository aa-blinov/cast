/**
 * Subagent prompts — dedicated system prompts for worker agents spawned by
 * the `task` tool. Same frontmatter format as personas (name, label,
 * description, tools, agentsMd, readOnly). Loaded from the builtin
 * `prompts/subagents/`, then `~/.cast/subagents/`, then a trusted project's
 * `.cast/subagents/`; a later source replaces a same-named earlier one.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseAgentsMd, parseFrontmatter, parseToolsAllowlist } from "./frontmatter.ts";
import { promptsDir, withSharedToolPrompt } from "./prompts.ts";

export interface SubagentPrompt {
	name: string;
	label: string;
	description: string;
	systemPrompt: string;
	/**
	 * Optional allowlist for built-in tools from frontmatter
	 * (`tools: [read, grep, plan_*, web_*]`). Exact names or `*`-globs.
	 * `undefined` = all builtins; when set, only matching builtin names are
	 * advertised and executable. Connected MCP tools are never filtered here.
	 */
	tools?: string[];
	/**
	 * Whether to inject AGENTS.md / CLAUDE.md into the subagent system prompt.
	 * Defaults to true; set `agentsMd: false` in frontmatter to disable.
	 */
	agentsMd: boolean;
	/** `readOnly: true`: the child gets no write/edit and inspection-only bash —
	 *  enforced by the harness, not just asked for in the prompt. */
	readOnly?: boolean;
	source?: "builtin" | "global" | "project";
}

const SUBAGENTS_DIR = join(promptsDir, "subagents");

function loadSubagentFromFile(filePath: string, source: SubagentPrompt["source"]): SubagentPrompt | null {
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
		// Same shared error-handling + file-tool contract as personas — workers
		// use the same read/edit/find tools and must not invent a different
		// workflow. The allowlist goes in so a read-only subagent doesn't carry
		// the edit contract.
		systemPrompt: withSharedToolPrompt(body, parseToolsAllowlist(frontmatter)),
		tools: parseToolsAllowlist(frontmatter),
		agentsMd: parseAgentsMd(frontmatter),
		...(frontmatter.readOnly === true ? { readOnly: true } : {}),
		source,
	};
}

function loadDir(dir: string, source: SubagentPrompt["source"]): SubagentPrompt[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".md"));
	} catch {
		return [];
	}
	return files.map((f) => loadSubagentFromFile(join(dir, f), source)).filter((p): p is SubagentPrompt => p !== null);
}

/**
 * All subagent prompts, sorted by name. Project ones load only for a trusted
 * project, like every other project resource. Missing directories are fine.
 */
export function loadSubagentPrompts(opts: { cwd?: string; projectTrusted?: boolean } = {}): SubagentPrompt[] {
	const globalDir = join(homedir(), ".cast", "subagents");
	const projectDir = opts.cwd ? resolve(opts.cwd, ".cast", "subagents") : undefined;
	const byName = new Map<string, SubagentPrompt>();
	for (const p of [
		...loadDir(SUBAGENTS_DIR, "builtin"),
		...loadDir(globalDir, "global"),
		...(projectDir && opts.projectTrusted && projectDir !== globalDir ? loadDir(projectDir, "project") : []),
	]) {
		byName.set(p.name, p);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Find a subagent prompt by name. Falls back to undefined if not found.
 */
export function findSubagentPrompt(name: string, all: SubagentPrompt[]): SubagentPrompt | undefined {
	return all.find((p) => p.name === name);
}
