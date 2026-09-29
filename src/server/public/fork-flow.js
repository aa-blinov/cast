/**
 * The question asked before forking from an earlier point, when the point has a
 * snapshot of the files: the fork can get its own copy of them, or share the
 * folder as it is now.
 */
export function describeFork(preview) {
	const copy =
		preview.kind === "worktree"
			? "Its own copy is a git worktree of your project at that point; files git ignores (node_modules, build output) are not in it."
			: "Its own copy is a new sandbox folder with the files as they were then; dependency and build folders are left out.";
	return [
		"Fork from this point. Give the fork its own copy of the files as they were then?",
		copy,
		"Or fork into the same folder: the conversation is cut here, but the files stay as they are now.",
	].join("\n\n");
}

/** The toast after a fork, which says where the files are. */
export function forkNotice({ withFiles, cwd }) {
	return withFiles
		? `Forked, with its own copy of the files in ${cwd}.`
		: "Forked. Both sessions share the working folder, so the files are as they are now, not as they were at that point.";
}
