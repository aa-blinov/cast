import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const grepFlagsAreGrounded: EvalCase = {
	id: "grep-flags-are-grounded",
	description: "A case-insensitive search finds the differently-cased match without changing the file.",
	signals: ["tool-result-integrity", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-grep-flags", { "log.txt": "INFO startup\nERROR disk full\ninfo shutdown\n" }),
	prompt: `Find every occurrence of "error" in ${fixturePath("behavior-grep-flags", "log.txt")}, regardless of capitalization.`,
	expect: {
		containsAll: ["ERROR", "disk full"],
		toolsNotCalled: ["write", "edit"],
		noErrors: true,
	},
};
