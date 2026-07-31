import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const todoWriteStructuredList: EvalCase = {
	id: "todo-write-structured-list",
	description: "A multi-step request records a structured todo list with valid statuses.",
	signals: ["required-tool", "state-persistence"],
	// "the issue"/"the fix" implied a concrete bug the model would need to
	// go find — with no fixture and a real repo as cwd, every model tested
	// (4/4, 0/3 each) reasonably went looking for one instead of just
	// tracking abstract work, or asked what "the issue" was. Three concrete,
	// self-contained tasks avoid that: nothing to investigate, nothing to
	// ask about.
	prompt:
		"I need to update the changelog, bump the version number, and run the test suite before shipping this " +
		"release. Track this as a checklist so progress is visible as I go.",
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
