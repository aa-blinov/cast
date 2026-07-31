import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-plan-reentry-cwd";

// This went through the same escalating fixture-patching cycle plan-done-signal.ts
// documents: a code-shaped plan ("update the login handler"/"session middleware")
// gave a thorough model something to chase no matter how much fixture was added —
// first the real cast repo (isolated cwd fixed that), then a missing middleware
// file, then a helper function the fixture referenced but never defined, then
// JWT library conventions nothing in the fixture could ever fully specify. Each
// fix bought one more attempt before the next gap surfaced (2/3, then 1/3, then
// back to 0/3) — a losing game against GROUND. The actual fix, same as
// plan-done-signal.ts: this case exists to test RE-ENTRY (find + continue an
// existing plan file), not code-plan quality, so make the plan's *content*
// organizational instead of code-shaped — nothing left to cross-check.
const PLAN_CONTENT =
	"# Vendor security review plan\n\nContext: review the analytics vendor Acme Metrics before the contract renews.\n\n" +
	"- [ ] Confirm Acme Metrics' SOC 2 report is current\n";

export const planReentryReusesExistingPlan: EvalCase = {
	id: "plan-reentry-reuses-existing-plan",
	description: "Continuing an in-progress plan reuses the existing plan file (RE-ENTRY) instead of starting a new one.",
	signals: ["plan-lifecycle", "state-persistence"],
	mode: "plan",
	setup: () => void writeFixture(FIXTURE_ID, {}),
	cwd: fixtureDir(FIXTURE_ID),
	planFixture: { name: "vendor-review-plan", content: PLAN_CONTENT },
	// RE-ENTRY's ls+read adds a turn or two before the actual edit; the
	// default 60s cut at least one otherwise-clean attempt off right after
	// the read, mid-generation of the edit itself.
	timeout: 90_000,
	// Deliberately doesn't name the file or tell the agent to reuse it — plan
	// mode's own system prompt (step 0, RE-ENTRY) is what's supposed to make
	// it ls/glob {{PLANS_DIR}}, find the existing plan for this task, and
	// read+edit that file rather than writing a fresh one.
	prompt:
		"Continue the vendor security review already in progress: add a step to schedule a follow-up call with " +
		"Acme Metrics' security team to walk through their access-control model.",
	expect: {
		toolsCalled: ["read", "edit"],
		// A `write` here would mean it started a second plan file instead of
		// continuing the one already on disk.
		toolsNotCalled: ["write"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) =>
					call.name === "edit" && typeof call.args.filePath === "string" && call.args.filePath.includes("vendor-review-plan"),
			)
				? undefined
				: "the existing plan file was not found and continued via edit — RE-ENTRY was skipped or a new plan was likely started",
	},
};
