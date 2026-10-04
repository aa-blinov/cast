import { join, relative, sep } from "node:path";

/** Where cast keeps the worktrees it makes for a project, inside it. */
export const WORKTREES_SUBPATH = join(".cast", "worktrees");

/**
 * Whether a session working in `sessionCwd` is one of the project at `projectCwd`: it works in that very directory,
 * or in a worktree cast made for it (`<project>/.cast/worktrees/<name>`). A session that moved into a worktree is
 * still the project's, so "continue the last session here" and a project's session list find it from the project.
 * Paths only, no git: this runs in the thin client too.
 */
export function sessionIsInProject(sessionCwd: string | undefined, projectCwd: string): boolean {
	if (!sessionCwd) return false;
	if (sessionCwd === projectCwd) return true;
	const rel = relative(join(projectCwd, WORKTREES_SUBPATH), sessionCwd);
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel);
}
