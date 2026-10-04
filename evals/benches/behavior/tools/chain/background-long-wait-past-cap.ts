import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundLongWaitPastCap: EvalCase = {
	id: "background-long-wait-past-cap",
	description:
		"A result that takes longer than one bash_output wait allows is waited for with repeated waits, not given up on or run again.",
	signals: ["background-lifecycle", "persistence"],
	timeout: 260_000,
	prompt:
		"Start `sleep 100 && printf slow-token-3390` in the background (run_in_background). I need its output before anything else: wait for it, and tell me what it printed.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		containsAll: ["slow-token-3390"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const runs = toolCalls.filter((c) => c.name === "bash" && String(c.args.command).includes("sleep 100"));
			return runs.length === 1 ? undefined : `the command was started ${runs.length} times, not once`;
		},
	},
};
