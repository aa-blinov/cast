/**
 * A fork that carries the files of its point, not only the conversation.
 *
 * A plain fork shares the working folder with its source, so a fork from the
 * middle of a conversation talks about files that have moved on. Every turn
 * starts with a snapshot of the folder (see checkpoint.ts) and knows which
 * message it started with, so the files as they were at a cut are the snapshot
 * of the first turn at or after it: the fork gets its own folder holding them.
 */

import { checkpointAtCut, forkFilesKind, materializeCheckpoint, NO_SNAPSHOT_ERROR } from "./checkpoint.ts";
import { forkSession, newSessionId, type SessionState } from "./session.ts";

export const WHOLE_SESSION_FILES_ERROR = "That is the whole session: its files are the current ones";

export interface ForkFilesPreview {
	canCopyFiles: boolean;
	kind?: "worktree" | "snapshot";
	reason?: string;
}

/** Whether a fork at this cut can have its own copy of the files, and how. */
export async function previewForkFiles(source: SessionState, beforeSeq: number | undefined): Promise<ForkFilesPreview> {
	if (beforeSeq === undefined) return { canCopyFiles: false, reason: "The whole session shares the current files" };
	const kind = await forkFilesKind(checkpointAtCut(source.checkpoints ?? [], beforeSeq));
	return kind.ok ? { canCopyFiles: true, kind: kind.kind } : { canCopyFiles: false, reason: kind.error };
}

/** The fork of `source` at the cut, in a folder of its own with the files as they were then. */
export async function forkSessionWithFiles(
	source: SessionState,
	beforeSeq: number | undefined,
): Promise<{ session?: SessionState; error?: string }> {
	if (beforeSeq === undefined) return { error: WHOLE_SESSION_FILES_ERROR };
	const checkpoint = checkpointAtCut(source.checkpoints ?? [], beforeSeq);
	if (!checkpoint) return { error: NO_SNAPSHOT_ERROR };
	// The id first: a snapshot copy lives in a sandbox folder named after the session.
	const id = newSessionId();
	const files = await materializeCheckpoint(checkpoint, id);
	if (!files.ok) return { error: files.error };
	return { session: forkSession(source, beforeSeq, { id, cwd: files.cwd }) };
}
