import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const independentReadsShareTurn: EvalCase = {
	id: "independent-reads-share-turn",
	description: "Independent reads are issued together rather than serially.",
	signals: ["parallel-tools", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-parallel-reads", { "alpha.txt": "alpha\n", "beta.txt": "beta\n" }),
	prompt: `Compare the values recorded in ${fixturePath("behavior-parallel-reads", "alpha.txt")} and ${fixturePath("behavior-parallel-reads", "beta.txt")}.`,
	expect: {
		toolsCalled: ["read"],
		toolCallCounts: { read: 2 },
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls, trace }) =>
			trace.some((turn) => turn.toolCalls.filter((call) => call.name === "read").length === 2) &&
			toolCalls.filter((call) => call.name === "read").length === 2
				? undefined
				: "independent reads were not dispatched in one tool-call turn",
	},
};
