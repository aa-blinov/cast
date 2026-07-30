/**
 * Merge / disable / uninstall behavior for source: agents (skills.sh installs).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatSkillsForPrompt, isUninstallableSkill, loadSkills, uninstallUserSkill } from "../src/core/skills.ts";

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
