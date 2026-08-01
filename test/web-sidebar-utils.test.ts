import { describe, expect, it } from "vitest";

import {
	SANDBOX_CWD,
	groupSessionsByDirectory,
	isSandboxSessionCwd,
	sessionDirectoryName,
	sortSessionsByActivity,
} from "../src/web/public/sidebar-utils.js";

describe("web sidebar session helpers", () => {
	it("recognizes sandbox paths and labels directories", () => {
		expect(isSandboxSessionCwd(SANDBOX_CWD)).toBe(true);
		expect(isSandboxSessionCwd("/tmp/.cast/sandbox/cast-123")).toBe(true);
		expect(sessionDirectoryName("/work/cast/")).toBe("cast");
		expect(sessionDirectoryName("/tmp/.cast/sandbox/cast-123")).toBe("Sandbox");
		expect(sessionDirectoryName(".env")).toBe(".env");
	});

	it("groups by directory and keeps active work first", () => {
		const sessions = [
			{ id: "old", cwd: "/work/cast", status: "idle", updatedAt: "2026-07-30" },
			{ id: "running", cwd: "/work/cast", status: "running", updatedAt: "2026-07-01" },
			{ id: "sandbox", cwd: SANDBOX_CWD, status: "idle", updatedAt: "2026-07-31" },
		];
		const groups = groupSessionsByDirectory(sessions);
		expect(groups.map(([, group]) => group.label)).toEqual(["cast", "Sandbox"]);
		expect(groups[0][1].sessions.sort(sortSessionsByActivity).map((s) => s.id)).toEqual(["running", "old"]);
	});
});
