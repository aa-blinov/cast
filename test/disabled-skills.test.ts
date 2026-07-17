import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSkillsForPrompt, loadSkills } from "../src/core/skills.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_disabled_skills__");
const GLOBAL_DIR = join(TEST_DIR, "skills");

function writeSkill(name: string, description: string): void {
	const dir = join(GLOBAL_DIR, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(GLOBAL_DIR, { recursive: true });
	writeSkill("alpha", "Alpha skill.");
	writeSkill("beta", "Beta skill.");
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("disabledSkills filtering", () => {
	it("keeps disabled skills out of the prompt catalog", () => {
		const all = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] }).skills;
		expect(all.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
		const disabled = new Set(["beta"]);
		const active = all.filter((s) => !disabled.has(s.name));
		const prompt = formatSkillsForPrompt(active);
		expect(prompt).toContain("<name>alpha</name>");
		expect(prompt).not.toContain("<name>beta</name>");
	});
});
