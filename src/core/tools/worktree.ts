import { relative } from "node:path";
import { createSessionWorktree, findCanonicalGitRoot, listWorktrees, samePath } from "../worktree.ts";
import type { ToolResult } from "./shared.ts";

export interface WorktreeToolDeps {
	/** Where the agent works now. Read at every call: it changes when the agent moves into a worktree. */
	cwd: () => string;
	sessionId?: string;
	/** The WorktreeCreate hook is trust-gated like every other project resource. */
	projectTrusted: boolean;
	/** Moves the agent's working directory and has the host record it (the session, its prompt, the clients). */
	switchTo: (path: string, previous: string) => void | Promise<void>;
}

export const WORKTREE_TOOL_DESCRIPTION = `Work in an isolated git worktree: a second checkout of this repository on its own branch, so changes do not touch the user's current files or branch.
- enter: create the worktree <name> (or reuse it) under .cast/worktrees/<name> on branch cast-<name>, and move into it. From then on relative paths and bash run there. Everything you change there is on that branch; the user's checkout stays as it was.
- exit: go back to the main checkout. The worktree and its branch are kept.
- list: the worktrees of this repository, and which one you are in.
Use it when the user asks for a worktree or for an isolated copy to try something in. Do not move into one on your own, and do not make one with git worktree add in bash: that one is not tracked, and you would not be working in it. Call it alone, not in a message with other tool calls. Removing a worktree is the user's, with /worktree remove.`;

const SLUG_HELP = "a short name: letters, digits, dot, dash, underscore";

/** The worktree the directory is in (or a folder of), if it is one of cast's. */
function currentWorktree(cwd: string): { name: string; path: string; branch: string } | undefined {
	return listWorktrees(cwd).find((w) => {
		const rel = relative(w.path, cwd);
		return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
	});
}

export async function execWorktree(args: Record<string, unknown>, deps: WorktreeToolDeps): Promise<ToolResult> {
	const action = typeof args.action === "string" ? args.action : "";
	const cwd = deps.cwd();
	if (action === "list") {
		const root = findCanonicalGitRoot(cwd);
		if (!root) return { content: "Error: this directory is not in a git repository.", isError: true };
		const here = currentWorktree(cwd);
		const lines = listWorktrees(cwd).map(
			(w) => `${here && samePath(here.path, w.path) ? "* " : "  "}${w.name}  (${w.branch})  ${w.path}`,
		);
		const header = `Main checkout: ${root}${here ? "" : "  (you are here)"}`;
		return { content: lines.length > 0 ? `${header}\n${lines.join("\n")}` : `${header}\nNo worktrees yet.` };
	}
	if (action === "exit") {
		const here = currentWorktree(cwd);
		const root = findCanonicalGitRoot(cwd);
		if (!here || !root) return { content: "Error: you are not in a worktree; nothing to leave.", isError: true };
		await deps.switchTo(root, cwd);
		return {
			content: `Back in the main checkout: ${root}. The worktree "${here.name}" (branch ${here.branch}) is kept at ${here.path}.`,
		};
	}
	if (action === "enter") {
		const name = typeof args.name === "string" ? args.name.trim() : "";
		if (!name) return { content: `Error: name is required (${SLUG_HELP}).`, isError: true };
		let worktree: Awaited<ReturnType<typeof createSessionWorktree>>;
		try {
			worktree = await createSessionWorktree(name, cwd, {
				sessionId: deps.sessionId,
				projectTrusted: deps.projectTrusted,
			});
		} catch (err) {
			return { content: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
		if (samePath(worktree.path, cwd)) {
			return {
				content: `Already in the worktree "${worktree.name}" (${worktree.path}), branch ${worktree.branch}.`,
			};
		}
		await deps.switchTo(worktree.path, cwd);
		return {
			content: `Now working in the worktree "${worktree.name}": ${worktree.path} (branch ${worktree.branch}). Relative paths and bash run here. The main checkout at ${worktree.repoRoot} keeps its files and its branch; use action exit to go back.`,
		};
	}
	return { content: "Error: action must be enter, exit or list.", isError: true };
}
