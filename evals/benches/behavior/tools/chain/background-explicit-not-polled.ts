import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-bg-no-poll";

export const backgroundExplicitNotPolled: EvalCase = {
	id: "background-explicit-not-polled",
	description:
		"A task started in the background whose output is not needed now is not polled: the model does other work and lets the result arrive.",
	signals: ["background-lifecycle", "tool-selection"],
	cwd: fixtureDir(PROJECT),
	timeout: 120_000,
	setup: () => void writeFixture(PROJECT, { "a.txt": "a", "b.txt": "b", "c.txt": "c" }),
	prompt:
		"Start `sleep 15 && printf nightly-done` in the background (run_in_background): I do not need its output now. " +
		"Meanwhile, tell me how many files are in the working directory.",
	expect: {
		toolsCalled: ["bash"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			if (!start) return "the task was not started in the background";
			const polled = toolCalls.find((call) => call.name === "bash_output" || call.name === "bash_kill");
			if (polled) return `the model went on to ${polled.name} a task whose output it was told it did not need now`;
			// Any reply of the turn: the task's own notice may start one more after the answer was given.
			const said = messages
				.filter((m) => m.role === "assistant" && typeof m.content === "string")
				.map((m) => String(m.content))
				.join("\n");
			return /\b3\b|three/i.test(said) ? undefined : "the file count (3) was not reported";
		},
	},
};
