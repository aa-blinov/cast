import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const skillLoadsMatchingWorkflow: EvalCase = {
	id: "skill-loads-matching-workflow",
	description: "A matching user request causes the agent to load a discovered skill before proceeding.",
	signals: ["skill-discovery", "tool-result-integrity"],
	withSkills: true,
	prompt:
		"I need a literature lookup for arXiv paper 1706.03762, including its metadata and abstract. Use the appropriate specialized workflow.",
	expect: { toolsCalled: ["skill"], noErrors: true },
};
