import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const planDiscardRemovesDraft: EvalCase = {
	id: "plan-discard-removes-draft",
	description: "An abandoned planning draft is discarded through the plan lifecycle signal.",
	signals: ["plan-lifecycle", "state-transition"],
	mode: "plan",
	planFixture: { name: "abandoned-plan", content: "# Abandoned plan\n\n- [ ] Do not ship\n" },
	prompt: "This planning draft is no longer needed. Abandon the current plan.",
	expect: { toolsCalled: ["plan_discard"], toolsNotCalled: ["write", "edit"], noErrors: true },
};
