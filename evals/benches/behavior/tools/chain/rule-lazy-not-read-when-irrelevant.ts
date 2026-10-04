import { writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-rule-lazy-skip";
const FILES = {
	".cast/rules/commit-messages.md":
		"---\nalways-apply: false\ndescription: Use when writing a git commit message\n---\nEvery commit message must start with the prefix [CAST-7] followed by a space.\n",
};

export const ruleLazyNotReadWhenIrrelevant: EvalCase = {
	id: "rule-lazy-not-read-when-irrelevant",
	description: "A lazy rule about commit messages stays unread when the task has nothing to do with it.",
	signals: ["rules", "tool-selection"],
	setup: () => void writeFixture(PROJECT, FILES),
	rulesProject: () => writeFixture(PROJECT, FILES),
	prompt: "What is 17 times 3? Answer with just the number.",
	expect: {
		containsAll: ["51"],
		toolsNotCalled: ["read", "glob", "grep", "bash"],
		noErrors: true,
	},
};
