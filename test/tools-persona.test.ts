import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findPersona } from "../src/core/personas.ts";
import { personaOptionsForCwd } from "../src/core/project.ts";
import { execPersonaCreate } from "../src/core/tools/persona.ts";

describe("persona_create", () => {
	let home: string;
	let project: string;
	let realHome: string | undefined;

	beforeEach(() => {
		realHome = process.env.HOME;
		home = mkdtempSync(join(tmpdir(), "cast-persona-home-"));
		project = mkdtempSync(join(tmpdir(), "cast-persona-project-"));
		process.env.HOME = home;
	});
	afterEach(() => {
		if (realHome === undefined) delete process.env.HOME;
		else process.env.HOME = realHome;
		rmSync(home, { recursive: true, force: true });
		rmSync(project, { recursive: true, force: true });
	});

	const deps = (over: Partial<Parameters<typeof execPersonaCreate>[1]> = {}) => ({
		cwd: project,
		projectTrusted: false,
		onPersonaCreated: vi.fn(),
		...over,
	});

	it("saves a global persona that loads back with every field, and tells the host", async () => {
		const d = deps();
		const res = await execPersonaCreate(
			{
				name: "code-reviewer",
				label: "Code: Reviewer",
				description: 'Reviews diffs, "strictly"',
				prompt: "You are a strict code reviewer.",
				tools: ["read", "grep"],
				skills: [],
				subagents: false,
				agentsMd: false,
				activate: "new",
			},
			d,
		);

		expect(res.isError).toBeFalsy();
		const persona = findPersona("code-reviewer", personaOptionsForCwd(project, false));
		expect(persona).toMatchObject({
			label: "Code: Reviewer",
			description: 'Reviews diffs, "strictly"',
			tools: ["read", "grep"],
			skills: [],
			agentsMd: false,
			source: "global",
		});
		expect(persona?.systemPrompt).toContain("You are a strict code reviewer.");
		expect(d.onPersonaCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "code-reviewer" }), "new");
		// Nothing left behind from the write-and-rename.
		expect(readFileSync(join(home, ".cast", "personas", "code-reviewer.md"), "utf8")).toContain(
			"name: code-reviewer",
		);
	});

	it("passes here through, and no activation when none was asked", async () => {
		const here = deps();
		const res = await execPersonaCreate({ name: "in-place", prompt: "p", activate: "here" }, here);
		expect(here.onPersonaCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "in-place" }), "here");
		expect(res.content).toContain("from the next turn");

		const none = deps();
		const plain = await execPersonaCreate({ name: "plain", prompt: "p" }, none);
		expect(none.onPersonaCreated).toHaveBeenCalledWith(expect.objectContaining({ name: "plain" }), undefined);
		expect(plain.content).toContain("/persona plain");
	});

	it("refuses a bad name and an empty prompt", async () => {
		expect((await execPersonaCreate({ name: "Bad Name", prompt: "x" }, deps())).isError).toBe(true);
		expect((await execPersonaCreate({ name: "ok", prompt: "  " }, deps())).isError).toBe(true);
	});

	it("does not replace an existing persona, builtin included, unless told to", async () => {
		const first = await execPersonaCreate({ name: "senior", prompt: "You are someone else." }, deps());
		expect(first.isError).toBe(true);
		expect(first.content).toContain("builtin");

		const d = deps();
		const override = await execPersonaCreate({ name: "senior", prompt: "You are someone else.", overwrite: true }, d);
		expect(override.isError).toBeFalsy();
		expect(findPersona("senior", personaOptionsForCwd(project, false))?.source).toBe("global");
	});

	it("keeps project personas behind project trust", async () => {
		const refused = await execPersonaCreate({ name: "local", prompt: "p", scope: "project" }, deps());
		expect(refused.isError).toBe(true);
		expect(existsSync(join(project, ".cast", "personas", "local.md"))).toBe(false);

		const saved = await execPersonaCreate(
			{ name: "local", prompt: "p", scope: "project" },
			deps({ projectTrusted: true }),
		);
		expect(saved.isError).toBeFalsy();
		expect(findPersona("local", personaOptionsForCwd(project, true))?.source).toBe("project");
	});

	it("writes nothing when the user declines", async () => {
		const d = deps({ confirmWrite: async () => false });
		const res = await execPersonaCreate({ name: "nope", prompt: "p" }, d);
		expect(res.isError).toBe(true);
		expect(existsSync(join(home, ".cast", "personas", "nope.md"))).toBe(false);
		expect(d.onPersonaCreated).not.toHaveBeenCalled();
	});

	it("rejects a tools value that isn't a list of names", async () => {
		const res = await execPersonaCreate({ name: "odd", prompt: "p", tools: "read" }, deps());
		expect(res.isError).toBe(true);
		expect(existsSync(join(home, ".cast", "personas", "odd.md"))).toBe(false);
	});
});
