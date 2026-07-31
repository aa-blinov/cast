import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const taskParallelDelegation: EvalCase = {
	id: "task-parallel-delegation",
	description: "Two independent investigations are delegated as separate task calls in the same turn, not run serially.",
	signals: ["delegation", "parallel-tools"],
	persona: "coder-with-subagents",
	setup: () =>
		void writeFixture("behavior-parallel-task", {
			"module-a/info.txt": "module-a-marker\n",
			"module-b/info.txt": "module-b-marker\n",
		}),
	prompt:
		`Independently and in parallel, investigate ${fixturePath("behavior-parallel-task", "module-a")} and ` +
		`${fixturePath("behavior-parallel-task", "module-b")}, and tell me the marker text found in each. Do not modify any files.`,
	expect: {
		toolsCalled: ["task"],
		toolCallCounts: { task: 2 },
		toolsNotCalled: ["write", "edit"],
		noErrors: true,
		verify: ({ trace }) =>
			trace.some((turn) => turn.toolCalls.filter((call) => call.name === "task").length === 2)
				? undefined
				: "the two independent investigations were not delegated as task calls in the same turn",
	},
};
