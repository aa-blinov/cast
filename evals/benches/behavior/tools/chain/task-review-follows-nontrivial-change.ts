import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const taskReviewFollowsNontrivialChange: EvalCase = {
	id: "task-review-follows-nontrivial-change",
	description: "A non-trivial, security-sensitive change is proactively validated by the review subagent before being declared done.",
	signals: ["delegation", "state-transition"],
	persona: "coder-with-subagents",
	// The parent's own edit plus a nested review subagent run comfortably
	// pushed 90s in testing — give this real margin.
	timeout: 150_000,
	setup: () =>
		void writeFixture("behavior-proactive-review", {
			"auth.js": "function validatePassword(password) {\n  return true;\n}\n\nmodule.exports = { validatePassword };\n",
		}),
	// Never names "review" or "subagent" — the persona's own guidance
	// ("after a non-trivial change, spawn subagent: review... before
	// declaring complex work done") is what's supposed to trigger this
	// unprompted, for exactly this kind of production, security-sensitive
	// logic.
	prompt:
		`Implement real password validation in ${fixturePath("behavior-proactive-review", "auth.js")}: reject passwords ` +
		"under 8 characters, without a digit, without an uppercase letter, or without a special character. This lands " +
		"in the production signup flow, so make sure the logic is correct before we call it done.",
	expect: {
		toolsCalled: ["edit", "task"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const reviewCall = toolCalls.find((call) => call.name === "task" && call.args.subagent === "review");
			return reviewCall
				? undefined
				: "no review subagent was spawned to independently validate the security-sensitive change before declaring it done";
		},
	},
};
