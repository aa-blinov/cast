import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import {
	clearScratchpad,
	describeScratchpad,
	ensureScratchpad,
	formatBytes,
	formatScratchpadListing,
	isSandboxCwd,
	isTemporaryPath,
	lastActivityMs,
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
		for (const path of ["/tmpfoo/x", "/home/u/tmp/x", "/etc/hosts", "/work/project/tmp.txt", "/tmp/../etc/hosts"]) {
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

describe("describing and clearing a scratchpad", () => {
	it("lists the biggest files first, with sizes and the total, and says when there is more", () => {
		const dir = scratchpadFor("abc123", "/work/project");
		ensureScratchpad(dir);
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "small.txt"), "x");
		writeFileSync(join(dir, "sub", "big.txt"), "y".repeat(3000));
		writeFileSync(join(dir, "mid.txt"), "z".repeat(200));
		const listing = describeScratchpad(dir, 2);
		expect(listing.files.map((f) => f.name)).toEqual([join("sub", "big.txt"), "mid.txt"]);
		expect(listing.totalBytes).toBe(3201);
		expect(listing.truncated).toBe(true);
		const text = formatScratchpadListing(listing);
		expect(text).toContain(dir);
		expect(text).toContain("2.9 KB");
		expect(text).toContain("and more");
	});

	it("says so for a folder that is empty and for one that has not been made", () => {
		const dir = scratchpadFor("abc123", "/work/project");
		expect(formatScratchpadListing(describeScratchpad(dir))).toContain("Not made yet");
		ensureScratchpad(dir);
		expect(formatScratchpadListing(describeScratchpad(dir))).toContain("Empty");
	});

	it("empties the folder and keeps it", () => {
		const dir = scratchpadFor("abc123", "/work/project");
		ensureScratchpad(dir);
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "a.txt"), "x");
		writeFileSync(join(dir, "b.txt"), "x");
		expect(clearScratchpad(dir)).toBe(true);
		expect(existsSync(dir)).toBe(true);
		expect(describeScratchpad(dir).files).toEqual([]);
	});

	it("will not empty a folder that is not under the scratch root: a sandbox session's working folder, a project", () => {
		const sandbox = sandboxDirFor("abc123");
		mkdirSync(sandbox, { recursive: true });
		writeFileSync(join(sandbox, "work.txt"), "the user's work");
		expect(clearScratchpad(sandbox)).toBe(false);
		expect(clearScratchpad(scratchpadRoot())).toBe(false);
		expect(clearScratchpad(join(scratchpadRoot(), "..", "elsewhere"))).toBe(false);
		expect(existsSync(join(sandbox, "work.txt"))).toBe(true);
	});

	it("formats sizes plainly", () => {
		expect(formatBytes(12)).toBe("12 B");
		expect(formatBytes(2048)).toBe("2.0 KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
	});
});

describe("the scratch root is private, and retention follows real activity", () => {
	it("makes the root private along with the folder", () => {
		ensureScratchpad(scratchpadFor("abc123", "/work/project"));
		expect(statSync(scratchpadRoot()).mode & 0o077).toBe(0);
	});

	it("takes work in a subfolder for activity: a folder's own time only moves when an entry is added to it directly", () => {
		const dir = scratchpadFor("abc123", "/work/project");
		ensureScratchpad(dir);
		mkdirSync(join(dir, "deep"));
		writeFileSync(join(dir, "deep", "f.txt"), "x");
		const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
		utimesSync(dir, longAgo, longAgo);
		utimesSync(join(dir, "deep"), longAgo, longAgo);
		utimesSync(join(dir, "deep", "f.txt"), new Date(), new Date());
		expect(Date.now() - lastActivityMs(dir)).toBeLessThan(60_000);
	});

	it("removes a scratchpad idle past the retention even though its session still exists, and keeps one in use", () => {
		const idle = createSession("m", "/work/project");
		const busy = createSession("m", "/work/project");
		saveSession(idle);
		saveSession(busy);
		const idleDir = scratchpadFor(idle.id, "/work/project");
		const busyDir = scratchpadFor(busy.id, "/work/project");
		for (const dir of [idleDir, busyDir]) {
			ensureScratchpad(dir);
			writeFileSync(join(dir, "f.txt"), "x");
		}
		const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		for (const path of [idleDir, join(idleDir, "f.txt")]) utimesSync(path, longAgo, longAgo);

		expect(pruneOrphanScratchpads()).toBe(1);
		expect(existsSync(idleDir)).toBe(false);
		expect(existsSync(busyDir)).toBe(true);
	});
});
