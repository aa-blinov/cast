import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const globArgumentIsGrounded: EvalCase = {
	id: "glob-argument-is-grounded",
	description: "A file discovery request sends a scoped glob pattern rather than shelling out.",
	signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
	setup: () =>
		void writeFixture("behavior-glob-args", {
			"tests/alpha.spec.ts": "export {}\n",
			"tests/beta.spec.ts": "export {}\n",
			"tests/ignored.txt": "ignore\n",
		}),
	prompt: `Which TypeScript spec files are present under ${fixturePath("behavior-glob-args", "tests")}?`,
	expect: {
		containsAll: ["alpha.spec.ts", "beta.spec.ts"],
		containsNone: ["ignored.txt"],
		toolsCalled: ["glob"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) =>
					call.name === "glob" &&
					typeof call.args.pattern === "string" &&
					call.args.pattern.includes("*.spec.ts") &&
					call.args.path === fixturePath("behavior-glob-args", "tests"),
			)
				? undefined
				: "glob did not use a scoped TypeScript spec pattern",
	},
};
