/**
 * /undo for the daemon: what it would do (for a confirmation dialog) and doing
 * it. Shared by the slash command and the web UI's Undo button, so both say the
 * same thing and go through the same guards.
 */

import { filesLostByRestore, restoreCheckpoint } from "../../core/checkpoint.ts";
import type { Message } from "../../core/llm.ts";
import { previewRewind, type RewindMode, type RewindPreview, rewindSession } from "../../core/rewind.ts";
import { deleteMessagesFrom, dropLastCheckpoint } from "../../core/session.ts";
import type { WebAgentSession } from "../bridge.ts";
import type { CommandResult } from "./command-registry.ts";

/** How the folder's files will be brought back. */
export type UndoKind = "git" | "snapshot" | "files";

export interface UndoPreview {
	available: boolean;
	/** Why not, when it isn't available. */
	reason?: string;
	kind?: UndoKind;
	/** False when only files changed with edit/write come back (a folder too big to snapshot). */
	shellChangesCovered?: boolean;
	/** The user message that will be removed, cut to a line, and how many messages go with it. */
	removedMessage?: string;
	removedMessages?: number;
	/** Files created since the checkpoint that the restore deletes for good, at most 20 names. */
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

function lastUserIndex(ws: WebAgentSession): number {
	const messages = ws.session.messages;
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") return i;
	return -1;
}

export async function previewUndo(ws: WebAgentSession): Promise<UndoPreview> {
	if (ws.status === "running")
		return { available: false, reason: "The agent is still working: stop it or wait first." };
	if (ws.undoing) return { available: false, reason: "An undo is already in progress." };
	const checkpoints = ws.session.checkpoints ?? [];
	const checkpoint = checkpoints[checkpoints.length - 1];
	if (!checkpoint) return { available: false, reason: "Nothing to undo: no checkpoint was taken yet." };
	const index = lastUserIndex(ws);
	const kind: UndoKind = checkpoint.shadowDir ? "snapshot" : checkpoint.gitCommitSha ? "git" : "files";
	const lost = await filesLostByRestore(checkpoint);
	const removed =
		index === -1 ? undefined : textOf(ws.session.messages[index]?.content).replace(WHITESPACE_RE, " ").trim();
	return {
		available: true,
		kind,
		shellChangesCovered: kind !== "files",
		...(removed !== undefined
			? {
					removedMessage:
						removed.length > MESSAGE_PREVIEW_CHARS ? `${removed.slice(0, MESSAGE_PREVIEW_CHARS)}…` : removed,
					removedMessages: ws.session.messages.length - index,
				}
			: {}),
		lost: lost.slice(0, MAX_LOST_LISTED),
		lostTotal: lost.length,
	};
}

/** Restores the last checkpoint and drops the last turn from the conversation. */
export async function undoLastTurn(
	ws: WebAgentSession,
	options: { force: boolean; saveSession: (session: WebAgentSession["session"]) => void },
	onDone: () => void,
): Promise<CommandResult> {
	if (ws.undoing) return { ok: false, error: "An undo is already in progress" };
	const checkpoints = ws.session.checkpoints ?? [];
	const checkpoint = checkpoints[checkpoints.length - 1];
	if (!checkpoint) return { ok: false, error: "No checkpoint available to undo" };
	// The restore awaits git, and nothing else stops a message sent meanwhile
	// from starting a turn on the folder that is being rewound.
	ws.undoing = true;
	try {
		// `git clean -fd` runs as part of the restore and takes untracked
		// files created after the checkpoint with it — including anything the
		// user wrote while the agent worked. Name them and refuse unless forced.
		const lost = await filesLostByRestore(checkpoint);
		if (lost.length > 0 && !options.force) {
			const shown = lost.slice(0, 10).join(", ");
			const more = lost.length > 10 ? `, and ${lost.length - 10} more` : "";
			return {
				ok: false,
				error: `Undo would delete ${lost.length} file(s) created since the checkpoint (${shown}${more}). Re-run as "/undo --force" to proceed.`,
			};
		}
		const res = await restoreCheckpoint(checkpoint);
		if (!res.ok) return { ok: false, error: `Undo failed: ${res.message}` };
		// Popped only now, and from the live array: taking it off first meant a
		// failed restore lost the checkpoint here (the store still had it) and the
		// user could not retry until the daemon restarted.
		checkpoints.pop();
		// Drop the matching row so the persisted list stays in sync.
		dropLastCheckpoint(ws.session.id);
		const index = lastUserIndex(ws);
		if (index !== -1) {
			// Deleted from the store too: saveSession only appends, so slicing the
			// array alone brought the turn back on the next load.
			deleteMessagesFrom(ws.session, ws.session.messages[index] as Message);
			ws.session.messages = ws.session.messages.slice(0, index);
		}
		ws.session.checkpoints = checkpoints;
		options.saveSession(ws.session);
		onDone();
		return { ok: true, result: `Undone: ${res.message}` };
	} finally {
		ws.undoing = false;
	}
}

/** What rewinding to before the message `userSeq` would do; not available while a turn runs. */
export async function previewRewindFor(ws: WebAgentSession, userSeq: number): Promise<RewindPreview> {
	if (ws.status === "running")
		return { available: false, reason: "The agent is still working: stop it or wait first." };
	if (ws.undoing) return { available: false, reason: "An undo or rewind is already in progress." };
	return previewRewind(ws.session, userSeq);
}

/** Rewinds to before the message `userSeq` (files, conversation or both), with the same race guard as undo. */
export async function rewindTurn(
	ws: WebAgentSession,
	request: { userSeq: number; mode: RewindMode; force: boolean },
	hooks: { saveSession: (session: WebAgentSession["session"]) => void; onDone: () => void },
): Promise<CommandResult> {
	if (ws.undoing) return { ok: false, error: "An undo or rewind is already in progress" };
	ws.undoing = true;
	try {
		const result = await rewindSession(ws.session, request.userSeq, request.mode, { force: request.force });
		if (!result.ok) return { ok: false, error: result.error };
		hooks.saveSession(ws.session);
		hooks.onDone();
		return { ok: true, result: result.message };
	} finally {
		ws.undoing = false;
	}
}
