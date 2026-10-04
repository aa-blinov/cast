import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundNoticeMidturnNotRepolled: EvalCase = {
	id: "background-notice-midturn-not-repolled",
	description:
		"A task finishes while the model is busy with other steps: the notice is used once, and the model does not poll for what it was already told.",
	signals: ["background-lifecycle", "tool-selection"],
	timeout: 150_000,
	prompt:
		"Start `sleep 7 && printf ready-token-6613` in the background (run_in_background). While it runs, run `sleep 3` in the foreground three times, one call each. " +
		"Then tell me what the background task printed.",
	expect: {
		toolsCalled: ["bash"],
		containsAll: ["ready-token-6613"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const polled = toolCalls.find((c) => c.name === "bash_output");
			return polled ? "the model polled a task whose result it was told would arrive on its own" : undefined;
		},
	},
};
