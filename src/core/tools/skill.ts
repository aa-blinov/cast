/**
 * Skill tool — dedicated tool for loading and invoking skills.
 * Replaces the model using the generic `read` tool to load skill files.
 * Handles $ARGUMENTS, ${CLAUDE_SKILL_DIR} substitution automatically.
 */

const TOOL_LIST_SPLIT_RE = /[\s,]+/;

import type { Skill } from "../skills.ts";
import { type InlineCommandGate, renderSkillInvocation } from "../skills.ts";
import { skillsShInstall } from "../skills-sh.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

export interface SkillToolDeps {
	skills: Skill[];
	/** Project root, for the skill body's `${CLAUDE_PROJECT_DIR}`. */
	cwd?: string;
	/** Gate for the body's inline `` !`command` `` blocks — the same read-only
	 * and dangerous-pattern checks the bash tool applies. */
	inlineGate?: InlineCommandGate;
	/** Current session id — substituted into ${CAST_SESSION_ID} / ${CLAUDE_SESSION_ID} in the skill body. */
	sessionId?: string;
	/** Re-reads the skills this run may use from disk. When set, a skill
	 *  installed mid-turn (by skill_install, or by hand through bash) can be
	 *  loaded in the same turn, and skill_install is offered at all. */
	reload?: () => Skill[];
	/** Told after skill_install changed the installed set, so a host can
	 *  refresh what it shows (the web composer's slash commands). */
	onSkillsChanged?: () => void;
}

/** Swaps the fresh list into deps.skills in place: the executor hands each
 *  call a shallow copy of the deps, so the array is what they share. */
function reloadSkills(deps: SkillToolDeps): boolean {
	const fresh = deps.reload?.();
	if (!fresh) return false;
	deps.skills.splice(0, deps.skills.length, ...fresh);
	return true;
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

	// Not in the list the turn started with: it may have been installed since.
	const skill =
		deps.skills.find((s) => s.name === name) ??
		(reloadSkills(deps) ? deps.skills.find((s) => s.name === name) : undefined);
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

export const SKILL_INSTALL_TOOL_DESCRIPTION =
	"Install an Agent Skill from skills.sh (a GitHub repo of skills) when the user asks for one. It is installed globally, so every project sees it, and it can be loaded with the skill tool in this same turn; the user can also run it as /skill:<name>. `source` is `owner/repo`, a github.com URL, or a pasted `npx skills add …` line.";

/** Installs a skill through skills.sh (see skillsShInstall: always the global,
 *  universal scope, non-interactive) and makes it usable right away. It pulls
 *  third-party code that can carry inline commands and hooks, so it is asked
 *  like a dangerous bash command. */
export async function execSkillInstall(
	args: Record<string, unknown>,
	deps: SkillToolDeps,
	confirm?: ConfirmBash,
): Promise<ToolResult> {
	const source = typeof args.source === "string" ? args.source.trim() : "";
	const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
	if (!source)
		return {
			content: 'Error: "source" is required (owner/repo, a github.com URL, or an npx skills add line).',
			isError: true,
		};
	const input = skillName ? `${source} --skill ${skillName}` : source;
	if (confirm && !(await confirm(`npx skills add ${input} -g`, "installs a third-party skill from the internet"))) {
		return { content: "Blocked: the user did not confirm installing this skill.", isError: true };
	}

	const before = new Set(deps.skills.map((s) => s.name));
	let output: string;
	try {
		output = await skillsShInstall(input);
	} catch (error) {
		return {
			content: `skills.sh install failed: ${error instanceof Error ? error.message : String(error)}`,
			isError: true,
		};
	}
	reloadSkills(deps);
	deps.onSkillsChanged?.();
	const added = deps.skills.filter((s) => !before.has(s.name));
	if (added.length === 0) {
		return {
			content: `${output}\n\nNo new skill became available. It may have been installed already, be disabled in settings, or be outside what this persona may use.`,
		};
	}
	const names = added.map((s) => s.name);
	return {
		content: `Installed ${names.join(", ")}. Load it now with the skill tool (name: "${names[0]}"); the user can also run /skill:${names[0]}.\n\n${output}`,
	};
}
