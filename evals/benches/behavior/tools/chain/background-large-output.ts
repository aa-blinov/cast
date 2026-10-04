import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundLargeOutput: EvalCase = {
	id: "background-large-output",
	description:
		"A background task with far more output than fits is cut with a note; the model still reports the end of it correctly.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 120_000,
	prompt: "Start `seq 1 300000` in the background (run_in_background) and tell me the last number it printed.",
	expect: {
		toolsCalled: ["bash"],
		containsAll: ["300000"],
		noErrors: true,
	},
};
