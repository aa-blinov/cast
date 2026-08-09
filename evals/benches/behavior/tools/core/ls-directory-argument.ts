import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const lsDirectoryArgument: EvalCase = {
	id: "ls-directory-argument",
	description: "A directory listing reports the requested fixture contents without unnecessary mutation.",
	signals: ["argument-grounding", "no-unneeded-tools", "tool-result-integrity"],
	setup: () => void writeFixture("behavior-ls-args", { "one.txt": "1\n", "two.txt": "2\n" }),
	prompt: `What files are present in ${fixtureDir("behavior-ls-args")}?`,
	expect: {
		containsAll: ["one.txt", "two.txt"],
		toolsCalled: ["ls"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "ls" && call.args.path === fixtureDir("behavior-ls-args"))
				? undefined
				: "ls did not target the requested fixture directory",
	},
};
