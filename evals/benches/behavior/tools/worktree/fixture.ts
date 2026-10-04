import { execFileSync } from "node:child_process";
import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" };

export const git = (cwd: string, args: string[]): string =>
	execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A small git repository with one commit: the project a worktree is made from. */
export function gitProject(id: string): { cwd: string; setup: () => void } {
	return {
		cwd: fixtureDir(id),
		setup: () => {
			const dir = writeFixture(id, {
				"calc.py": "def add(a, b):\n    return a + b\n",
				"README.md": "# calc\n",
			});
			git(dir, ["init", "-q"]);
			git(dir, ["config", "user.email", "eval@example.com"]);
			git(dir, ["config", "user.name", "eval"]);
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-qm", "init"]);
		},
	};
}
