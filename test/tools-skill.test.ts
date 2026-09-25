import { beforeEach, describe, expect, it, vi } from "vitest";

const install = vi.hoisted(() => ({ fn: vi.fn(async (_input: string) => "Installed 1 skill") }));
vi.mock("../src/core/skills-sh.ts", () => ({ skillsShInstall: install.fn }));

import type { Skill } from "../src/core/skills.ts";
import { execSkill, execSkillInstall, type SkillToolDeps } from "../src/core/tools/skill.ts";

const skill = (name: string): Skill =>
	({
		name,
		description: `${name} skill`,
		filePath: `/skills/${name}/SKILL.md`,
		body: `# ${name}\nDo ${name}.`,
	}) as unknown as Skill;

describe("skill tool reload", () => {
	it("loads a skill installed after the turn started", async () => {
		const deps: SkillToolDeps = { skills: [skill("a")], reload: () => [skill("a"), skill("fresh")] };
		const result = await execSkill({ name: "fresh" }, deps);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("fresh");
		expect(deps.skills.map((s) => s.name)).toEqual(["a", "fresh"]);
	});

	it("still reports a skill that is nowhere to be found", async () => {
		const deps: SkillToolDeps = { skills: [skill("a")], reload: () => [skill("a")] };
		const result = await execSkill({ name: "ghost" }, deps);
		expect(result.isError).toBe(true);
		expect(result.content).toContain('skill "ghost" not found');
	});
});

describe("execSkillInstall", () => {
	beforeEach(() => install.fn.mockClear());

	it("installs, reloads, and tells the host so the slash commands refresh", async () => {
		const onSkillsChanged = vi.fn();
		const deps: SkillToolDeps = {
			skills: [skill("a")],
			reload: () => [skill("a"), skill("pr-review")],
			onSkillsChanged,
		};
		const result = await execSkillInstall({ source: "owner/repo", skill: "pr-review" }, deps);

		expect(install.fn).toHaveBeenCalledWith("owner/repo --skill pr-review");
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain('Installed pr-review. Load it now with the skill tool (name: "pr-review")');
		expect(result.content).toContain("/skill:pr-review");
		expect(onSkillsChanged).toHaveBeenCalledOnce();
		// The executor shares this array with the skill tool, so a follow-up load works.
		expect(deps.skills.map((s) => s.name)).toContain("pr-review");
	});

	it("asks first, and does nothing when the user declines", async () => {
		const confirm = vi.fn(async () => false);
		const deps: SkillToolDeps = { skills: [], reload: () => [] };
		const result = await execSkillInstall({ source: "owner/repo" }, deps, confirm);
		expect(confirm).toHaveBeenCalledWith("npx skills add owner/repo -g", expect.any(String));
		expect(install.fn).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
	});

	it("says so when the install added nothing new", async () => {
		const deps: SkillToolDeps = { skills: [skill("a")], reload: () => [skill("a")] };
		const result = await execSkillInstall({ source: "owner/repo" }, deps);
		expect(result.isError).toBeFalsy();
		expect(result.content).toContain("No new skill became available");
	});

	it("reports a failed install and a missing source as errors", async () => {
		install.fn.mockRejectedValueOnce(new Error("repo not found"));
		const deps: SkillToolDeps = { skills: [], reload: () => [] };
		expect((await execSkillInstall({ source: "nope/nope" }, deps)).content).toContain("repo not found");
		expect((await execSkillInstall({}, deps)).isError).toBe(true);
	});
});
