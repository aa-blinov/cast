import { describe, expect, it } from "vitest";
import { deriveSessionTitle } from "../src/core/session-title.ts";

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
});
