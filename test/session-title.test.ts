import { describe, expect, it } from "vitest";
import { deriveSessionTitle, skillInvocationLabel } from "../src/core/session-title.ts";

describe("deriveSessionTitle", () => {
	it("collapses whitespace and truncates a long first message", () => {
		expect(deriveSessionTitle("fix   the\nlogin   bug")).toBe("fix the login bug");
		expect(deriveSessionTitle("x".repeat(80))).toBe(`${"x".repeat(60)}…`);
	});

	it("titles a thread opened with a /skill command by what was typed", () => {
		const block =
			'<skill name="web-artifacts-builder" location="/s/SKILL.md">\nReferences are relative to /s.\n\n# Web\nSteps.\n</skill>';
		expect(deriveSessionTitle(`${block}\n\nUser: build a dashboard`)).toBe(
			"/web-artifacts-builder build a dashboard",
		);
		expect(deriveSessionTitle(block)).toBe("/web-artifacts-builder");
	});

	it("labels a skill invocation as typed, and leaves other text alone", () => {
		const block = '<skill name="demo" location="/s/SKILL.md">\nbody\n</skill>';
		expect(skillInvocationLabel(`${block}\n\nUser: a b`)).toBe("/demo a b");
		expect(skillInvocationLabel("plain text")).toBeUndefined();
	});
});
