/**
 * Live checks against ~/.agents/skills (skills.sh installs) plus merge /
 * disable / uninstall behavior for source: agents.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSkillsForPrompt, isUninstallableSkill, loadSkills, uninstallUserSkill } from "../src/core/skills.ts";

const AGENTS_GLOBAL = join(homedir(), ".agents", "skills");
const TEST_DIR = join(import.meta.dirname, "__test_tmp_agents_skills_live__");

function writeSkill(dir: string, name: string, description: string, extraFm = ""): void {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extraFm}---\n\nBody.\n`,
	);
}

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

const hasLiveInstall =
	existsSync(join(AGENTS_GLOBAL, "grill-me", "SKILL.md")) &&
	existsSync(join(AGENTS_GLOBAL, "find-skills", "SKILL.md"));

describe.runIf(hasLiveInstall)("live ~/.agents/skills discovery", () => {
	it("loads grill-me and find-skills from ~/.agents/skills", () => {
		const { skills } = loadSkills({
			agentsGlobalDirs: [AGENTS_GLOBAL],
			extraPaths: [],
		});
		const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
		expect(byName["grill-me"]).toBeTruthy();
		expect(byName["grill-me"]!.source).toBe("agents");
		expect(byName["grill-me"]!.disableModelInvocation).toBe(true);
		expect(byName["grill-me"]!.filePath).toBe(join(AGENTS_GLOBAL, "grill-me", "SKILL.md"));

		expect(byName["find-skills"]).toBeTruthy();
		expect(byName["find-skills"]!.source).toBe("agents");
		expect(byName["find-skills"]!.disableModelInvocation).toBe(false);

		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).toContain("<name>find-skills</name>");
		expect(prompt).not.toContain("<name>grill-me</name>");
	});
});

describe("agents skills merge / disable / uninstall", () => {
	it("cast project wins over agents global on name collision", () => {
		const castProject = join(TEST_DIR, "cast-project");
		const agentsGlobal = join(TEST_DIR, "agents-global");
		writeSkill(castProject, "shared", "From cast project.");
		writeSkill(agentsGlobal, "shared", "From agents global.");
		writeSkill(agentsGlobal, "agents-only", "Only agents.");

		const { skills } = loadSkills({
			projectDir: castProject,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		const shared = skills.find((s) => s.name === "shared")!;
		expect(shared.source).toBe("project");
		expect(shared.description).toBe("From cast project.");
		expect(skills.find((s) => s.name === "agents-only")?.source).toBe("agents");
	});

	it("disabledSkills filter drops agents skills from the catalog", () => {
		const agentsGlobal = join(TEST_DIR, "agents-global");
		writeSkill(agentsGlobal, "keep-me", "Keep.");
		writeSkill(agentsGlobal, "drop-me", "Drop.");
		const all = loadSkills({ agentsGlobalDirs: [agentsGlobal], extraPaths: [] }).skills;
		const disabled = new Set(["drop-me"]);
		const active = all.filter((s) => !disabled.has(s.name));
		const prompt = formatSkillsForPrompt(active);
		expect(prompt).toContain("<name>keep-me</name>");
		expect(prompt).not.toContain("<name>drop-me</name>");
	});

	it("uninstall removes an agents skill directory", () => {
		const agentsGlobal = join(TEST_DIR, "agents-global");
		writeSkill(agentsGlobal, "bye", "Delete me.");
		const { skills } = loadSkills({ agentsGlobalDirs: [agentsGlobal], extraPaths: [] });
		const skill = skills.find((s) => s.name === "bye")!;
		expect(isUninstallableSkill(skill)).toBe(true);
		uninstallUserSkill(skill);
		expect(existsSync(join(agentsGlobal, "bye"))).toBe(false);
		const after = loadSkills({ agentsGlobalDirs: [agentsGlobal], extraPaths: [] }).skills;
		expect(after.map((s) => s.name)).not.toContain("bye");
	});
});
