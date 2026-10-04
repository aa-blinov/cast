import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-btw-no-tools";

export const btwDoesNotReadFiles: EvalCase = {
	id: "btw-does-not-read-files",
	description:
		"A /btw question has no tools: what is only on disk, never read in the conversation, is not in the answer.",
	signals: ["btw", "tool-selection"],
	cwd: fixtureDir(PROJECT),
	setup: () => void writeFixture(PROJECT, { "notes.txt": "the launch code is FILE-ONLY-5532\n" }),
	prompt: "There is a file notes.txt in the working directory. Do not open it. Reply with just OK.",
	sideQuestion: { question: "What does notes.txt say? Answer in one short sentence.", when: "after" },
	expect: {
		noErrors: true,
		toolsNotCalled: ["read", "bash", "grep", "glob"],
		verify: ({ sideAnswer }) => {
			if (sideAnswer?.error) return `the side question failed: ${sideAnswer.error}`;
			return sideAnswer?.text?.includes("FILE-ONLY-5532")
				? "the side answer held what only the file contained"
				: undefined;
		},
	},
};
