import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundWaitNoDuplicateNotice: EvalCase = {
	id: "background-wait-no-duplicate-notice",
	description:
		"A background task the model waited on with bash_output is not announced to it again as a message of its own.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 120_000,
	prompt:
		"Start `sleep 6 && printf first-ready` in the background (run_in_background), wait for it with bash_output (wait 20000), and tell me what it printed.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const start = toolCalls.find((call) => call.name === "bash" && call.args.run_in_background === true);
			const id = start?.result?.content.match(/\bbg-\d+\b/)?.[0];
			if (!id) return "no background task was started";
			const waited = toolCalls.find((call) => call.name === "bash_output" && call.args.task_id === id);
			if (!waited?.result?.content.includes("first-ready")) return "the task was not waited on with its id";
			const told = messages.some(
				(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`Background task ${id} (`),
			);
			return told ? `the model was told about ${id} again after it had waited for the result` : undefined;
		},
	},
};
