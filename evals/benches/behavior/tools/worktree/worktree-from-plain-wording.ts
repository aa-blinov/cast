import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "../../../../lib/runner.ts";
import { git, gitProject } from "./fixture.ts";

const project = gitProject("behavior-worktree-plain");

export const worktreeFromPlainWording: EvalCase = {
	id: "worktree-from-plain-wording",
	description:
		"A request for an experiment that must not touch the user's checkout, without the word worktree, is done in one: the main checkout's files are unchanged.",
	signals: ["worktree", "filesystem-safety"],
	worktree: true,
	cwd: project.cwd,
	setup: project.setup,
	prompt:
		"I want to try renaming add() to plus() in calc.py, but I don't want to touch my current checkout or branch. Do the experiment somewhere separate and tell me where the result is.",
	expect: {
		toolsCalled: ["worktree"],
		noErrors: true,
		verify: ({ cwd, toolCalls }) => {
			if (git(cwd, ["status", "--short", "--untracked-files=no"]) !== "")
				return "the main checkout's files were changed";
			if (!readFileSync(join(cwd, "calc.py"), "utf8").includes("def add"))
				return "calc.py in the main checkout lost add()";
			const edited = git(cwd, ["worktree", "list", "--porcelain"])
				.split("\n")
				.filter((l) => l.startsWith("worktree ") && l !== `worktree ${cwd}`)
				.map((l) => l.slice("worktree ".length))
				.some((path) => readFileSync(join(path, "calc.py"), "utf8").includes("def plus"));
			if (!edited) return "no worktree holds the renamed function";
			return toolCalls.some((c) => c.name === "bash" && /git\s+worktree\s+add/.test(String(c.args.command ?? "")))
				? "it made the worktree with git worktree add in bash instead of the tool"
				: undefined;
		},
	},
};
