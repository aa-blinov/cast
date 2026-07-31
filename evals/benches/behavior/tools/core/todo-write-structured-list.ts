import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const todoWriteStructuredList: EvalCase = {
	id: "todo-write-structured-list",
	description: "A multi-step request records a structured todo list with valid statuses.",
	signals: ["required-tool", "state-persistence"],
	prompt:
		"I need to inspect the issue, implement the fix, and run verification. Organize this work so progress is visible.",
	expect: {
		toolsCalled: ["todo_write"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const call = toolCalls.find((item) => item.name === "todo_write");
			const todos = call?.args.todos;
			return Array.isArray(todos) && todos.length >= 3 && todos.every((todo) => typeof todo === "object")
				? undefined
				: "todo_write did not receive a complete structured list";
		},
	},
};
