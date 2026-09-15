import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundBashOutput: EvalCase = {
	id: "background-bash-output",
	description: "A background bash task is polled with its returned task id and output is observed.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 90_000,
	// The bash tool's own result text tells the model a completion reminder
	// arrives automatically, so "inspect its result when it finishes" is
	// satisfiable by just waiting — the case then times out on a model that
	// did nothing wrong. Ask for the poll explicitly: what's under test is
	// that the poll carries the task id the start call returned, not whether
	// the model invents the idea of polling against the tool's own advice.
	prompt:
		"Start the local check `sleep 5 && printf background-ready` without blocking the session, then poll it with bash_output and report the output it produced.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			const taskId = start?.result?.content.match(/\bbg-\d+\b/)?.[0];
			const output = toolCalls.find((call) => call.name === "bash_output");
			return taskId && output?.args.task_id === taskId && output.result?.content.includes("background-ready")
				? undefined
				: "background output was not polled with the created task id";
		},
	},
};
