import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";
import { git, gitProject } from "./fixture.ts";

const project = gitProject("behavior-worktree-enter");

export const worktreeEntersAndWorksThere: EvalCase = {
	id: "worktree-enters-and-works-there",
	description:
		"Asked for an isolated worktree and a file in it, the agent uses the worktree tool (not git worktree add in bash) and the file lands in the worktree, not the main checkout.",
	signals: ["worktree", "filesystem-safety"],
	worktree: true,
	cwd: project.cwd,
	setup: project.setup,
	prompt:
		"Create an isolated git worktree called feature-x for this repository, then create hello.txt containing the word hi inside that worktree. Do not change any file in the main checkout.",
	expect: {
		toolsCalled: ["worktree"],
		noErrors: true,
		// Where it ends up is its choice (it may leave to check the main checkout is unchanged); where the file is, is not.
		verify: ({ cwd, toolCalls }) => {
			const worktree = join(cwd, ".cast", "worktrees", "feature-x");
			if (!existsSync(join(worktree, "hello.txt"))) return "hello.txt is not in the worktree";
			if (readFileSync(join(worktree, "hello.txt"), "utf8").trim() !== "hi") return "hello.txt does not hold hi";
			if (existsSync(join(cwd, "hello.txt"))) return "hello.txt was also put in the main checkout";
			if (git(worktree, ["branch", "--show-current"]) !== "cast-feature-x")
				return "the worktree is not on cast-feature-x";
			const bashed = toolCalls.find(
				(c) => c.name === "bash" && /git\s+worktree\s+add/.test(String(c.args.command ?? "")),
			);
			return bashed ? "it made the worktree with git worktree add in bash instead of the tool" : undefined;
		},
	},
};
