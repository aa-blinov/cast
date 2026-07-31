import { readFileSync } from "node:fs";
import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const taskWorkerDelegatesRealEdit: EvalCase = {
	id: "task-worker-delegates-real-edit",
	description: "An explicitly delegated fix is handed to the worker subagent (not explore, which has no write/edit) and the file actually changes.",
	signals: ["delegation", "tool-chain"],
	persona: "coder-with-subagents",
	setup: () => void writeFixture("behavior-delegate-edit", { "calc.js": "exports.sum = (a, b) => a - b;\n" }),
	prompt:
		`Delegate this to a subagent: the function in ${fixturePath("behavior-delegate-edit", "calc.js")} is supposed ` +
		"to add its two arguments but currently subtracts them. Have the subagent fix it directly.",
	expect: {
		toolsCalled: ["task"],
		// The point is that the parent delegates the edit rather than doing it itself.
		toolsNotCalled: ["edit", "write"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			// worker is the persona's default subagent when `subagent` is omitted
			// (see coder-with-subagents.md) — only a different, explicit name
			// (e.g. "explore", which has no write/edit) should fail this.
			const delegated = toolCalls.find(
				(call) => call.name === "task" && (!call.args.subagent || call.args.subagent === "worker"),
			);
			if (!delegated) return "the fix was not delegated to the worker subagent (explore has no write/edit for this)";
			return readFileSync(fixturePath("behavior-delegate-edit", "calc.js"), "utf-8") === "exports.sum = (a, b) => a + b;\n"
				? undefined
				: "the delegated worker did not actually correct the fixture";
		},
	},
};
