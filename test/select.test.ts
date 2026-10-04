import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectTrustForCwd } from "../src/core/project.ts";
import { getProjectTrust, loadSettings, type Settings } from "../src/core/settings.ts";
import { resolveProjectTrust } from "../src/pickers/domain.ts";
import type { Pickers } from "../src/pickers/types.ts";

/** Minimal fake Pickers — resolveProjectTrust only calls pickOption with a true/false choice. */
function fakePickers(answer: boolean | null): Pickers {
	return {
		pickOption: async () => answer,
		promptText: async () => null,
		log: () => {},
	} as unknown as Pickers;
}

describe("resolveProjectTrust", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let realIsTTY: boolean | undefined;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-select-test-"));
		process.env.HOME = fakeHome;
		realIsTTY = process.stdin.isTTY;
	});

	afterEach(() => {
		process.env.HOME = realHome;
		process.stdin.isTTY = realIsTTY as boolean;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("returns the cached decision without prompting when already asked", async () => {
		const settings: Settings = { projectTrust: { "/some/project": true } };
		const pickers = fakePickers(false); // would answer "no" if asked — must not be reached
		const trusted = await resolveProjectTrust(pickers, settings, "/some/project", ["  - .cast/skills/"]);
		expect(trusted).toBe(true);
	});

	it("defaults to not trusting when stdin isn't a TTY and nothing is cached", async () => {
		process.stdin.isTTY = false;
		const pickers = fakePickers(true); // would answer "yes" if asked — must not be reached
		const trusted = await resolveProjectTrust(pickers, {}, "/some/project", ["  - .cast/skills/"]);
		expect(trusted).toBe(false);
	});

	it("prompts and persists 'yes' as trusted", async () => {
		process.stdin.isTTY = true;
		const pickers = fakePickers(true);
		const trusted = await resolveProjectTrust(pickers, {}, join(fakeHome, "project"), ["  - .cast/skills/"]);
		expect(trusted).toBe(true);
		expect(getProjectTrust(loadSettings(), join(fakeHome, "project"))).toBe(true);
	});

	it("prompts and persists a 'no' (or cancel) as not trusted", async () => {
		process.stdin.isTTY = true;
		const pickers = fakePickers(null);
		const trusted = await resolveProjectTrust(pickers, {}, join(fakeHome, "project"), ["  - .cast/skills/"]);
		expect(trusted).toBe(false);
		expect(getProjectTrust(loadSettings(), join(fakeHome, "project"))).toBe(false);
	});

	it("prompts for a project whose only local resource is hooks.json", async () => {
		const project = join(fakeHome, "project");
		mkdirSync(join(project, ".cast"), { recursive: true });
		writeFileSync(join(project, ".cast", "hooks.json"), JSON.stringify({ Stop: [{ hooks: [{ command: "true" }] }] }));
		process.stdin.isTTY = true;

		const trusted = await resolveProjectTrustForCwd(
			{
				noSkills: false,
				noMcp: false,
				cliSkillPaths: [],
				cliMcpPaths: [],
				settings: {},
				pickers: fakePickers(true),
			},
			project,
		);

		expect(trusted).toBe(true);
		expect(getProjectTrust(loadSettings(), project)).toBe(true);
	});

	describe("project rules in the trust prompt", () => {
		const ask = async (cwd: string) => {
			process.stdin.isTTY = true;
			const shown: string[] = [];
			const pickers = {
				pickOption: async (_options: unknown, opts: unknown) => {
					shown.push(JSON.stringify(opts));
					return true;
				},
				promptText: async () => null,
				log: (text: string) => {
					shown.push(String(text));
				},
			} as unknown as Pickers;
			await resolveProjectTrustForCwd(
				{ noSkills: false, noMcp: false, cliSkillPaths: [], cliMcpPaths: [], settings: {}, pickers },
				cwd,
			);
			return shown.join("\n");
		};
		const project = () => join(fakeHome, "project");
		const write = (path: string) => {
			mkdirSync(join(project(), path, ".."), { recursive: true });
			writeFileSync(join(project(), path), "---\nalways-apply: true\n---\nrule\n");
		};

		it("asks about Cursor's .cursor/rules, which go into the system prompt as well", async () => {
			mkdirSync(join(project(), ".git"), { recursive: true });
			write(".cursor/rules/a.mdc");
			expect(await ask(project())).toContain(".cursor/rules/");
		});

		it("asks about rules nested in a subfolder, and names the folder", async () => {
			mkdirSync(join(project(), ".git"), { recursive: true });
			write("apps/web/.cast/rules/a.md");
			expect(await ask(project())).toContain("apps/web/.cast/rules/");
		});

		it("asks when the session starts in a subfolder and the rules are at the project root", async () => {
			mkdirSync(join(project(), ".git"), { recursive: true });
			write(".cast/rules/a.md");
			mkdirSync(join(project(), "apps", "web"), { recursive: true });
			expect(await ask(join(project(), "apps", "web"))).toContain(".cast/rules/");
		});

		it("does not ask when there is no rule file anywhere", async () => {
			mkdirSync(join(project(), ".git"), { recursive: true });
			mkdirSync(join(project(), ".cast", "rules"), { recursive: true });
			expect(await ask(project())).not.toContain("Trust this project");
		});
	});
});
