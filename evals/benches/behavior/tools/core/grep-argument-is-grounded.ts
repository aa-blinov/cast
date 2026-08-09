import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const grepArgumentIsGrounded: EvalCase = {
	id: "grep-argument-is-grounded",
	description: "A symbol search uses grep with the requested pattern and fixture path.",
	signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-grep-args", { "src/feature.ts": "export const targetFlag = true;\n" }),
	prompt: `Where is targetFlag defined under ${fixturePath("behavior-grep-args", "src")}?`,
	expect: {
		containsAll: ["feature.ts"],
		toolsCalled: ["grep"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) =>
					call.name === "grep" &&
					call.args.pattern === "targetFlag" &&
					call.args.path === fixturePath("behavior-grep-args", "src"),
			)
				? undefined
				: "grep did not target the requested symbol and directory",
	},
};
