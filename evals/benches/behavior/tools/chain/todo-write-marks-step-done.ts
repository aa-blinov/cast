import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const todoWriteMarksStepDone: EvalCase = {
	id: "todo-write-marks-step-done",
	description: "A todo list is updated to mark a step completed once its verification tool call actually confirms it.",
	signals: ["state-persistence", "tool-chain"],
	setup: () => void writeFixture("behavior-todo-verify", { VERSION: "0.12.5\n" }),
	prompt:
		"Track this release as a three-step todo list: verify the recorded version, build the package, publish it. " +
		`Then read ${fixturePath("behavior-todo-verify", "VERSION")} to verify that first step, and once confirmed, ` +
		"mark it done in the list.",
	expect: {
		toolsCalled: ["todo_write", "read"],
		toolCallCounts: { todo_write: 2 },
		noErrors: true,
		verify: ({ trace }) => {
			const todoCalls = trace.flatMap((turn) => turn.toolCalls).filter((call) => call.name === "todo_write");
			if (todoCalls.length < 2) return "todo list was not updated after the verification read";
			const first = todoCalls[0]?.args.todos;
			const last = todoCalls[todoCalls.length - 1]?.args.todos;
			const firstOk = Array.isArray(first) && first.length >= 3;
			const lastFirstItem = Array.isArray(last) ? (last[0] as { status?: unknown } | undefined) : undefined;
			return firstOk && lastFirstItem?.status === "completed"
				? undefined
				: "the three-step list was not created, or its first item was not later marked completed";
		},
	},
};
