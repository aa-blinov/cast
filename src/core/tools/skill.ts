/**
 * Skill tool — dedicated tool for loading and invoking skills.
 * Replaces the model using the generic `read` tool to load skill files.
 * Handles $ARGUMENTS, ${CLAUDE_SKILL_DIR} substitution automatically.
 */

import type { Skill } from "../skills.ts";
import { formatSkillInvocation } from "../skills.ts";
import type { ToolResult } from "./shared.ts";

export interface SkillToolDeps {
	skills: Skill[];
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

	const content = formatSkillInvocation(skill, userArgs);
	return { content };
}
