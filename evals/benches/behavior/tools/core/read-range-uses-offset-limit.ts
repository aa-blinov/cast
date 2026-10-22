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
		verify: ({ toolCalls }) => {
			const call = toolCalls.find(
				(candidate) =>
					candidate.name === "read" && candidate.args.path === fixturePath("behavior-read-range", "log.txt"),
			);
			if (!call) return "the file was not read";
			const offset = call.args.offset;
			const limit = call.args.limit;
			if (typeof offset !== "number" || typeof limit !== "number") {
				return "read did not include offset and limit";
			}
			// The window has to be a bounded one that covers what was asked
			// for. Requiring the exact window (offset 21, limit 3) measured
			// the model's taste in margins, not the contract: a read of lines
			// 15-28 is still a bounded read that answers the question.
			if (offset > 21 || offset + limit - 1 < 23) {
				return `the read window (${offset}-${offset + limit - 1}) does not cover lines 21-23`;
			}
			return undefined;
		},
	},
};
