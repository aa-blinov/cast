import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const taskDelegatesScopedInvestigation: EvalCase = {
	id: "task-delegates-scoped-investigation",
	description: "A delegation-friendly persona sends an independent inspection to a subagent and receives its result.",
	signals: ["delegation", "tool-result-integrity"],
	persona: "coder-with-subagents",
	setup: () => void writeFixture("behavior-delegated-inspection", { "src/index.ts": "export {};\n" }),
	cwd: fixtureDir("behavior-delegated-inspection"),
	prompt:
		"Ask a suitable teammate to inspect the repository structure and report the top-level source directory. Do not modify files.",
	expect: {
		containsAll: ["src"],
		toolsCalled: ["task"],
		toolsNotCalled: ["write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "task" && call.result?.content.includes("src"))
				? undefined
				: "delegated inspection did not return the fixture source directory",
	},
};
