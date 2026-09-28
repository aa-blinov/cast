/**
 * A confirmation a turn is waiting on, kept in the session row while it waits.
 * The process that asked holds the turn; if it dies (the daemon stopped, a
 * local TUI quit), the question would die with it and the call would read as
 * "interrupted" with no way to say yes. Stored here, the next client to open
 * the session asks again, and an approval starts a turn that re-runs the step.
 *
 * Its own column, written only here: saveSession never touches it, so a
 * session object held elsewhere can't overwrite the pending request.
 */

import { getDb } from "./db.ts";

export interface PendingApproval {
	/** What the prompt showed: the command, or "write path" for a file tool. */
	command: string;
	reason: string;
	/** What "Always allow" saves. */
	rule?: string;
	askedAt: number;
}

export function setPendingApproval(sessionId: string, approval: PendingApproval | undefined): void {
	try {
		getDb()
			.prepare("UPDATE sessions SET pending_approval_json = ? WHERE id = ?")
			.run(approval ? JSON.stringify(approval) : null, sessionId);
	} catch {
		// Losing the restore path is not worth failing the prompt over.
	}
}

export function getPendingApproval(sessionId: string): PendingApproval | undefined {
	try {
		const row = getDb().prepare("SELECT pending_approval_json AS json FROM sessions WHERE id = ?").get(sessionId) as
			| { json: string | null }
			| undefined;
		if (!row?.json) return undefined;
		const parsed = JSON.parse(row.json) as Partial<PendingApproval>;
		if (typeof parsed.command !== "string" || typeof parsed.askedAt !== "number") return undefined;
		return {
			command: parsed.command,
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			rule: typeof parsed.rule === "string" ? parsed.rule : undefined,
			askedAt: parsed.askedAt,
		};
	} catch {
		return undefined;
	}
}

/** "12 min", "3 h": how long ago it was asked, for the prompt. */
export function approvalAge(askedAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - askedAt) / 60_000));
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

/** The prompt for a request restored after cast stopped. */
export function restoredReason(approval: PendingApproval, now = Date.now()): string {
	return `${approval.reason} (asked ${approvalAge(approval.askedAt, now)} ago, before cast stopped)`;
}

/** The turn an approval starts: the original call is gone with its process. */
export function approvedResumeText(approval: PendingApproval): string {
	return `<system-reminder>Approved after cast restarted: ${approval.command}\nIt was waiting for approval when cast stopped and has not run. Run it again if it is still needed (it won't be asked about twice), re-check anything that may have changed since, then carry on with the task.</system-reminder>`;
}

/** A subagent's prompt belongs to the conversation the user opens, not to the
 *  hidden child session. */
export function approvalOwner(sessionId: string): string {
	try {
		const row = getDb()
			.prepare("SELECT session_kind AS kind, parent_session_id AS parent FROM sessions WHERE id = ?")
			.get(sessionId) as { kind: string | null; parent: string | null } | undefined;
		return row?.kind === "subagent" && row.parent ? row.parent : sessionId;
	} catch {
		return sessionId;
	}
}
