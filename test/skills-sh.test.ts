/**
 * skills.sh argument normalization — the part of the integration that is pure
 * and therefore worth pinning. Everything it fixes came from a real paste:
 * the site's copy button hands over a whole `npx skills add …` line, the
 * package may be a github.com URL, and `-a <agent>` installs somewhere cast
 * never scans.
 */
import { describe, expect, it } from "vitest";
import { normalizeSkillsShInstallArgs } from "../src/core/skills-sh.ts";

describe("normalizeSkillsShInstallArgs", () => {
	it("passes a plain owner/repo through, forcing the universal scope", () => {
		expect(normalizeSkillsShInstallArgs("anthropics/skills --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
	});

	it("tolerates the whole npx line the skills.sh copy button produces", () => {
		expect(normalizeSkillsShInstallArgs("npx skills add anthropics/skills --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
		expect(normalizeSkillsShInstallArgs("npx --yes skills a anthropics/skills --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
	});

	it("reduces a github URL to owner/repo", () => {
		expect(normalizeSkillsShInstallArgs("https://github.com/anthropics/skills --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
		expect(normalizeSkillsShInstallArgs("https://www.github.com/anthropics/skills.git --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
	});

	it("drops -a/--agent, which would install where cast never looks", () => {
		// `skills add -a claude-code` installs only into .claude/skills, never
		// the universal ~/.agents/skills tree cast scans — the skill would
		// silently never appear.
		expect(normalizeSkillsShInstallArgs("anthropics/skills --skill pdf -a claude-code")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
		expect(normalizeSkillsShInstallArgs("--agent codex anthropics/skills --skill pdf")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
	});

	it("does not duplicate an explicit -g/--global", () => {
		expect(normalizeSkillsShInstallArgs("anthropics/skills --skill pdf -g")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
		expect(normalizeSkillsShInstallArgs("anthropics/skills --skill pdf --global")).toEqual([
			"anthropics/skills",
			"--skill",
			"pdf",
			"-g",
		]);
	});

	it("returns nothing for empty input, so the caller can print usage", () => {
		expect(normalizeSkillsShInstallArgs("")).toEqual([]);
		expect(normalizeSkillsShInstallArgs("   ")).toEqual([]);
		expect(normalizeSkillsShInstallArgs("npx skills add")).toEqual([]);
	});
});
