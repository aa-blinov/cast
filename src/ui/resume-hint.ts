/**
 * The line printed after the screen is gone, since the exit clears the session id along with the rest of
 * the frame. A session that had a turn names itself; an empty one (nothing was said, or the conversation
 * was cleared with /clear or /new) points to the earlier sessions of this folder if there are any, so the
 * way back is never left unsaid.
 */
export function resumeHint(
	session: { id: string; hasMessages: boolean },
	earlierInThisFolder: boolean,
): string | undefined {
	if (session.hasMessages) return `\x1b[2mResume this session:\x1b[22m cast --resume=${session.id}`;
	if (earlierInThisFolder)
		return "\x1b[2mEarlier session in this folder:\x1b[22m cast --continue  (or cast --resume to pick)";
	return undefined;
}
