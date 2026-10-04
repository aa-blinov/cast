import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-rule-lazy";
const FILES = {
	".cast/rules/commit-messages.md":
		"---\nalways-apply: false\ndescription: Use when writing a git commit message\n---\nEvery commit message must start with the prefix [CAST-7] followed by a space.\n",
};

export const ruleLazyReadWhenRelevant: EvalCase = {
	id: "rule-lazy-read-when-relevant",
	description: "A lazy rule is listed by description: the agent reads its file when the task matches, and follows it.",
	signals: ["rules", "tool-chain"],
	setup: () => void writeFixture(PROJECT, FILES),
	rulesProject: () => writeFixture(PROJECT, FILES),
	prompt: "Write a git commit message for a change that adds a login page. Give just the message.",
	expect: {
		toolsCalled: ["read"],
		containsAll: ["[CAST-7]"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(c) =>
					c.name === "read" &&
					String(c.args.path ?? "") === fixturePath(PROJECT, ".cast/rules/commit-messages.md"),
			)
				? undefined
				: "it never read the commit-messages rule file",
	},
};
