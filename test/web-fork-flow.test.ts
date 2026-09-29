import { describe, expect, it } from "vitest";
import { describeFork, forkNotice } from "../src/server/public/fork-flow.js";

describe("describeFork", () => {
	it("says what a git worktree copy is, and that ignored files are not in it", () => {
		const text = describeFork({ canCopyFiles: true, kind: "worktree" });
		expect(text).toContain("git worktree of your project at that point");
		expect(text).toContain("node_modules");
		expect(text).toContain("same folder");
	});

	it("says what a snapshot copy is", () => {
		const text = describeFork({ canCopyFiles: true, kind: "snapshot" });
		expect(text).toContain("new sandbox folder");
		expect(text).not.toContain("git worktree");
	});
});

describe("forkNotice", () => {
	it("says where the files are", () => {
		expect(forkNotice({ withFiles: true, cwd: "/p/wt" })).toBe("Forked, with its own copy of the files in /p/wt.");
		expect(forkNotice({ withFiles: false, cwd: "/p" })).toContain("share the working folder");
	});
});
