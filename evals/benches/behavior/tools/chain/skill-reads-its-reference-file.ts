import { join } from "node:path";
import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const SKILLS = join(import.meta.dirname, "../../../../fixtures/skills");

export const skillReadsItsReferenceFile: EvalCase = {
	id: "skill-reads-its-reference-file",
	description:
		"A skill that points at a file in its own directory: the agent loads the skill, reads that file, and follows the rule in it.",
	signals: ["skill-discovery", "tool-chain"],
	withSkills: true,
	skillPaths: [join(SKILLS, "release-notes")],
	setup: () =>
		void writeFixture("behavior-release-notes", { "CHANGES.md": "- fixed the login bug\n- added dark mode\n" }),
	prompt: `Write release notes for ${fixturePath("behavior-release-notes", "CHANGES.md")}.`,
	expect: {
		toolsCalled: ["skill", "read"],
		containsAll: [">>REL<<", "FINISHED-77"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const readStyle = toolCalls.some(
				(c) => c.name === "read" && String(c.args.path ?? "").endsWith("references/style.md"),
			);
			return readStyle ? undefined : "it never read the skill's references/style.md";
		},
	},
};
