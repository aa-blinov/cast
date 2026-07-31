import type { EvalCase } from "../../../../lib/runner.ts";

export const planReentryReusesExistingPlan: EvalCase = {
	id: "plan-reentry-reuses-existing-plan",
	description: "Continuing an in-progress plan reuses the existing plan file (RE-ENTRY) instead of starting a new one.",
	signals: ["plan-lifecycle", "state-persistence"],
	mode: "plan",
	planFixture: {
		name: "auth-refactor-plan",
		content:
			"# Auth refactor plan\n\nContext: replace the legacy session cookie with a signed JWT.\n\n" +
			"- [ ] Update the login handler to issue a JWT\n",
	},
	// Deliberately doesn't name the file or tell the agent to reuse it — plan
	// mode's own system prompt (step 0, RE-ENTRY) is what's supposed to make
	// it ls/glob {{PLANS_DIR}}, find the existing plan for this task, and
	// read+edit that file rather than writing a fresh one.
	prompt:
		"Continue planning the auth refactor already in progress: add a step to update the session middleware " +
		"to validate the new JWT instead of the old cookie.",
	expect: {
		toolsCalled: ["read", "edit"],
		// A `write` here would mean it started a second plan file instead of
		// continuing the one already on disk.
		toolsNotCalled: ["write"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) =>
					call.name === "edit" && typeof call.args.filePath === "string" && call.args.filePath.includes("auth-refactor-plan"),
			)
				? undefined
				: "the existing plan file was not found and continued via edit — RE-ENTRY was skipped or a new plan was likely started",
	},
};
