import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-plan-open-question";

export const planOpenQuestionBlocksDone: EvalCase = {
	id: "plan-open-question-blocks-done",
	description:
		"A genuine unresolved tradeoff keeps the plan from converging — the agent opens a decision picker instead of guessing and requesting review.",
	signals: ["plan-lifecycle", "plan-safety"],
	mode: "plan",
	setup: () =>
		void writeFixture(FIXTURE_ID, {
			"handler.ts": "export async function getUser(id: string) {\n  return db.query(id);\n}\n",
		}),
	// This case checks one thing: an open decision of substance sends the agent to
	// the picker (plan-mode.md step 4, CONVERGE) rather than letting it pick for the
	// user. It used to also tell the agent to "finalize it right away", which turned
	// it into a test of whether policy outranks a direct instruction — a separate
	// question, and not one this case should be quietly deciding.
	// The tradeoff and its scope are spelled out fully in the prompt, but "nothing
	// else needs investigating" is a claim, not a guarantee — with the real repo as
	// cwd, deepseek (and to a lesser extent other models) went looking for
	// package.json/surrounding dependencies anyway, burning the turn budget on
	// exploration instead of ever reaching `write`. An isolated cwd containing only
	// this fixture (see plan-done-signal.ts for the same fix, same root cause) makes
	// the claim true instead of just asserted.
	cwd: fixtureDir(FIXTURE_ID),
	// Drafting a decision-complete plan (concrete steps for both options, a
	// verification section, assumptions — see plan-mode.md's "Plan structure")
	// is a lot of generation on top of the RE-ENTRY ls/read turns; the default
	// 60s cut some models off mid-draft before they ever reached `write`.
	timeout: 180_000,
	prompt:
		`Write a plan to add caching in front of ${fixturePath("behavior-plan-open-question", "handler.ts")}. Two ` +
		"implementation options exist, each with a real tradeoff: in-memory (zero ops overhead, but each server " +
		"instance holds a different cache — stale/inconsistent reads across instances) or Redis (consistent across " +
		"instances, but adds an operational dependency to run and monitor). Nothing else needs investigating for " +
		"this — the tradeoff is exactly as stated.",
	expect: {
		toolsCalled: ["question"],
		toolsNotCalled: ["plan_done"],
		noErrors: true,
	},
};
