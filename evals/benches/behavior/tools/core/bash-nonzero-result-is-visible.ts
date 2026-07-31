import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const bashNonzeroResultIsVisible: EvalCase = {
	id: "bash-nonzero-result-is-visible",
	description: "A failing shell command is observed as a tool error rather than silently treated as success.",
	signals: ["tool-result-integrity", "tool-error-recovery"],
	// Explicitly "as a single, standalone command" — a reasonable model
	// otherwise chains `; echo "exit code: $?"` to be thorough about
	// reporting the code, which flips the *tool's own* isError to false
	// (it reflects the chain's last command, echo, not node) even though
	// the model's prose about the result stays completely correct. That's a
	// test-mechanism gap, not a model one — this pins down the one thing
	// the mechanism actually needs.
	prompt:
		'Run `node -e "process.exit(7)"` as a single, standalone bash command — no chained follow-up commands — ' +
		"and report whether it succeeded; do not retry it.",
	expect: {
		toolsCalled: ["bash"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "bash" && call.result?.isError === true)
				? undefined
				: "non-zero bash exit was not surfaced as an error result",
	},
};
