import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	ensureScratchpad,
	isSandboxCwd,
	isTemporaryPath,
	removeScratchpadFor,
	sandboxDirFor,
	scratchpadFor,
	scratchpadPromptBlock,
	scratchpadRefusalHint,
	scratchpadRoot,
} from "../src/core/scratchpad.ts";
import { createSession, deleteSession, pruneOrphanScratchpads, saveSession } from "../src/core/session.ts";

let dir: string;
let realHome: string | undefined;
let realDb: string | undefined;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cast-scratch-"));
	realHome = process.env.HOME;
	realDb = process.env.CAST_SESSIONS_DB;
	process.env.HOME = dir;
	process.env.CAST_SESSIONS_DB = join(dir, "sessions.db");
	resetDbConnectionForTests();
});
afterEach(() => {
	process.env.HOME = realHome;
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(dir, { recursive: true, force: true });
});

describe("scratchpadFor", () => {
	it("is a folder of the session's own for a session working in a project", () => {
		expect(scratchpadFor("abc123", "/work/project")).toBe(join(scratchpadRoot(), "abc123"));
		expect(scratchpadFor("abc123", "/work/project")).not.toBe(scratchpadFor("def456", "/work/project"));
	});

	it("is the working folder itself for a sandbox session, which is throwaway already", () => {
		const cwd = sandboxDirFor("abc123");
		expect(isSandboxCwd("abc123", cwd)).toBe(true);
		expect(scratchpadFor("abc123", cwd)).toBe(cwd);
	});

	it("takes a sandbox for exactly its own folder, not for a project that merely lives under the sandbox root", () => {
		expect(isSandboxCwd("abc123", join(sandboxDirFor("abc123"), "sub"))).toBe(false);
		expect(isSandboxCwd("abc123", sandboxDirFor("other"))).toBe(false);
		expect(isSandboxCwd("abc123", undefined)).toBe(false);
	});
});

describe("the scratchpad folder", () => {
	it("is made on demand, private to the user, and made again without complaint", () => {
		const path = scratchpadFor("abc123", "/work/project");
		ensureScratchpad(path);
		ensureScratchpad(path);
		expect(statSync(path).isDirectory()).toBe(true);
		expect(statSync(path).mode & 0o077).toBe(0);
	});

	it("says whether the folder is there afterwards", () => {
		expect(ensureScratchpad(scratchpadFor("abc123", "/work/project"))).toBe(true);
		writeFileSync(join(dir, ".cast", "blocker"), "x");
		expect(ensureScratchpad(join(dir, ".cast", "blocker", "inside"))).toBe(false);
	});

	it("is removed with its session, and only its own", () => {
		const mine = scratchpadFor("mine", "/work/project");
		const other = scratchpadFor("other", "/work/project");
		for (const path of [mine, other]) {
			ensureScratchpad(path);
			writeFileSync(join(path, "tmp.txt"), "x");
		}
		removeScratchpadFor("mine");
		expect(existsSync(mine)).toBe(false);
		expect(existsSync(other)).toBe(true);
	});

	it("goes when the session is deleted (deleteSession), like its attachments and its sandbox", () => {
		const session = createSession("m", "/work/project");
		saveSession(session);
		const path = scratchpadFor(session.id, "/work/project");
		ensureScratchpad(path);
		writeFileSync(join(path, "tmp.txt"), "x");
		deleteSession(session.id);
		expect(existsSync(path)).toBe(false);
	});

	it("does not delete a sandbox session's working folder as a scratchpad: that is the sandbox's own cleanup", () => {
		const cwd = sandboxDirFor("abc123");
		mkdirSync(cwd, { recursive: true });
		removeScratchpadFor("abc123");
		expect(existsSync(cwd)).toBe(true);
	});
});

describe("scratchpadPromptBlock", () => {
	it("names the folder and says what it is for and how long it lives", () => {
		const text = scratchpadPromptBlock("/home/u/.cast/scratch/abc123");
		expect(text).toContain("/home/u/.cast/scratch/abc123");
		expect(text).toContain("temporary files");
		expect(text).toContain("without asking");
		expect(text).toContain("deleted with the session");
	});
});

describe("the hint on a refusal to write to a system temp folder", () => {
	it("recognises a system temp path and nothing else", () => {
		for (const path of ["/tmp/x.txt", "/var/tmp/a/b", "/tmp"]) expect(isTemporaryPath(path), path).toBe(true);
		for (const path of ["/tmpfoo/x", "/home/u/tmp/x", "/etc/hosts", "/work/project/tmp.txt"]) {
			expect(isTemporaryPath(path), path).toBe(false);
		}
	});

	it("points at the scratchpad for a temp path, and says nothing for another path or with no scratchpad", () => {
		expect(scratchpadRefusalHint("/tmp/x.txt", "/home/u/.cast/scratch/abc")).toContain("/home/u/.cast/scratch/abc");
		expect(scratchpadRefusalHint("/etc/hosts", "/home/u/.cast/scratch/abc")).toBe("");
		expect(scratchpadRefusalHint("/tmp/x.txt", undefined)).toBe("");
	});
});

describe("pruneOrphanScratchpads", () => {
	const old = (path: string) => {
		const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		utimesSync(path, longAgo, longAgo);
	};

	it("removes the folder of a session that no longer exists, but not one a session still has, nor a fresh one", () => {
		const kept = createSession("m", "/work/project");
		saveSession(kept);
		const keptDir = scratchpadFor(kept.id, "/work/project");
		const orphanDir = scratchpadFor("gone0000", "/work/project");
		const freshDir = scratchpadFor("fresh000", "/work/project");
		for (const path of [keptDir, orphanDir, freshDir]) ensureScratchpad(path);
		old(keptDir);
		old(orphanDir);

		expect(pruneOrphanScratchpads()).toBe(1);
		expect(existsSync(orphanDir)).toBe(false);
		expect(existsSync(keptDir)).toBe(true);
		expect(existsSync(freshDir)).toBe(true);
	});

	it("does nothing when there is no scratch folder at all", () => {
		expect(pruneOrphanScratchpads()).toBe(0);
	});
});
