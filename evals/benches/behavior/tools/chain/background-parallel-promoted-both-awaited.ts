import type { EvalCase } from "../../../../lib/runner.ts";

export const backgroundParallelPromotedBothAwaited: EvalCase = {
	id: "background-parallel-promoted-both-awaited",
	description:
		"Two slow commands run side by side and both are moved to the background: the model waits on both, each runs once, each result is told once.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	timeout: 240_000,
	prompt:
		"Run these two commands at the same time, in one step, and tell me what each printed: " +
		"`sleep 62 && printf alpha-token-1101` and `sleep 63 && printf beta-token-2202`.",
	expect: {
		toolsCalled: ["bash", "bash_output"],
		containsAll: ["alpha-token-1101", "beta-token-2202"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const runs = toolCalls.filter((c) => c.name === "bash");
			const once = (needle: string) => runs.filter((c) => String(c.args.command).includes(needle)).length;
			if (once("alpha-token") !== 1 || once("beta-token") !== 1)
				return "a command was run more than once, or not at all";
			const ids = runs
				.map((c) => c.result?.content.match(/\bbg-\d+\b/)?.[0])
				.filter((id): id is string => Boolean(id));
			const told = (id: string) =>
				messages.some(
					(m) =>
						m.role === "user" && typeof m.content === "string" && m.content.includes(`Background task ${id} (`),
				);
			for (const id of ids) {
				const read = toolCalls.find(
					(c) => c.name === "bash_output" && c.args.task_id === id && c.result?.content.includes("-token-"),
				);
				if (!read) return `${id} was moved to the background and its result was never read`;
				if (told(id)) return `the model was told about ${id} again after it had its result`;
			}
			return undefined;
		},
	},
};
