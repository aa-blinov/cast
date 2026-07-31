import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const complexRequestEntersPlan: EvalCase = {
	id: "complex-request-enters-plan",
	description: "A cross-system authentication migration requests plan mode before implementation.",
	signals: ["mode-selection", "plan-safety"],
	mode: "build",
	prompt:
		"Replace authentication across web, API, mobile clients, database migration, SSO, rollout and rollback. Start the work.",
	expect: {
		toolsCalled: ["plan_enter"],
		toolsNotCalled: ["write", "edit"],
		maxTurns: 1,
		noErrors: true,
	},
};
