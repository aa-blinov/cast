import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundBashKill: EvalCase = {
	id: "background-bash-kill",
	description: "A long-running background bash task is terminated by its own task id.",
	signals: ["background-lifecycle", "tool-error-recovery"],
	timeout: 90_000,
	prompt:
		"Start a long-running local check with `sleep 60` without blocking the session. It is no longer needed, so stop it immediately.",
	expect: {
		toolsCalled: ["bash", "bash_kill"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			const taskId = start?.result?.content.match(/\bbg-\d+\b/)?.[0];
			const kill = toolCalls.find((call) => call.name === "bash_kill");
			return taskId && kill?.args.task_id === taskId && kill.result?.content.includes("killed")
				? undefined
				: "background task was not killed through its returned task id";
		},
	},
};
