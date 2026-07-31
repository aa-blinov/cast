import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const planCheckUpdatesActivePlan: EvalCase = {
	id: "plan-check-updates-active-plan",
	description: "Completing an approved plan step marks the matching checklist item.",
	signals: ["plan-lifecycle", "state-persistence"],
	mode: "build",
	planFixture: { name: "approved-plan", content: "# Approved plan\n\n- [ ] Publish the release\n" },
	prompt: "The first step in the approved plan is complete. Mark that step finished in the plan.",
	expect: { toolsCalled: ["plan_check"], noErrors: true },
};
