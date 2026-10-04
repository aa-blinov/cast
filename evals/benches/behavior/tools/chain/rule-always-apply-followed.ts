import { writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-rule-always";

export const ruleAlwaysApplyFollowed: EvalCase = {
	id: "rule-always-apply-followed",
	description: "An always-apply rule is in the system prompt: the agent follows it without reading any file.",
	signals: ["rules", "instruction-following"],
	setup: () =>
		void writeFixture(PROJECT, {
			".cast/rules/closing.md":
				"---\nalways-apply: true\n---\nEvery answer you give must end with the exact token RULE-END-5521 on its own last line.\n",
		}),
	rulesProject: () =>
		writeFixture(PROJECT, {
			".cast/rules/closing.md":
				"---\nalways-apply: true\n---\nEvery answer you give must end with the exact token RULE-END-5521 on its own last line.\n",
		}),
	prompt: "What is the capital of Portugal? Answer in one short sentence.",
	expect: {
		containsAll: ["Lisbon", "RULE-END-5521"],
		toolsNotCalled: ["read", "glob", "grep", "bash"],
		noErrors: true,
	},
};
