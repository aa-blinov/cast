import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const readRangeUsesOffsetLimit: EvalCase = {
	id: "read-range-uses-offset-limit",
	description: "A bounded read sends range arguments instead of loading the entire file.",
	signals: ["argument-grounding", "no-unneeded-tools"],
	setup: () =>
		void writeFixture("behavior-read-range", {
			"log.txt": Array.from({ length: 40 }, (_, index) => `line-${index + 1}`).join("\n"),
		}),
	prompt: `What are the entries on lines 21 through 23 of ${fixturePath("behavior-read-range", "log.txt")}?`,
	expect: {
		containsAll: ["line-21", "line-22", "line-23"],
		toolsCalled: ["read"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) =>
					call.name === "read" &&
					call.args.path === fixturePath("behavior-read-range", "log.txt") &&
					call.args.offset === 21 &&
					call.args.limit === 3,
			)
				? undefined
				: "read did not include offset and limit",
	},
};
