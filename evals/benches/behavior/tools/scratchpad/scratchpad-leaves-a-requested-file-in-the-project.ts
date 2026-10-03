import { existsSync } from "node:fs";
import { join } from "node:path";
import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-scratchpad-deliverable";

export const scratchpadLeavesARequestedFileInTheProject: EvalCase = {
	id: "scratchpad-leaves-a-requested-file-in-the-project",
	description: "A file the user asks for is the result, so it goes in the project, not in the scratchpad.",
	signals: ["scratchpad"],
	scratchpad: true,
	cwd: fixtureDir(FIXTURE_ID),
	setup: () => void writeFixture(FIXTURE_ID, { "README.md": "A small project.\n" }),
	prompt: "Add a file squares.py to this project that prints the squares of 1 to 5, one per line.",
	expect: {
		toolsCalled: ["write"],
		noErrors: true,
		verify: ({ cwd, scratchpad }) => {
			if (!existsSync(join(cwd, "squares.py"))) return "squares.py was not created in the project";
			return scratchpad && existsSync(join(scratchpad, "squares.py"))
				? "the requested file was also put in the scratchpad"
				: undefined;
		},
	},
};
