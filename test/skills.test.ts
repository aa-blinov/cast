import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFrontmatter } from "../src/core/frontmatter.ts";
import {
	builtinSkillsDir,
	formatSkillInvocation,
	formatSkillsForPrompt,
	isUninstallableSkill,
	loadSkills,
	uninstallUserSkill,
} from "../src/core/skills.ts";
import { formatSkillPickLabel } from "../src/pickers/domain.ts";

const TEST_DIR = join(import.meta.dirname, "__test_tmp_skills__");
const GLOBAL_DIR = join(TEST_DIR, "global");
const PROJECT_DIR = join(TEST_DIR, "project");

function writeSkill(dir: string, relPath: string, frontmatter: Record<string, string>, body = "Do the thing."): void {
	const fullPath = join(dir, relPath);
	mkdirSync(join(fullPath, ".."), { recursive: true });
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
	writeFileSync(fullPath, `---\n${fm}\n---\n\n${body}\n`, "utf-8");
}

beforeEach(() => {
	mkdirSync(GLOBAL_DIR, { recursive: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("builtin skills", () => {
	function listMarkdownFiles(dir: string): string[] {
		const files: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) files.push(...listMarkdownFiles(path));
			else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
		}
		return files;
	}

	// Shipped once already: an over-long description warns on every startup.
	// Guard all builtin SKILL.md files against the spec limit directly.
	it("every builtin SKILL.md description fits the 1024-char limit", () => {
		for (const entry of readdirSync(builtinSkillsDir)) {
			const p = join(builtinSkillsDir, entry, "SKILL.md");
			try {
				if (!statSync(p).isFile()) continue;
			} catch {
				continue;
			}
			const { frontmatter } = parseFrontmatter(readFileSync(p, "utf-8"));
			const d = typeof frontmatter.description === "string" ? frontmatter.description : "";
			expect(d.length, `${entry}: ${d.length} chars`).toBeLessThanOrEqual(1024);
		}
	});

	it("every builtin skill is valid Agent Skills YAML and metadata", () => {
		const expected = readdirSync(builtinSkillsDir).filter((entry) => {
			try {
				return statSync(join(builtinSkillsDir, entry, "SKILL.md")).isFile();
			} catch {
				return false;
			}
		});
		const { skills, diagnostics } = loadSkills({ builtinDir: builtinSkillsDir, extraPaths: [] });
		expect(diagnostics).toEqual([]);
		expect(skills).toHaveLength(expected.length);
	});

	it("does not advertise tools or script paths unavailable in Cast", () => {
		const text = listMarkdownFiles(builtinSkillsDir)
			.map((path) => readFileSync(path, "utf-8"))
			.join("\n");
		expect(text).not.toMatch(/\b(?:WebSearch|WebFetch|AskUserQuestion)\b/);
		expect(text).not.toContain("/Users/");
		expect(text).not.toMatch(/python3? scripts\//);
	});
});

describe("loadSkills discovery", () => {
	it("loads a skill from a SKILL.md subdirectory", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["my-skill"]);
	});

	it("ignores a direct root .md file that is not an Agent Skills package", () => {
		writeSkill(GLOBAL_DIR, "standalone.md", { name: "standalone", description: "A loose skill file." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
	});

	it("ignores .md files in subdirectories that have no SKILL.md", () => {
		writeSkill(GLOBAL_DIR, "not-a-skill/notes.md", { name: "notes", description: "Should not load." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
	});

	it("stops recursing once it finds SKILL.md, ignoring sibling .md files", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		writeFileSync(join(GLOBAL_DIR, "my-skill", "extra.md"), "not a skill", "utf-8");
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["my-skill"]);
	});

	it("skips node_modules and dotfile directories", () => {
		writeSkill(GLOBAL_DIR, "node_modules/pkg/SKILL.md", { name: "pkg", description: "Should not load." });
		writeSkill(GLOBAL_DIR, ".hidden/SKILL.md", { name: "hidden", description: "Should not load." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
	});

	it("drops a skill without the required name, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "fallback-name/SKILL.md", { description: "No name field." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.message === "name is required")).toBe(true);
	});

	it("drops a skill with a missing description, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "no-desc/SKILL.md", { name: "no-desc" });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.message.includes("description"))).toBe(true);
	});

	it("drops a skill with an invalid name", () => {
		writeSkill(GLOBAL_DIR, "Invalid-Name/SKILL.md", { name: "Invalid-Name", description: "Uppercase name." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.message.includes("lowercase"))).toBe(true);
	});

	it("drops a directory skill whose name does not match its directory", () => {
		writeSkill(GLOBAL_DIR, "other-name/SKILL.md", { name: "my-skill", description: "Wrong directory." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.some((d) => d.message.includes("must match parent directory"))).toBe(true);
	});

	it("parses and retains standard optional fields from full YAML", () => {
		const skillDir = join(GLOBAL_DIR, "pdf-processing");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---\nname: pdf-processing\ndescription: Extract and fill PDF documents.\nlicense: Apache-2.0\ncompatibility: Requires Python 3.14 and pdftotext.\nmetadata:\n  author: example-org\n  version: "1.0"\nallowed-tools: Bash(pdftotext:*) Read\n---\n\nUse the reference.\n`,
			"utf-8",
		);
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(skills[0]).toMatchObject({
			license: "Apache-2.0",
			compatibility: "Requires Python 3.14 and pdftotext.",
			metadata: { author: "example-org", version: "1.0" },
			allowedTools: "Bash(pdftotext:*) Read",
		});
		expect(formatSkillInvocation(skills[0]!)).toContain('allowed-tools="Bash(pdftotext:*) Read"');
	});

	it("rejects invalid standard optional fields", () => {
		const skillDir = join(GLOBAL_DIR, "bad-metadata");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: bad-metadata\ndescription: Invalid metadata.\ncompatibility: \nmetadata:\n  version: 1\n---\n\nBody.\n",
			"utf-8",
		);
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.map((d) => d.message)).toContain("compatibility must be a non-empty string");
		expect(diagnostics.map((d) => d.message)).toContain("metadata must be a mapping of string keys to string values");
	});

	it("warns without dropping a body over the progressive-disclosure recommendation", () => {
		writeSkill(
			GLOBAL_DIR,
			"long-skill/SKILL.md",
			{ name: "long-skill", description: "A long skill." },
			Array.from({ length: 501 }, () => "instruction").join("\n"),
		);
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(diagnostics.some((d) => d.message.includes("recommended 500-line"))).toBe(true);
	});

	it("keeps the project skill on a name collision with a global skill, with a diagnostic", () => {
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Global version." });
		writeSkill(PROJECT_DIR, "shared/SKILL.md", { name: "shared", description: "Project version." });
		const { skills, diagnostics } = loadSkills({ globalDir: GLOBAL_DIR, projectDir: PROJECT_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(skills[0]?.description).toBe("Project version.");
		expect(diagnostics.some((d) => d.message.includes("collision"))).toBe(true);
	});

	it("keeps global over plugin, and plugin over builtin, on name collision", () => {
		const pluginDir = join(TEST_DIR, "plugin");
		const builtinDir = join(TEST_DIR, "builtin");
		mkdirSync(pluginDir, { recursive: true });
		mkdirSync(builtinDir, { recursive: true });
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Global version." });
		writeSkill(pluginDir, "shared/SKILL.md", { name: "shared", description: "Plugin version." });
		writeSkill(builtinDir, "shared/SKILL.md", { name: "shared", description: "Builtin version." });

		const globalWins = loadSkills({
			globalDir: GLOBAL_DIR,
			pluginDirs: [pluginDir],
			builtinDir,
			extraPaths: [],
		});
		expect(globalWins.skills).toHaveLength(1);
		expect(globalWins.skills[0]?.description).toBe("Global version.");
		expect(globalWins.skills[0]?.source).toBe("global");

		const pluginWins = loadSkills({
			pluginDirs: [pluginDir],
			builtinDir,
			extraPaths: [],
		});
		expect(pluginWins.skills).toHaveLength(1);
		expect(pluginWins.skills[0]?.description).toBe("Plugin version.");
		expect(pluginWins.skills[0]?.source).toBe("plugin");
	});

	it("stamps pluginId and pluginEnabled from pluginContributions", () => {
		const pluginDir = join(TEST_DIR, "plugin-pack");
		mkdirSync(pluginDir, { recursive: true });
		writeSkill(pluginDir, "alpha/SKILL.md", { name: "alpha", description: "A." });
		writeSkill(pluginDir, "beta/SKILL.md", { name: "beta", description: "B." });
		const { skills } = loadSkills({
			pluginContributions: [{ dir: pluginDir, pluginId: "pack@mp", enabled: false }],
			extraPaths: [],
		});
		expect(skills).toHaveLength(2);
		for (const s of skills) {
			expect(s.pluginId).toBe("pack@mp");
			expect(s.pluginEnabled).toBe(false);
			expect(s.source).toBe("plugin");
		}
	});

	it("returns skills sorted alphabetically by name", () => {
		writeSkill(GLOBAL_DIR, "zeta/SKILL.md", { name: "zeta", description: "Z." });
		writeSkill(GLOBAL_DIR, "alpha/SKILL.md", { name: "alpha", description: "A." });
		writeSkill(GLOBAL_DIR, "mid/SKILL.md", { name: "mid", description: "M." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills.map((s) => s.name)).toEqual(["alpha", "mid", "zeta"]);
	});

	it("loads .agents/skills below .cast project and above .cast global", () => {
		const agentsProject = join(TEST_DIR, "agents-project");
		const agentsGlobal = join(TEST_DIR, "agents-global");
		mkdirSync(agentsProject, { recursive: true });
		mkdirSync(agentsGlobal, { recursive: true });
		writeSkill(PROJECT_DIR, "shared/SKILL.md", { name: "shared", description: "Cast project." });
		writeSkill(agentsProject, "shared/SKILL.md", { name: "shared", description: "Agents project." });
		writeSkill(GLOBAL_DIR, "shared/SKILL.md", { name: "shared", description: "Cast global." });
		writeSkill(agentsGlobal, "shared/SKILL.md", { name: "shared", description: "Agents global." });
		writeSkill(agentsGlobal, "only-agents/SKILL.md", { name: "only-agents", description: "From agents global." });

		const castProjectWins = loadSkills({
			projectDir: PROJECT_DIR,
			agentsProjectDir: agentsProject,
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(castProjectWins.skills.find((s) => s.name === "shared")?.description).toBe("Cast project.");
		expect(castProjectWins.skills.find((s) => s.name === "shared")?.source).toBe("project");

		const agentsProjectWins = loadSkills({
			agentsProjectDir: agentsProject,
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(agentsProjectWins.skills.find((s) => s.name === "shared")?.description).toBe("Agents project.");
		expect(agentsProjectWins.skills.find((s) => s.name === "shared")?.source).toBe("agents");

		const castGlobalWins = loadSkills({
			globalDir: GLOBAL_DIR,
			agentsGlobalDirs: [agentsGlobal],
			extraPaths: [],
		});
		expect(castGlobalWins.skills.find((s) => s.name === "shared")?.description).toBe("Cast global.");
		expect(castGlobalWins.skills.find((s) => s.name === "only-agents")?.source).toBe("agents");
	});

	it("loads an explicit --skill path even when it's outside global/project dirs", () => {
		const explicitDir = join(TEST_DIR, "explicit");
		writeSkill(explicitDir, "extra/SKILL.md", { name: "extra", description: "Loaded via --skill." });
		const { skills } = loadSkills({ extraPaths: [join(explicitDir, "extra")] });
		expect(skills.map((s) => s.name)).toEqual(["extra"]);
	});

	it("rejects a standalone file passed through --skill", () => {
		const standalone = join(TEST_DIR, "standalone.md");
		writeSkill(TEST_DIR, "standalone.md", { name: "standalone", description: "Not a package." });
		const { skills, diagnostics } = loadSkills({ extraPaths: [standalone] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.map((d) => d.message)).toContain("skill path must be a directory containing SKILL.md");
	});

	it("rejects a --skill directory that is only a container", () => {
		const container = join(TEST_DIR, "container");
		writeSkill(container, "nested/SKILL.md", { name: "nested", description: "Not explicitly selected." });
		const { skills, diagnostics } = loadSkills({ extraPaths: [container] });
		expect(skills).toHaveLength(0);
		expect(diagnostics.map((d) => d.message)).toContain("skill directory must contain SKILL.md");
	});

	it("omits global/project dirs entirely when not provided (--no-skills)", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ extraPaths: [] });
		expect(skills).toHaveLength(0);
	});
});

describe("formatSkillsForPrompt", () => {
	it("includes name/description/location for visible skills", () => {
		writeSkill(GLOBAL_DIR, "my-skill/SKILL.md", { name: "my-skill", description: "Does a thing." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).toContain("<name>my-skill</name>");
		expect(prompt).toContain("<description>Does a thing.</description>");
		expect(prompt).toContain(join(GLOBAL_DIR, "my-skill", "SKILL.md"));
	});

	it("excludes skills with disable-model-invocation: true", () => {
		writeSkill(GLOBAL_DIR, "manual-only/SKILL.md", {
			name: "manual-only",
			description: "Only via /skill:name.",
			"disable-model-invocation": "true",
		});
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		expect(skills).toHaveLength(1);
		expect(formatSkillsForPrompt(skills)).toBe("");
	});

	it("returns an empty string when there are no skills", () => {
		expect(formatSkillsForPrompt([])).toBe("");
	});
});

describe("formatSkillsForPrompt with persona allowlist", () => {
	function makeSkills(): { skills: ReturnType<typeof loadSkills>["skills"] } {
		writeSkill(GLOBAL_DIR, "alpha/SKILL.md", { name: "alpha", description: "Alpha skill." });
		writeSkill(GLOBAL_DIR, "beta/SKILL.md", { name: "beta", description: "Beta skill." });
		writeSkill(GLOBAL_DIR, "gamma/SKILL.md", { name: "gamma", description: "Gamma skill." });
		return loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
	}

	it("returns the full catalog when no allowlist is given", () => {
		const { skills } = makeSkills();
		const prompt = formatSkillsForPrompt(skills);
		expect(prompt).toContain("<name>alpha</name>");
		expect(prompt).toContain("<name>beta</name>");
		expect(prompt).toContain("<name>gamma</name>");
	});

	it("drops skills not named in the allowlist", () => {
		const { skills } = makeSkills();
		const prompt = formatSkillsForPrompt(skills, ["alpha"]);
		expect(prompt).toContain("<name>alpha</name>");
		expect(prompt).not.toContain("<name>beta</name>");
		expect(prompt).not.toContain("<name>gamma</name>");
	});

	it("expands globs in the allowlist", () => {
		const { skills } = makeSkills();
		const prompt = formatSkillsForPrompt(skills, ["alp*"]);
		expect(prompt).toContain("<name>alpha</name>");
		expect(prompt).not.toContain("<name>beta</name>");
		expect(prompt).not.toContain("<name>gamma</name>");
	});

	it("returns an empty catalog when the allowlist is empty", () => {
		const { skills } = makeSkills();
		expect(formatSkillsForPrompt(skills, [])).toBe("");
	});
});

describe("formatSkillInvocation", () => {
	it("wraps the skill body in a <skill> block, appending user args", () => {
		writeSkill(
			GLOBAL_DIR,
			"my-skill/SKILL.md",
			{ name: "my-skill", description: "Does a thing." },
			"Step 1. Step 2.",
		);
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const invocation = formatSkillInvocation(skills[0]!, "extra instructions");
		expect(invocation).toContain('<skill name="my-skill"');
		expect(invocation).toContain("Step 1. Step 2.");
		expect(invocation).toContain("User: extra instructions");
	});

	it("keeps scripts, references, and assets on disk for on-demand use", () => {
		const skillDir = join(GLOBAL_DIR, "resource-skill");
		writeSkill(
			GLOBAL_DIR,
			"resource-skill/SKILL.md",
			{ name: "resource-skill", description: "Uses bundled resources." },
			"Read references/REFERENCE.md, copy assets/template.txt, then run scripts/render.sh.",
		);
		mkdirSync(join(skillDir, "scripts"), { recursive: true });
		mkdirSync(join(skillDir, "references"), { recursive: true });
		mkdirSync(join(skillDir, "assets"), { recursive: true });
		writeFileSync(join(skillDir, "scripts", "render.sh"), "#!/bin/sh\nprintf rendered\n", "utf-8");
		writeFileSync(join(skillDir, "references", "REFERENCE.md"), "Reference content", "utf-8");
		writeFileSync(join(skillDir, "assets", "template.txt"), "Template content", "utf-8");

		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const invocation = formatSkillInvocation(skills[0]!);
		expect(invocation).toContain(`References are relative to ${skillDir}.`);
		expect(invocation).toContain("references/REFERENCE.md");
		expect(readFileSync(join(skillDir, "references", "REFERENCE.md"), "utf-8")).toBe("Reference content");
		expect(readFileSync(join(skillDir, "assets", "template.txt"), "utf-8")).toBe("Template content");
		expect(execFileSync("sh", [join(skillDir, "scripts", "render.sh")], { encoding: "utf-8" })).toBe("rendered");
	});
});

describe("formatSkillPickLabel", () => {
	it("shows plugin provenance and locks pack-off skills", () => {
		const locked = formatSkillPickLabel(
			{
				name: "pony",
				description: "A pony skill.",
				source: "plugin",
				pluginId: "ponytail@ponytail",
				pluginEnabled: false,
				disableModelInvocation: false,
			},
			false,
		);
		expect(locked.label).toBe("pony (plugin · ponytail@ponytail, pack off)");
		expect(locked.locked).toBe(true);
		expect(locked.muted).toBe(true);
		expect(locked.description).toBe("Enable this pack with /plugin first. A pony skill.");

		const on = formatSkillPickLabel(
			{
				name: "pony",
				description: "A pony skill.",
				source: "plugin",
				pluginId: "ponytail@ponytail",
				pluginEnabled: true,
				disableModelInvocation: false,
			},
			true,
		);
		expect(on.label).toBe("pony (plugin · ponytail@ponytail, disabled)");
		expect(on.description).toBe("A pony skill.");
		expect(on.locked).toBe(false);
	});
});

describe("uninstallUserSkill", () => {
	it("removes a directory skill and refuses builtin", () => {
		writeSkill(GLOBAL_DIR, "gone/SKILL.md", { name: "gone", description: "Delete me." });
		const { skills } = loadSkills({ globalDir: GLOBAL_DIR, extraPaths: [] });
		const skill = skills[0]!;
		expect(isUninstallableSkill(skill)).toBe(true);
		uninstallUserSkill(skill);
		expect(existsSync(join(GLOBAL_DIR, "gone"))).toBe(false);

		const builtin = {
			...skill,
			name: "cast",
			source: "builtin" as const,
			filePath: join(GLOBAL_DIR, "cast", "SKILL.md"),
			baseDir: join(GLOBAL_DIR, "cast"),
		};
		expect(isUninstallableSkill(builtin)).toBe(false);
		expect(() => uninstallUserSkill(builtin)).toThrow(/builtin/);

		const agents = { ...skill, source: "agents" as const };
		expect(isUninstallableSkill(agents)).toBe(true);
	});
});
