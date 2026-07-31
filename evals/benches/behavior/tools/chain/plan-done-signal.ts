import type { EvalCase } from "../../../../lib/runner.ts";

const PLAN_CONTENT =
	"# Release plan\n\nContext: publish the already-built package.\n\n" +
	"- [ ] Run the release verification command\n- [ ] Publish the package\n- [ ] Confirm the published version\n";

export const planDoneSignal: EvalCase = {
	id: "plan-done-signal",
	description: "A completed planning pass emits the terminal plan signal without changing project files.",
	signals: ["plan-lifecycle", "state-transition"],
	mode: "plan",
	planFixture: { name: "release-plan", content: PLAN_CONTENT },
	// `planFixture` only wires up activePlanPath for plan_check/plan_done to
	// act on — it does not inject the plan's text into context. Quoting it
	// back in the prompt (as if the user is pasting the plan they already
	// reviewed) is what makes "I have reviewed this" true for the model,
	// instead of asking it to bless text it has never actually seen.
	prompt:
		`I have reviewed this complete, executable plan and it is ready for approval:\n\n${PLAN_CONTENT}\n` +
		"Finish this planning turn now.",
	// prompts/modes/plan-mode.md's step 0 (RE-ENTRY) requires ls/glob'ing
	// {{PLANS_DIR}} and read'ing the matching file before anything else in
	// *any* plan-mode turn — that's the documented protocol, not slack
	// behavior, so a single-turn expectation here was never realistic.
	// What actually matters is that it converges on plan_done without
	// wandering into real inspection (bash) or touching files (edit).
	expect: { toolsCalled: ["plan_done"], toolsNotCalled: ["bash", "edit"], maxTurns: 5, noErrors: true },
};
