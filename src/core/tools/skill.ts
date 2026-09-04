/**
 * Skill tool — dedicated tool for loading and invoking skills.
 * Replaces the model using the generic `read` tool to load skill files.
 * Handles $ARGUMENTS, ${CLAUDE_SKILL_DIR} substitution automatically.
 */

const TOOL_LIST_SPLIT_RE = /[\s,]+/;

import type { Skill } from "../skills.ts";
import { type InlineCommandGate, renderSkillInvocation } from "../skills.ts";
import type { ToolResult } from "./shared.ts";

export interface SkillToolDeps {
	skills: Skill[];
	/** Project root, for the skill body's `${CLAUDE_PROJECT_DIR}`. */
	cwd?: string;
	/** Gate for the body's inline `` !`command` `` blocks — the same read-only
	 * and dangerous-pattern checks the bash tool applies. */
	inlineGate?: InlineCommandGate;
	/** Current session id — substituted into ${CAST_SESSION_ID} / ${CLAUDE_SESSION_ID} in the skill body. */
	sessionId?: string;
}

export function getSkillToolDescription(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const names = skills.map((s) => s.name).join(", ");
	return `Load a specialized skill by name. Skills contain detailed workflows and instructions for specific tasks. Available skills: ${names}. Call this tool when the user's request matches a skill's description, or when the user invokes /skill:name.`;
}

export async function execSkill(args: Record<string, unknown>, deps: SkillToolDeps): Promise<ToolResult> {
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
		// Registered by the loop for the rest of the run — a skill whose whole
		// point is "check X after every edit" is inert without them.
		return {
			content: await renderSkillInvocation(skill, userArgs, deps.sessionId, {
				projectDir: deps.cwd,
				gate: deps.inlineGate,
			}),
			...(disallowed?.length ? { skillDisallowedTools: disallowed } : {}),
			...(skill.hooks ? { skillHooks: skill.hooks } : {}),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			content: `Error: skill "${name}" could not be loaded — its file at ${skill.filePath} is unreadable (${reason}). It may have been uninstalled or moved; continue without it, or ask the user to reinstall it.`,
			isError: true,
		};
	}
}
