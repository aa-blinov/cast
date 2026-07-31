import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const grepFlagsAreGrounded: EvalCase = {
	id: "grep-flags-are-grounded",
	description: "A case-insensitive search request sets grep's ignoreCase flag instead of missing differently-cased matches.",
	signals: ["argument-grounding", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-grep-flags", { "log.txt": "INFO startup\nERROR disk full\ninfo shutdown\n" }),
	prompt: `Find every occurrence of "error" in ${fixturePath("behavior-grep-flags", "log.txt")}, regardless of capitalization.`,
	expect: {
		toolsCalled: ["grep"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const call = toolCalls.find((c) => c.name === "grep");
			return call?.args.ignoreCase === true
				? undefined
				: "grep call did not request a case-insensitive search, so the capitalized match would be missed";
		},
	},
};
