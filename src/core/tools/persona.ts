import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { globalPersonasDir, loadPersonaFromFile, type Persona } from "../personas.ts";
import { projectPersonasDir, resolvePersonasForCwd } from "../project.ts";
import type { ConfirmWrite, ToolResult } from "./shared.ts";

export interface PersonaToolDeps {
	cwd: string;
	/** Project personas are trust-gated like every other project resource. */
	projectTrusted: boolean;
	confirmWrite?: ConfirmWrite;
	/** Told after a persona was written, so the host refreshes its persona
	 *  lists and, when asked, switches to it: in a new session, or in this one
	 *  from the next turn. */
	onPersonaCreated: (persona: Persona, activate: PersonaActivation | undefined) => void;
}

/** "new": a fresh session with the persona (the default — another role's
 *  history, with tool calls it can't make, only muddles the new one).
 *  "here": this session carries on as it, for work on the current context. */
export type PersonaActivation = "new" | "here";

const PERSONA_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const PERSONA_CREATE_TOOL_DESCRIPTION = `Create or update a persona: a named role with its own system prompt and, optionally, limits on the tools, skills and MCP servers it may use.
The persona is available right away — in /persona, the persona pickers and new sessions.
To use it now, set activate: "new" opens a fresh session with it once this turn ends (the usual choice: a clean context for a new role); "here" keeps this session and runs as it from the next turn — only when the user wants the persona to work on the current conversation.
Use when the user asks for a new persona, role or assistant style, or to change one. Write the prompt as the persona's full system prompt in the second person ("You are…"); it replaces the current one when active, so include everything the role needs.
Omit tools/skills/mcp to allow everything; pass [] to allow nothing (a conversation-only persona).`;

function stringList(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
		throw new Error(`${field} must be a list of names`);
	}
	return (value as string[]).map((v) => v.trim()).filter(Boolean);
}

export async function execPersonaCreate(args: Record<string, unknown>, deps: PersonaToolDeps): Promise<ToolResult> {
	const name = typeof args.name === "string" ? args.name.trim() : "";
	const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
	if (!PERSONA_NAME_RE.test(name)) {
		return { content: "name must be lowercase letters, digits and dashes (e.g. code-reviewer).", isError: true };
	}
	if (!prompt) return { content: "prompt (the persona's system prompt) is required.", isError: true };
	const scope = args.scope === "project" ? "project" : "global";
	if (scope === "project" && !deps.projectTrusted) {
		return { content: "This project isn't trusted, so it can't hold personas. Use scope: global.", isError: true };
	}

	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = {
			name,
			label: typeof args.label === "string" && args.label.trim() ? args.label.trim() : name,
			description: typeof args.description === "string" ? args.description.trim() : "",
			...(args.tools !== undefined ? { tools: stringList(args.tools, "tools") } : {}),
			...(args.skills !== undefined ? { skills: stringList(args.skills, "skills") } : {}),
			...(args.mcp !== undefined ? { mcp: stringList(args.mcp, "mcp") } : {}),
			...(typeof args.subagents === "boolean" ? { subagents: args.subagents } : {}),
			...(typeof args.agentsMd === "boolean" ? { agentsMd: args.agentsMd } : {}),
			...(typeof args.model === "string" && args.model.trim() ? { model: args.model.trim() } : {}),
		};
	} catch (error) {
		return { content: error instanceof Error ? error.message : String(error), isError: true };
	}

	const dir = scope === "project" ? projectPersonasDir(deps.cwd) : globalPersonasDir();
	if (!dir) return { content: "No project persona directory here. Use scope: global.", isError: true };
	const filePath = join(dir, `${name}.md`);
	const existing = resolvePersonasForCwd(deps.cwd, deps.projectTrusted).personas.find((p) => p.name === name);
	if ((existsSync(filePath) || existing) && args.overwrite !== true) {
		const where = existing ? `a ${existing.source} persona (${existing.filePath})` : filePath;
		return {
			content: `A persona named "${name}" already exists: ${where}. Pass overwrite: true to replace or override it, or pick another name.`,
			isError: true,
		};
	}

	if (deps.confirmWrite && !(await deps.confirmWrite("persona_create", filePath, `save persona "${name}"`))) {
		return { content: "The user declined saving this persona.", isError: true };
	}

	const content = `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${prompt}\n`;
	mkdirSync(dir, { recursive: true });
	// Written beside and renamed over, so a persona list read mid-write never
	// sees half a file (or loses the old one to a failed write).
	const tmp = `${filePath}.tmp-${process.pid}`;
	writeFileSync(tmp, content, "utf-8");
	const persona = loadPersonaFromFile(tmp, scope);
	if (!persona) {
		rmSync(tmp, { force: true });
		return { content: "The persona file didn't load back; nothing was saved.", isError: true };
	}
	renameSync(tmp, filePath);
	const saved = { ...persona, filePath };

	const activate: PersonaActivation | undefined =
		args.activate === "here" ? "here" : args.activate === "new" || args.activate === true ? "new" : undefined;
	deps.onPersonaCreated(saved, activate);
	const next =
		activate === "new"
			? "A new session with it opens when this turn ends."
			: activate === "here"
				? "This session switches to it from the next turn."
				: `Available now: /persona ${name} switches to it.`;
	return { content: `Saved persona "${name}" (${saved.label}) to ${filePath}. ${next}` };
}
