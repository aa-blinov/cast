import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundBashExplicitTimeout: EvalCase = {
	id: "background-bash-explicit-timeout",
	description: "An explicit timeout passed alongside run_in_background still force-kills the task once it elapses.",
	signals: ["background-lifecycle", "argument-grounding"],
	timeout: 90_000,
	// run_in_background now runs with no default timeout (see bash.ts) — this
	// guards the opposite direction: a model-supplied timeout must still be
	// honored for a background task, not silently ignored.
	prompt:
		"Start `sleep 30` in the background, and on that same tool call pass a 2-second timeout argument so the tool " +
		"itself force-stops the process automatically — don't wrap it in a shell `timeout` command, and don't wait " +
		"around to kill it yourself. Then confirm what actually happened to it.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			const explicitTimeout = typeof start?.args.timeout === "number" && start.args.timeout <= 5;
			const output = toolCalls.find(
				(call) => call.name === "bash_output" && call.result?.content.includes("TIMED OUT"),
			);
			return explicitTimeout && output
				? undefined
				: "an explicit background timeout was not passed and/or its expiry was not observed";
		},
	},
};
