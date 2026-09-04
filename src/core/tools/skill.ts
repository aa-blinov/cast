/**
 * Skill tool — dedicated tool for loading and invoking skills.
 * Replaces the model using the generic `read` tool to load skill files.
 * Handles $ARGUMENTS, ${CLAUDE_SKILL_DIR} substitution automatically.
 */

import { dirname } from "node:path";

const TOOL_LIST_SPLIT_RE = /[\s,]+/;

import type { Skill } from "../skills.ts";
import { formatSkillInvocation } from "../skills.ts";
import type { ToolResult } from "./shared.ts";

export interface SkillToolDeps {
	skills: Skill[];
	/** Project root, for the skill body's `${CLAUDE_PROJECT_DIR}`. */
	cwd?: string;
	/** Current session id — substituted into ${CAST_SESSION_ID} / ${CLAUDE_SESSION_ID} in the skill body. */
	sessionId?: string;
}

/** A plugin skill's install root: skills live at `<root>/skills/<name>/`, so
 * the root is two levels up from the skill directory. `${CLAUDE_PLUGIN_ROOT}`
 * is how a plugin skill reaches scripts shared across the plugin. */
function pluginRootFor(skill: Skill): string | undefined {
	if (skill.source !== "plugin") return undefined;
	const skillsDir = dirname(skill.baseDir);
	return dirname(skillsDir).endsWith("skills") ? dirname(skillsDir) : dirname(skillsDir);
}

export function getSkillToolDescription(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const names = skills.map((s) => s.name).join(", ");
	return `Load a specialized skill by name. Skills contain detailed workflows and instructions for specific tasks. Available skills: ${names}. Call this tool when the user's request matches a skill's description, or when the user invokes /skill:name.`;
}

export function execSkill(args: Record<string, unknown>, deps: SkillToolDeps): ToolResult {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	const userArgs = typeof args.args === "string" ? args.args : undefined;

	if (!name) {
		return { content: "Error: skill name is required.", isError: true };
	}

	const skill = deps.skills.find((s) => s.name === name);
	if (!skill) {
		const available = deps.skills.map((s) => s.name).join(", ");
		return {
			content: `Error: skill "${name}" not found. Available skills: ${available}`,
			isError: true,
		};
	}

	if (skill.disableModelInvocation) {
		return {
			content: `Error: skill "${name}" is not available for model invocation. It can only be invoked by the user with /skill:${name}.`,
			isError: true,
		};
	}

	// The body is usually cached at discovery time, but not always — and the
	// file can be gone by now (the skill was uninstalled, the worktree
	// switched, the repo moved). Reading it then threw ENOENT out of the tool,
	// which the dispatcher reports as "skill failed unexpectedly: ENOENT: no
	// such file or directory…" — true, but it tells the model nothing about
	// what to do. Say what happened instead.
	try {
		const disallowed = skill.disallowedTools?.split(TOOL_LIST_SPLIT_RE).filter(Boolean);
		return {
			content: formatSkillInvocation(skill, userArgs, deps.sessionId, {
				projectDir: deps.cwd,
				pluginRoot: pluginRootFor(skill),
			}),
			...(disallowed?.length ? { skillDisallowedTools: disallowed } : {}),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			content: `Error: skill "${name}" could not be loaded — its file at ${skill.filePath} is unreadable (${reason}). It may have been uninstalled or moved; continue without it, or ask the user to reinstall it.`,
			isError: true,
		};
	}
}
