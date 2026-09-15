import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-todo-list";

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
	//
	// The fixture is what those three tasks act on. Without it the case ran in
	// an empty temp directory, and a model that opened it first found nothing
	// to bump or test and asked which project was meant — a fair question, and
	// a failure of the case rather than of the model.
	setup: () =>
		void writeFixture(FIXTURE_ID, {
			"CHANGELOG.md": "# Changelog\n\n## Unreleased\n",
			"package.json": '{\n\t"name": "fixture-app",\n\t"version": "1.4.2",\n\t"scripts": { "test": "echo ok" }\n}\n',
			"test/smoke.test.js": "// smoke test\n",
		}),
	cwd: fixtureDir(FIXTURE_ID),
	prompt:
		"I need to update the changelog, bump the version number, and run the test suite before shipping this " +
		"release. Track this as a checklist so progress is visible as I go.",
	expect: {
		toolsCalled: ["todo_write"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const call = toolCalls.find((item) => item.name === "todo_write");
			const todos = call?.args.todos;
			return Array.isArray(todos) &&
				todos.length >= 3 &&
				todos.every(
					(todo) =>
						typeof todo === "object" &&
						todo !== null &&
						typeof todo.content === "string" &&
						["pending", "in_progress", "completed"].includes(String(todo.status)),
				)
				? undefined
				: "todo_write did not receive a complete list with valid todo statuses";
		},
	},
};
