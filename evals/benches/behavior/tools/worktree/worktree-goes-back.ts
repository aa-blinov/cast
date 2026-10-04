import type { EvalCase } from "../../../../lib/runner.ts";
import { git, gitProject } from "./fixture.ts";

const project = gitProject("behavior-worktree-back");

export const worktreeGoesBack: EvalCase = {
	id: "worktree-goes-back",
	description: "Told to leave a worktree it entered, the agent goes back to the main checkout and keeps the worktree.",
	signals: ["worktree"],
	worktree: true,
	cwd: project.cwd,
	setup: project.setup,
	prompt:
		"Move into a worktree called try-1, then go back to the main checkout. Tell me which directory you are working in now.",
	expect: {
		toolsCalled: ["worktree"],
		noErrors: true,
		verify: ({ cwd, finalCwd }) => {
			if (finalCwd !== cwd) return `the agent ended in ${finalCwd}, not the main checkout`;
			return git(cwd, ["worktree", "list"]).includes("cast-try-1") ? undefined : "the worktree try-1 was not kept";
		},
	},
};
