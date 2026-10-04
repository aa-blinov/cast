import { execFileSync } from "node:child_process";
import type { EvalCase } from "../../../../lib/runner.ts";
import { git, gitProject } from "./fixture.ts";

const project = gitProject("behavior-worktree-unasked");

export const worktreeNotOnItsOwn: EvalCase = {
	id: "worktree-not-on-its-own",
	description:
		"An ordinary fix, with no mention of isolation, is made in the checkout it was asked in: no worktree is made.",
	signals: ["worktree", "restraint"],
	worktree: true,
	cwd: project.cwd,
	setup: project.setup,
	prompt: "Make add() in calc.py treat None as 0.",
	expect: {
		toolsNotCalled: ["worktree"],
		noErrors: true,
		verify: ({ cwd, finalCwd }) => {
			if (finalCwd !== cwd) return `the agent moved to ${finalCwd}`;
			// Run it rather than look for a word: None can be handled in several ways.
			try {
				execFileSync(
					"python3",
					["-c", "from calc import add; assert add(None, 2) == 2 and add(3, None) == 3 and add(None, None) == 0 and add(1, 2) == 3"],
					{ cwd, stdio: "pipe" },
				);
			} catch {
				return "add() in the checkout does not treat None as 0";
			}
			return git(cwd, ["worktree", "list"]).split("\n").length === 1 ? undefined : "a worktree was made";
		},
	},
};
