/**
 * Rewinding a session to before one of the user's messages, with a choice of
 * what goes back: the files, the conversation, or both.
 *
 * `/undo` takes the last turn back. This takes any turn back, using the snapshot
 * each turn records at its start (checkpoint.ts) and the message it started with
 * (userSeq). Files only keeps the conversation and every later snapshot, so the
 * files can be put back to a later point again; a rewind that removes turns drops
 * their snapshots with them, since nothing would ever restore them.
 */

import { filesLostByRestore, releaseCheckpointRefs, restoreCheckpoint, type TurnCheckpoint } from "./checkpoint.ts";
import type { Message } from "./llm.ts";
import {
	deleteMessagesFrom,
	dropCheckpointsFrom,
	getFullHistoryWithReasoning,
	type SessionState,
	seqOfMessage,
} from "./session.ts";

/** What goes back. */
export type RewindMode = "both" | "conversation" | "code";

export const REWIND_MODES: readonly RewindMode[] = ["both", "conversation", "code"];

export interface RewindPoint {
	/** seq of the user message the turn started with. */
	userSeq: number;
	text: string;
}

export interface RewindPreview {
	available: boolean;
	reason?: string;
	/** How the files come back; absent when only shell-free edit/write copies exist. */
	kind?: "git" | "snapshot" | "files";
	shellChangesCovered?: boolean;
	/** The message the rewind goes back to, and how many turns (this one and later) it removes. */
	message?: string;
	turns?: number;
	/** False when the message left the conversation the model sees (compaction): files only. */
	conversationAvailable?: boolean;
	/** Files created since that the restore deletes for good, at most 20 names. */
	lost?: string[];
	lostTotal?: number;
}

const MAX_LOST_LISTED = 20;
const MESSAGE_PREVIEW_CHARS = 200;
const WHITESPACE_RE = /\s+/g;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "",
		)
		.join(" ");
}

function oneLine(text: string): string {
	const line = text.replace(WHITESPACE_RE, " ").trim();
	return line.length > MESSAGE_PREVIEW_CHARS ? `${line.slice(0, MESSAGE_PREVIEW_CHARS)}…` : line;
}

/** Index of the message in the conversation the model sees, or -1 (compacted away). */
function messageIndexOf(session: SessionState, userSeq: number): number {
	return session.messages.findIndex((m) => seqOfMessage(session.id, m as Message) === userSeq);
}

/** The turns that can be rewound to, oldest first: those whose snapshot knows its message. */
export function listRewindPoints(session: SessionState): RewindPoint[] {
	const wanted = new Set(
		(session.checkpoints ?? []).map((c) => c.userSeq).filter((s): s is number => s !== undefined),
	);
	if (wanted.size === 0) return [];
	const { messages, seqs } = getFullHistoryWithReasoning(session.id);
	const points: RewindPoint[] = [];
	messages.forEach((m, i) => {
		const seq = seqs[i];
		if (seq !== undefined && m.role === "user" && wanted.has(seq))
			points.push({ userSeq: seq, text: oneLine(textOf(m.content)) });
	});
	return points;
}

function checkpointFor(session: SessionState, userSeq: number): { checkpoint?: TurnCheckpoint; index: number } {
	const checkpoints = session.checkpoints ?? [];
	const index = checkpoints.findIndex((c) => c.userSeq === userSeq);
	return { checkpoint: checkpoints[index], index };
}

/** What a rewind to before this message would do, without doing it. */
export async function previewRewind(session: SessionState, userSeq: number): Promise<RewindPreview> {
	const { checkpoint, index } = checkpointFor(session, userSeq);
	if (!checkpoint) return { available: false, reason: "There is no snapshot for that message (an older session)." };
	const messageIndex = messageIndexOf(session, userSeq);
	const kind = checkpoint.shadowDir ? "snapshot" : checkpoint.gitCommitSha ? "git" : "files";
	const lost = await filesLostByRestore(checkpoint);
	const message = messageIndex === -1 ? undefined : oneLine(textOf(session.messages[messageIndex]?.content));
	return {
		available: true,
		kind,
		shellChangesCovered: kind !== "files",
		...(message !== undefined ? { message } : {}),
		turns: (session.checkpoints ?? []).length - index,
		conversationAvailable: messageIndex !== -1,
		lost: lost.slice(0, MAX_LOST_LISTED),
		lostTotal: lost.length,
	};
}

export type RewindResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Rewinds to before the message with `userSeq`. `both` restores the files and
 * removes that turn and every later one; `conversation` only removes them;
 * `code` only restores the files and keeps everything else. Refuses, unless
 * forced, when restoring would delete files created since.
 */
export async function rewindSession(
	session: SessionState,
	userSeq: number,
	mode: RewindMode,
	options: { force: boolean },
): Promise<RewindResult> {
	const checkpoints = session.checkpoints ?? [];
	const { checkpoint, index } = checkpointFor(session, userSeq);
	if (!checkpoint) return { ok: false, error: "There is no snapshot for that message" };
	const touchesFiles = mode !== "conversation";
	const touchesConversation = mode !== "code";
	let messageIndex = -1;
	if (touchesConversation) {
		messageIndex = messageIndexOf(session, userSeq);
		if (messageIndex === -1) {
			return {
				ok: false,
				error: "That message is no longer in the conversation the model sees: rewind the files only",
			};
		}
	}
	if (touchesFiles && !options.force) {
		const lost = await filesLostByRestore(checkpoint);
		if (lost.length > 0) {
			const shown = lost.slice(0, 10).join(", ");
			const more = lost.length > 10 ? `, and ${lost.length - 10} more` : "";
			return {
				ok: false,
				error: `Rewinding would delete ${lost.length} file(s) created since (${shown}${more}). Re-run with --force to proceed.`,
			};
		}
	}
	let filesNote = "";
	if (touchesFiles) {
		// Files only leaves the snapshot in the list, so it stays pinned.
		const restored = await restoreCheckpoint(checkpoint, { keepRef: mode === "code" });
		if (!restored.ok) return { ok: false, error: `Rewind failed: ${restored.message}` };
		filesNote = restored.message;
	}
	if (touchesConversation) {
		// The turns that go take their snapshots with them; the target's own ref went with its restore.
		const dropped = mode === "both" ? checkpoints.slice(index + 1) : checkpoints.slice(index);
		dropCheckpointsFrom(session.id, index);
		await releaseCheckpointRefs(dropped);
		deleteMessagesFrom(session, session.messages[messageIndex] as Message);
		session.messages = session.messages.slice(0, messageIndex);
		session.checkpoints = checkpoints.slice(0, index);
	}
	const turns = checkpoints.length - index;
	const what =
		mode === "both"
			? `files and conversation (${turns} turn${turns === 1 ? "" : "s"})`
			: mode === "conversation"
				? `conversation (${turns} turn${turns === 1 ? "" : "s"}); the files were left as they are`
				: "files; the conversation was kept";
	return { ok: true, message: `Rewound: ${what}${filesNote ? `. ${filesNote}` : ""}` };
}
