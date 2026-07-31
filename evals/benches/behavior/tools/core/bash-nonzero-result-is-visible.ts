import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const bashNonzeroResultIsVisible: EvalCase = {
	id: "bash-nonzero-result-is-visible",
	description: "A failing shell command is observed as a tool error rather than silently treated as success.",
	signals: ["tool-result-integrity", "tool-error-recovery"],
	prompt: 'Check whether `node -e "process.exit(7)"` succeeds and report the observed result; do not retry it.',
	expect: {
		toolsCalled: ["bash"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "bash" && call.result?.isError === true)
				? undefined
				: "non-zero bash exit was not surfaced as an error result",
	},
};
