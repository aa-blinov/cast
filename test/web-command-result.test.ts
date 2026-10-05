import { describe, expect, it } from "vitest";
import { commandResultText, commandTimeoutMs } from "../src/server/public/command-result.js";

describe("commandResultText", () => {
	it("keeps words as they are and uses an answer's own text", () => {
		expect(commandResultText("Queue cleared")).toBe("Queue cleared");
		expect(commandResultText({ enabled: true, running: [], text: "No language server running yet." })).toBe(
			"No language server running yet.",
		);
	});

	it("lists named things one a line with what marks them, not as JSON", () => {
		const text = commandResultText([
			{ name: "mimo", url: "https://example.test/v1", active: true },
			{ name: "other", url: "https://other.test/v1", active: false },
		]);
		expect(text).toBe("* mimo (active) - https://example.test/v1\n* other - https://other.test/v1");
		expect(commandResultText([])).toBe("None.");
	});

	it("cuts a long list, and a long description, and says how many are left", () => {
		const skills = Array.from({ length: 55 }, (_, i) => ({
			name: `skill-${i}`,
			source: "builtin",
			filePath: "/x/y/SKILL.md",
			description: "d".repeat(400),
		}));
		const text = commandResultText(skills);
		expect(text.split("\n")).toHaveLength(41);
		expect(text.endsWith("… and 15 more")).toBe(true);
		expect(text.split("\n")[0]!.length).toBeLessThan(200);
		expect(text).not.toContain("filePath");
	});

	it("shows an object as key: value lines, with a list as a count", () => {
		expect(commandResultText({ entries: [], diagnostics: ["a", "b"], permissionMode: "bypass", on: true })).toBe(
			"entries: 0 items\ndiagnostics: 2 items\npermissionMode: bypass\non: true",
		);
		expect(commandResultText({})).toBe("Nothing to show.");
	});
});

describe("commandTimeoutMs", () => {
	it("is a minute for the commands that ask the model, and the default for the rest", () => {
		for (const command of ["/evolve", "/compact", "/btw what changed?", "/distill", " /dream "]) {
			expect(commandTimeoutMs(command), command).toBe(60000);
		}
		for (const command of ["/current", "/evolvement", "/help", undefined]) {
			expect(commandTimeoutMs(command as string), String(command)).toBeUndefined();
		}
	});
});
