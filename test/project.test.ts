import { describe, expect, it } from "vitest";
import type { Persona } from "../src/core/personas.ts";
import { buildSystemPrompt, formatSystemEnvironmentBlock } from "../src/core/project.ts";

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
