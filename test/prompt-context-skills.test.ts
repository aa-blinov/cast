import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePromptContextForCwd } from "../src/core/project.ts";
import { builtinSkillsDir } from "../src/core/skills.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_prompt_context_skills__");

function writeSkill(dir: string, name: string, description: string): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	const filePath = join(skillDir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
	return skillDir;
}

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("resolvePromptContextForCwd skill options", () => {
	it("with --no-skills omits builtin auto-discovery", () => {
		const withSkills = resolvePromptContextForCwd(TEST_DIR, true);
		// Builtin catalog is non-empty in a normal checkout.
		expect(builtinSkillsDir).toBeTruthy();
		expect(withSkills.skillsPromptSuffix).toContain("<available_skills>");

		const noSkills = resolvePromptContextForCwd(TEST_DIR, true, { noSkills: true });
		expect(noSkills.skillsPromptSuffix).toBe("");
	});

	it("still loads --skill paths when --no-skills is set", () => {
		const explicit = writeSkill(TEST_DIR, "cli-only", "Loaded via --skill.");
		const ctx = resolvePromptContextForCwd(TEST_DIR, true, {
			noSkills: true,
			cliSkillPaths: [explicit],
		});
		expect(ctx.skillsPromptSuffix).toContain("<name>cli-only</name>");
		expect(ctx.skillsPromptSuffix).toContain("<description>Loaded via --skill.</description>");
	});
});
