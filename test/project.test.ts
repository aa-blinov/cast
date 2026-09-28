import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Persona } from "../src/core/personas.ts";
import {
	buildSystemPrompt,
	discoverSkillsForCwd,
	formatSystemEnvironmentBlock,
	type ProjectResolverDeps,
} from "../src/core/project.ts";

const persona = (source: string, filePath: string) =>
	({ name: "p", label: "P", source, filePath, body: "" }) as unknown as Persona;

describe("formatSystemEnvironmentBlock", () => {
	it("names a user persona's file, but not a builtin's, which lives in cast's install", () => {
		const user = formatSystemEnvironmentBlock("/work", { persona: persona("global", "/home/u/.cast/personas/p.md") });
		expect(user).toContain("Persona file: /home/u/.cast/personas/p.md");
		const builtin = formatSystemEnvironmentBlock("/work", {
			persona: persona("builtin", "/opt/cast/prompts/personas/p.md"),
		});
		expect(builtin).not.toContain("/opt/cast");
		expect(builtin).toContain("Persona source: builtin");
		expect(builtin).toContain("Current working directory: /work");
	});
});

describe("buildSystemPrompt", () => {
	const withTools = (tools?: string[]) =>
		({ name: "p", label: "P", source: "global", systemPrompt: "BODY", agentsMd: false, tools }) as unknown as Persona;

	it("lists skills only to a persona that has the skill tool", () => {
		const listing = "\n<available_skills>x</available_skills>";
		expect(buildSystemPrompt(withTools(), "", "", "", listing, "", "/w")).toContain("<available_skills>");
		expect(buildSystemPrompt(withTools(["read", "skill"]), "", "", "", listing, "", "/w")).toContain(
			"<available_skills>",
		);
		expect(buildSystemPrompt(withTools(["read", "grep"]), "", "", "", listing, "", "/w")).not.toContain(
			"<available_skills>",
		);
	});
});

describe("discoverSkillsForCwd with Claude Code skills", () => {
	let home: string;
	let realHome: string | undefined;
	const deps = { noSkills: false, noMcp: false, cliSkillPaths: [], cliMcpPaths: [] } as unknown as ProjectResolverDeps;
	const skill = (dir: string, name: string) => {
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`);
	};
	beforeEach(() => {
		realHome = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "cast-claude-skills-"));
		process.env.HOME = home;
		skill(join(home, ".claude", "skills"), "from-claude-home");
		skill(join(home, "proj", ".claude", "skills"), "from-claude-project");
	});
	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
	});

	const names = (trusted: boolean) => discoverSkillsForCwd(deps, join(home, "proj"), trusted).map((s) => s.name);

	it("loads ~/.claude/skills always, and a project's .claude/skills only once it is trusted", () => {
		expect(names(false)).toContain("from-claude-home");
		expect(names(false)).not.toContain("from-claude-project");
		expect(names(true)).toContain("from-claude-project");
	});

	it("drops a whole source family switched off in settings", () => {
		mkdirSync(join(home, ".cast"), { recursive: true });
		writeFileSync(
			join(home, ".cast", "settings.json"),
			JSON.stringify({ disabledSkillSources: ["claude", "builtin"] }),
		);
		const loaded = discoverSkillsForCwd(deps, join(home, "proj"), true);
		expect(loaded.some((s) => s.source === "claude")).toBe(false);
		expect(loaded.some((s) => s.source === "builtin")).toBe(false);
	});
});
