import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEntry,
	deleteEntries,
	FsError,
	listDirectory,
	moveEntry,
	nameSegments,
	parseRange,
	removeTree,
	renameEntry,
	saveUpload,
} from "../src/server/project-fs.ts";

let root = "";
let outside = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cast-projfs-"));
	outside = mkdtempSync(join(tmpdir(), "cast-projfs-out-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

const status = async (promise: Promise<unknown>): Promise<number | undefined> => {
	try {
		await promise;
	} catch (error) {
		return error instanceof FsError ? error.status : -1;
	}
	return undefined;
};

function upload(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
	return Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { headers }) as unknown as IncomingMessage;
}

describe("nameSegments", () => {
	it("splits a typed path and trims edge slashes", () => {
		expect(nameSegments(" /a/b/c.txt/ ")).toEqual(["a", "b", "c.txt"]);
	});

	it.each(["", "  ", "..", "a/../b", "a//b", "a\\b", "x\0y", ".git", "a/.git"])("refuses %j", (name) => {
		expect(() => nameSegments(name)).toThrow(FsError);
	});

	it("refuses a segment over the file system's byte limit", () => {
		expect(() => nameSegments("é".repeat(200))).toThrow(FsError);
	});
});

describe("parseRange", () => {
	it("reads open, closed and suffix ranges", () => {
		expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
		expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
		expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
	});

	it("flags what can't be served and ignores what isn't a range", () => {
		expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
		expect(parseRange("bytes=9-5", 100)).toBe("unsatisfiable");
		expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
		expect(parseRange(undefined, 100)).toBeNull();
		expect(parseRange("bytes=-", 100)).toBeNull();
		expect(parseRange("items=1-2", 100)).toBeNull();
	});
});

describe("listDirectory", () => {
	it("lists folders first, hides .git and pages the rest", async () => {
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "zdir"));
		for (const name of ["b.txt", "a.txt", "c.txt"]) writeFileSync(join(root, name), name);
		const first = await listDirectory(root, "", { limit: 2 });
		expect(first.entries.map((e) => e.name)).toEqual(["zdir", "a.txt"]);
		expect(first).toMatchObject({ total: 4, offset: 0, hasMore: true });
		const second = await listDirectory(root, "", { offset: 2, limit: 2 });
		expect(second.entries.map((e) => e.name)).toEqual(["b.txt", "c.txt"]);
		expect(second.hasMore).toBe(false);
	});

	it("marks git-ignored entries and resolves symlinks", async () => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, ".gitignore"), "skipped/\n");
		mkdirSync(join(root, "skipped"));
		writeFileSync(join(root, "real.txt"), "x");
		symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
		symlinkSync(join(root, "nope"), join(root, "broken"));
		const byName = Object.fromEntries((await listDirectory(root, "")).entries.map((e) => [e.name, e]));
		expect(byName.skipped?.ignored).toBe(true);
		expect(byName["real.txt"]?.ignored).toBeFalsy();
		expect(byName["link.txt"]).toMatchObject({ link: true, type: "file" });
		expect(byName.broken?.broken).toBe(true);
	});

	it("treats a missing root as empty but a missing subfolder as an error", async () => {
		const gone = join(root, "not-yet");
		expect((await listDirectory(gone, "")).entries).toEqual([]);
		expect(await status(listDirectory(root, "missing"))).toBe(404);
	});

	it("refuses to leave the root, by path or by symlink", async () => {
		symlinkSync(outside, join(root, "escape"));
		expect(await status(listDirectory(root, ".."))).toBe(400);
		expect(await status(listDirectory(root, "escape"))).toBe(400);
	});
});

describe("createEntry", () => {
	it("creates nested files and folders", async () => {
		expect(await createEntry(root, "", "a/b/c.txt", "file")).toEqual({ path: "a/b/c.txt", type: "file" });
		await createEntry(root, "a", "d", "dir");
		expect(existsSync(join(root, "a", "b", "c.txt"))).toBe(true);
		expect(existsSync(join(root, "a", "d"))).toBe(true);
	});

	it("does not overwrite an existing file", async () => {
		writeFileSync(join(root, "x.txt"), "keep");
		expect(await status(createEntry(root, "", "x.txt", "file"))).toBe(409);
		expect(readFileSync(join(root, "x.txt"), "utf-8")).toBe("keep");
	});

	it("refuses traversal and symlink escapes", async () => {
		symlinkSync(outside, join(root, "escape"));
		expect(await status(createEntry(root, "", "../evil.txt", "file"))).toBe(400);
		expect(await status(createEntry(root, "escape", "evil.txt", "file"))).toBe(400);
		expect(readdirSync(outside)).toEqual([]);
	});
});

describe("renameEntry", () => {
	it("renames in place and refuses an existing name", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "b.txt"), "b");
		expect(await status(renameEntry(root, "a.txt", "b.txt"))).toBe(409);
		expect(readFileSync(join(root, "b.txt"), "utf-8")).toBe("b");
		expect(await renameEntry(root, "a.txt", "c.txt")).toEqual({ path: "c.txt" });
	});

	it("refuses a name that is a path", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		expect(await status(renameEntry(root, "a.txt", "sub/a.txt"))).toBe(400);
		expect(await status(renameEntry(root, "a.txt", ".."))).toBe(400);
	});
});

describe("moveEntry", () => {
	it("moves into a folder and refuses to clobber", async () => {
		mkdirSync(join(root, "dir"));
		writeFileSync(join(root, "a.txt"), "a");
		writeFileSync(join(root, "dir", "a.txt"), "old");
		expect(await status(moveEntry(root, "a.txt", "dir"))).toBe(409);
		expect(readFileSync(join(root, "dir", "a.txt"), "utf-8")).toBe("old");
		rmSync(join(root, "dir", "a.txt"));
		expect(await moveEntry(root, "a.txt", "dir")).toEqual({ path: "dir/a.txt" });
		expect(existsSync(join(root, "a.txt"))).toBe(false);
	});

	it("refuses to move a folder into itself", async () => {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		expect(await status(moveEntry(root, "a", "a/b"))).toBe(400);
		expect(await status(moveEntry(root, "a", "a"))).toBe(400);
	});

	it("refuses to leave the root", async () => {
		writeFileSync(join(root, "a.txt"), "a");
		symlinkSync(outside, join(root, "escape"));
		expect(await status(moveEntry(root, "a.txt", "escape"))).toBe(400);
		expect(await status(moveEntry(root, "a.txt", ".."))).toBe(400);
	});
});

describe("removeTree and deleteEntries", () => {
	it("removes a deep tree", async () => {
		for (let i = 0; i < 200; i++) {
			mkdirSync(join(root, "t", `d${i % 5}`), { recursive: true });
			writeFileSync(join(root, "t", `d${i % 5}`, `f${i}`), "x");
		}
		await removeTree(join(root, "t"));
		expect(existsSync(join(root, "t"))).toBe(false);
	});

	it("does not follow a symlink out of the tree", async () => {
		writeFileSync(join(outside, "keep.txt"), "x");
		mkdirSync(join(root, "t"));
		symlinkSync(outside, join(root, "t", "link"));
		await removeTree(join(root, "t"));
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	it("reports each path, and refuses .git and the root", async () => {
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "a.txt"), "a");
		const result = await deleteEntries(root, ["a.txt", ".git", "", "missing.txt", "../x"]);
		expect(result.deleted).toEqual(["a.txt"]);
		expect(result.failed.map((f) => f.path).sort()).toEqual(["", "../x", ".git", "missing.txt"].sort());
		expect(existsSync(join(root, ".git"))).toBe(true);
	});

	it("deletes a symlink itself, not its target", async () => {
		writeFileSync(join(outside, "keep.txt"), "x");
		symlinkSync(outside, join(root, "link"));
		const result = await deleteEntries(root, ["link"]);
		expect(result.deleted).toEqual(["link"]);
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});
});

describe("saveUpload", () => {
	it("streams into a new file, creating folders", async () => {
		const out = await saveUpload(root, upload(["hel", "lo"]), "sub/hello.txt");
		expect(out).toEqual({ path: "sub/hello.txt", size: 5 });
		expect(readFileSync(join(root, "sub", "hello.txt"), "utf-8")).toBe("hello");
		expect(readdirSync(join(root, "sub"))).toEqual(["hello.txt"]);
	});

	it("refuses to overwrite unless asked", async () => {
		writeFileSync(join(root, "a.txt"), "old");
		expect(await status(saveUpload(root, upload(["new"]), "a.txt"))).toBe(409);
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("old");
		await saveUpload(root, upload(["new"]), "a.txt", { overwrite: true });
		expect(readFileSync(join(root, "a.txt"), "utf-8")).toBe("new");
	});

	it("stops at the size limit and leaves no partial file", async () => {
		expect(await status(saveUpload(root, upload(["12345", "67890"]), "big.bin", { maxBytes: 8 }))).toBe(413);
		expect(
			await status(saveUpload(root, upload(["x"], { "content-length": "999" }), "big2.bin", { maxBytes: 8 })),
		).toBe(413);
		expect(readdirSync(root)).toEqual([]);
	});

	it("refuses to write outside the root", async () => {
		symlinkSync(outside, join(root, "escape"));
		expect(await status(saveUpload(root, upload(["x"]), "escape/evil.txt"))).toBe(400);
		expect(await status(saveUpload(root, upload(["x"]), "../evil.txt"))).toBe(400);
		expect(readdirSync(outside)).toEqual([]);
	});
});
