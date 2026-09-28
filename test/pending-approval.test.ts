import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	approvalAge,
	approvalOwner,
	approvedResumeText,
	getPendingApproval,
	restoredReason,
	setPendingApproval,
} from "../src/core/pending-approval.ts";
import { createSession, saveSession } from "../src/core/session.ts";

let dir: string;
let realDb: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-pending-approval-"));
	realDb = process.env.CAST_SESSIONS_DB;
	process.env.CAST_SESSIONS_DB = join(dir, "sessions.db");
	resetDbConnectionForTests();
});
afterEach(() => {
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("pending approval", () => {
	it("survives a saveSession of a session object that never heard of it", () => {
		const session = createSession("m", dir);
		saveSession(session);
		const approval = {
			command: "write a.md",
			reason: "permission rule write(*.md)",
			rule: "write(a.md)",
			askedAt: 1,
		};
		setPendingApproval(session.id, approval);
		saveSession(session);
		expect(getPendingApproval(session.id)).toEqual(approval);
		setPendingApproval(session.id, undefined);
		expect(getPendingApproval(session.id)).toBeUndefined();
	});

	it("belongs to the conversation when a subagent asked", () => {
		const parent = createSession("m", dir);
		saveSession(parent);
		const child = createSession("m", dir, { sessionKind: "subagent", parentSessionId: parent.id });
		saveSession(child);
		expect(approvalOwner(child.id)).toBe(parent.id);
		expect(approvalOwner(parent.id)).toBe(parent.id);
		expect(approvalOwner("missing")).toBe("missing");
	});

	it("says how old the request is and what the resume turn tells the model", () => {
		const now = 10 * 24 * 60 * 60_000;
		expect(approvalAge(now - 20_000, now)).toBe("under a minute");
		expect(approvalAge(now - 5 * 60_000, now)).toBe("5 min");
		expect(approvalAge(now - 3 * 60 * 60_000, now)).toBe("3 h");
		expect(approvalAge(now - 3 * 24 * 60 * 60_000, now)).toBe("3 d");
		const approval = { command: "rm -rf build", reason: "recursive/force delete (rm -rf)", askedAt: now - 60_000 };
		expect(restoredReason(approval, now)).toBe(
			"recursive/force delete (rm -rf) (asked 1 min ago, before cast stopped)",
		);
		expect(approvedResumeText(approval)).toContain("Approved after cast restarted: rm -rf build");
	});
});
