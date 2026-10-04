import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundPromotedResultAwaited: EvalCase = {
	id: "background-promoted-result-awaited",
	description:
		"A foreground command that runs long is moved to the background; the model needs its output, so it waits with bash_output, gets the result once, and does not run the command again.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 180_000,
	prompt: "Run `sleep 65 && printf long-job-token-4417` and tell me exactly what it printed.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		containsAll: ["long-job-token-4417"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const runs = toolCalls.filter(
				(call) => call.name === "bash" && String(call.args.command).includes("sleep 65"),
			);
			if (runs.length !== 1) return `the command was started ${runs.length} times, not once`;
			const id = runs[0]!.result?.content.match(/\bbg-\d+\b/)?.[0];
			if (!id) return "the command was not moved to the background";
			const waited = toolCalls.find((call) => call.name === "bash_output" && call.args.task_id === id);
			if (!waited?.result?.content.includes("long-job-token-4417"))
				return "the result was not read with bash_output";
			const told = messages.some(
				(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`Background task ${id} (`),
			);
			return told ? `the model was told about ${id} again after it had the result` : undefined;
		},
	},
};
