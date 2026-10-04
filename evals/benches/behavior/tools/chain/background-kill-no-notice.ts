import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundKillNoNotice: EvalCase = {
	id: "background-kill-no-notice",
	description: "A background task the model killed itself is not announced to it afterwards.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 120_000,
	prompt:
		"Start `sleep 300 && printf never` in the background (run_in_background), stop it with bash_kill, then run `sleep 3` in the foreground, and confirm that it is stopped from the bash_kill result alone (do not call bash_output).",
	expect: {
		toolsCalled: ["bash", "bash_kill"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			const id = start?.result?.content.match(/\bbg-\d+\b/)?.[0];
			if (!id) return "no background task was started";
			const kill = toolCalls.find((call) => call.name === "bash_kill" && call.args.task_id === id);
			if (!kill) return "the task was not killed by its id";
			const told = messages.some(
				(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`Background task ${id} (`),
			);
			return told ? `the model was told ${id} ended after it killed it itself` : undefined;
		},
	},
};
