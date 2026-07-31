import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const taskDelegatesScopedInvestigation: EvalCase = {
	id: "task-delegates-scoped-investigation",
	description: "A delegation-friendly persona sends an independent inspection to a subagent and receives its result.",
	signals: ["delegation", "tool-result-integrity"],
	persona: "coder-with-subagents",
	prompt:
		"Ask a suitable teammate to inspect the repository structure and report the top-level source directory. Do not modify files.",
	expect: { toolsCalled: ["task"], toolsNotCalled: ["write", "edit"], noErrors: true },
};
