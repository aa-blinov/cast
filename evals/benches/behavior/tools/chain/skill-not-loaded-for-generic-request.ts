import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const skillNotLoadedForGenericRequest: EvalCase = {
	id: "skill-not-loaded-for-generic-request",
	description: "An ordinary grounded file question doesn't spuriously load any of the built-in skills.",
	signals: ["skill-discovery", "no-unneeded-tools"],
	withSkills: true,
	setup: () => void writeFixture("behavior-skill-no-match", { "config.txt": "max-retries=5\n" }),
	prompt: `What is the max-retries value configured in ${fixturePath("behavior-skill-no-match", "config.txt")}?`,
	expect: {
		toolsCalled: ["read"],
		// None of the built-in skills (arxiv, cast, deep-research, frontend-design,
		// learn-everything, super-research) describe this task — per
		// skills-instructions.md: "Do NOT load a skill when... No skill
		// description matches the task."
		toolsNotCalled: ["skill"],
		noErrors: true,
	},
};
