import { readFileSync } from "node:fs";
import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const planStepImplementsAndChecks: EvalCase = {
	id: "plan-step-implements-and-checks",
	description: "An approved plan's next step is actually implemented and checked off, without re-entering planning.",
	signals: ["plan-lifecycle", "state-persistence", "tool-chain"],
	mode: "build",
	planFixture: {
		name: "version-bump-plan",
		content: "# Version bump plan\n\nContext: publish a patch release.\n\n- [ ] Update VERSION to 0.13.0\n- [ ] Confirm the published version\n",
	},
	setup: () => void writeFixture("behavior-plan-continue", { VERSION: "0.12.5\n" }),
	prompt:
		`Continue executing the approved plan: complete its first step by updating ${fixturePath("behavior-plan-continue", "VERSION")} ` +
		'to contain exactly "0.13.0", then mark that step done in the plan.',
	expect: {
		toolsCalled: ["plan_check"],
		// The plan is already approved and active — this is implementation work
		// under it, not a re-planning request, and not the end of the planning
		// turn (plan_done is for finishing a *planning* pass).
		toolsNotCalled: ["plan_enter", "plan_done"],
		noErrors: true,
		verify: () => {
			const content = readFileSync(fixturePath("behavior-plan-continue", "VERSION"), "utf-8");
			// The prompt asked for exactly "0.13.0" — accept either with or
			// without a trailing newline rather than over-specifying whitespace
			// the prompt never actually pinned down.
			return content === "0.13.0" || content === "0.13.0\n"
				? undefined
				: "the plan's first step was not actually implemented against the fixture";
		},
	},
};
