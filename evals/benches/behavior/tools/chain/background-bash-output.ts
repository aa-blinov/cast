import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundBashOutput: EvalCase = {
	id: "background-bash-output",
	description: "A background bash task is polled with its returned task id and output is observed.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 90_000,
	// A few seconds of real delay, not an instant `printf`: the bash tool's
	// own result text tells the model it doesn't need to poll because a
	// completion reminder arrives automatically, so an instant command lets
	// the model satisfy the prompt by just waiting for that reminder and
	// never touching bash_output. The delay forces a genuine, observed poll.
	prompt:
		"Start the local check `sleep 5 && printf background-ready` without blocking the session, then inspect its result when it finishes.",
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
