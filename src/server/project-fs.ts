/**
 * The file operations behind the web file explorer, for one session's cwd:
 * list, create, rename, move, delete, upload and byte ranges for downloads.
 *
 * All of it is asynchronous. The daemon serves every session from one thread,
 * and the synchronous versions these replaced (readdirSync of a 30k-file
 * folder, rmSync of a tree, a 200MB body buffered and written in one call)
 * each froze every open session for as long as they took. Directory pages are
 * bounded, deleting and copying run in the thread pool, and an upload streams
 * to disk instead of into memory.
 *
 * Every path a request names is resolved against the session's cwd and judged
 * by where it really lives (symlinks included): see path-safety.ts. Operations
 * that act on an entry itself (delete, rename, move) judge its parent
 * directory, so a symlink can be removed or renamed without following it out
 * of the project.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, type Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { invalidateProjectFiles } from "../core/file-search.ts";
import { isInsideRootAsync } from "./path-safety.ts";

/** An error with the HTTP status the route should answer with. */
export class FsError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface DirEntry {
	name: string;
	type: "file" | "dir";
	size?: number;
	mtimeMs?: number;
	/** Git ignores it (or, outside a repository, it is a dependency/build folder). */
	ignored?: boolean;
	/** A symbolic link; `type` is what it points to. */
	link?: boolean;
	/** A symbolic link whose target doesn't exist. */
	broken?: boolean;
}

export interface DirListing {
	path: string;
	entries: DirEntry[];
	/** Entries in the whole directory, of which `entries` is the page from `offset`. */
	total: number;
	offset: number;
	hasMore: boolean;
}

export const DEFAULT_PAGE_SIZE = 1000;
export const MAX_PAGE_SIZE = 5000;
export const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const NAME_MAX_BYTES = 255;
const STAT_CONCURRENCY = 64;
/** Folders that are dependencies or build output when there is no git to say so. */
const HEAVY_FOLDERS = new Set([
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".tox",
	".mypy_cache",
	".next",
	".cache",
]);

async function inside(cwd: string, target: string): Promise<void> {
	if (!(await isInsideRootAsync(cwd, target))) throw new FsError(400, "Path outside project");
}

/** For acting on an entry itself: it must be under cwd, and its parent really there. */
async function insideAsEntry(cwd: string, target: string): Promise<void> {
	if (target === cwd || relative(cwd, target).startsWith("..")) throw new FsError(400, "Invalid path");
	if (!(await isInsideRootAsync(cwd, dirname(target)))) throw new FsError(400, "Path outside project");
}

const isCode = (error: unknown, ...codes: string[]): boolean =>
	codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");

function fsError(error: unknown, fallback = "File operation failed"): FsError {
	if (error instanceof FsError) return error;
	if (isCode(error, "ENOENT")) return new FsError(404, "Not found");
	if (isCode(error, "EEXIST", "ENOTEMPTY")) return new FsError(409, "Already exists");
	if (isCode(error, "EACCES", "EPERM")) return new FsError(403, "Permission denied");
	if (isCode(error, "ENOSPC")) return new FsError(507, "No space left on the device");
	return new FsError(400, error instanceof Error ? error.message : fallback);
}

const EDGE_SLASHES_RE = /^\/+|\/+$/g;
const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** NUL and the other control characters have no place in a file name. */
function hasControlCharacter(text: string): boolean {
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 0x20) return true;
	return false;
}

/** Splits a name typed by a user into path segments, refusing anything that could leave its folder. */
export function nameSegments(name: string): string[] {
	const trimmed = name.trim().replace(EDGE_SLASHES_RE, "");
	if (!trimmed) throw new FsError(400, "Invalid name");
	const segments = trimmed.split("/");
	for (const segment of segments) {
		if (!segment || segment === "." || segment === ".." || segment.includes("\\") || hasControlCharacter(segment)) {
			throw new FsError(400, "Invalid name");
		}
		if (segment === ".git") throw new FsError(400, "Refusing to create .git");
		if (Buffer.byteLength(segment) > NAME_MAX_BYTES) throw new FsError(400, "Name too long");
	}
	return segments;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	for (let i = 0; i < items.length; i += limit) {
		// biome-ignore lint/performance/noAwaitInLoops: bounded batches are the point
		const batch = await Promise.all(items.slice(i, i + limit).map(fn));
		for (let j = 0; j < batch.length; j++) out[i + j] = batch[j] as R;
	}
	return out;
}

/**
 * Which of these paths (relative to cwd) git's ignore rules match; undefined
 * outside a repository. `--no-index`: without it git looks every path up in the
 * index first (is it tracked?), which cost 0.44s for 400 paths in a 52k-file
 * repository against 6ms without. The price is that a tracked file matching a
 * pattern reads as ignored, which only dims it in the tree.
 */
export function gitIgnored(cwd: string, rels: string[]): Promise<Set<string> | undefined> {
	if (rels.length === 0) return Promise.resolve(new Set());
	return new Promise((resolvePromise) => {
		const child = spawn("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
			cwd,
			stdio: ["pipe", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let settled = false;
		const finish = (value: Set<string> | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(undefined);
		}, 3_000);
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => finish(undefined));
		child.on("close", (code) => {
			// 0: some ignored, 1: none ignored; anything else is "not a repository" or a failure.
			if (code !== 0 && code !== 1) return finish(undefined);
			finish(new Set(Buffer.concat(chunks).toString("utf-8").split("\0").filter(Boolean)));
		});
		child.stdin.on("error", () => {});
		child.stdin.end(`${rels.join("\0")}\0`);
	});
}

interface Row {
	name: string;
	key: string;
	dir: boolean;
	link: boolean;
	broken: boolean;
}

/** One page of a directory: dirs first, then names, sizes and ignore state only for the page. */
export async function listDirectory(
	cwd: string,
	rel: string,
	options: { offset?: number; limit?: number } = {},
): Promise<DirListing> {
	const target = resolve(cwd, rel || ".");
	await inside(cwd, target);
	const offset = Math.max(0, Math.floor(options.offset ?? 0));
	const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE)));
	let dirents: Dirent[];
	try {
		const st = await stat(target);
		if (!st.isDirectory()) throw new FsError(400, "Not a directory");
		dirents = await readdir(target, { withFileTypes: true });
	} catch (error) {
		// A brand-new sandbox session's cwd is only created lazily on the first
		// message, so the Files panel loading before that is a normal state.
		if (target === cwd && isCode(error, "ENOENT")) {
			return { path: "", entries: [], total: 0, offset: 0, hasMore: false };
		}
		throw fsError(error);
	}

	const rows: Row[] = [];
	const links: { row: Row; full: string }[] = [];
	for (const dirent of dirents) {
		if (dirent.name === ".git") continue;
		const row: Row = {
			name: dirent.name,
			key: dirent.name.toLowerCase(),
			dir: dirent.isDirectory(),
			link: dirent.isSymbolicLink(),
			broken: false,
		};
		rows.push(row);
		if (row.link) links.push({ row, full: join(target, dirent.name) });
	}
	// A link sorts by what it points to, so resolve them before sorting.
	await mapLimit(links, STAT_CONCURRENCY, async ({ row, full }) => {
		try {
			row.dir = (await stat(full)).isDirectory();
		} catch {
			row.broken = true;
		}
	});
	rows.sort((a, b) => {
		if (a.dir !== b.dir) return a.dir ? -1 : 1;
		if (a.key !== b.key) return a.key < b.key ? -1 : 1;
		return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
	});

	const page = rows.slice(offset, offset + limit);
	const relDir = relative(cwd, target);
	const [details, ignored] = await Promise.all([
		mapLimit(page, STAT_CONCURRENCY, async (row) => {
			if (row.dir || row.broken) return undefined;
			try {
				const st = await stat(join(target, row.name));
				return { size: st.size, mtimeMs: st.mtimeMs };
			} catch {
				return undefined;
			}
		}),
		gitIgnored(
			cwd,
			page.map((row) => join(relDir, row.name)),
		),
	]);
	const entries: DirEntry[] = page.map((row, i) => {
		const entry: DirEntry = { name: row.name, type: row.dir ? "dir" : "file" };
		const detail = details[i];
		if (detail) {
			entry.size = detail.size;
			entry.mtimeMs = detail.mtimeMs;
		}
		const isIgnored = ignored ? ignored.has(join(relDir, row.name)) : HEAVY_FOLDERS.has(row.name);
		if (isIgnored) entry.ignored = true;
		if (row.link) entry.link = true;
		if (row.broken) entry.broken = true;
		return entry;
	});
	return {
		path: relDir,
		entries,
		total: rows.length,
		offset,
		hasMore: offset + entries.length < rows.length,
	};
}

/** Creates a file or folder named `name` (which may be `a/b/c.txt`) inside `parentRel`. */
export async function createEntry(
	cwd: string,
	parentRel: string,
	name: string,
	type: "file" | "dir",
): Promise<{ path: string; type: "file" | "dir" }> {
	const segments = nameSegments(name);
	const parent = resolve(cwd, parentRel || ".");
	const dest = join(parent, ...segments);
	await inside(cwd, parent);
	await inside(cwd, dest);
	try {
		const st = await stat(parent);
		if (!st.isDirectory()) throw new FsError(400, "Not a folder");
		await mkdir(dirname(dest), { recursive: true });
		if (type === "dir") await mkdir(dest);
		else await writeFile(dest, "", { flag: "wx" });
	} catch (error) {
		throw fsError(error);
	}
	invalidateProjectFiles(cwd);
	return { path: relative(cwd, dest), type };
}

/** Renames in place: `name` is one segment, never a path, so this can't turn into a move. */
export async function renameEntry(cwd: string, rel: string, name: string): Promise<{ path: string }> {
	const trimmed = name.trim();
	if (!trimmed || trimmed.includes("/") || nameSegments(trimmed).length !== 1) throw new FsError(400, "Invalid name");
	const target = resolve(cwd, rel);
	if (!rel) throw new FsError(400, "Invalid path");
	await insideAsEntry(cwd, target);
	const dest = join(dirname(target), trimmed);
	if (dest === target) return { path: relative(cwd, dest) };
	try {
		const source = await lstat(target);
		try {
			const existing = await lstat(dest);
			// Same inode: only the case of the name changes on a case-insensitive disk.
			if (existing.ino !== source.ino || existing.dev !== source.dev) {
				throw new FsError(409, `"${trimmed}" already exists`);
			}
		} catch (error) {
			if (!isCode(error, "ENOENT")) throw error;
		}
		await rename(target, dest);
	} catch (error) {
		throw fsError(error);
	}
	invalidateProjectFiles(cwd);
	return { path: relative(cwd, dest) };
}

/** Moves an entry into another folder of the project, keeping its name. */
export async function moveEntry(cwd: string, fromRel: string, toDirRel: string): Promise<{ path: string }> {
	if (!fromRel) throw new FsError(400, "Invalid path");
	const from = resolve(cwd, fromRel);
	const toDir = resolve(cwd, toDirRel || ".");
	await insideAsEntry(cwd, from);
	await inside(cwd, toDir);
	const dest = join(toDir, basename(from));
	if (dest === from) return { path: relative(cwd, dest) };
	try {
		const [source, target] = await Promise.all([lstat(from), stat(toDir)]);
		if (!target.isDirectory()) throw new FsError(400, "Not a folder");
		if (source.isDirectory()) {
			const [realFrom, realTo] = await Promise.all([realpath(from), realpath(toDir)]);
			if (realTo === realFrom || realTo.startsWith(realFrom + sep)) {
				throw new FsError(400, "Can't move a folder into itself");
			}
		}
		try {
			await lstat(dest);
			throw new FsError(409, `"${basename(dest)}" already exists there`);
		} catch (error) {
			if (!isCode(error, "ENOENT")) throw error;
		}
		try {
			await rename(from, dest);
		} catch (error) {
			if (!isCode(error, "EXDEV")) throw error;
			// Another device: copy, then remove the original.
			await cp(from, dest, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
			await rm(from, { recursive: true });
		}
	} catch (error) {
		throw fsError(error);
	}
	invalidateProjectFiles(cwd);
	return { path: relative(cwd, dest) };
}

const yieldToLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

/**
 * Removes a file, or a folder and everything in it, a bounded batch at a time.
 * `fs.promises.rm({ recursive })` starts every unlink at once: deleting 20,000
 * files queued 20,000 completions and held the event loop for 430ms. Here at
 * most 64 unlinks are in flight, the loop gets a turn between batches, and
 * folders go last, deepest first. A symbolic link is removed, not followed.
 */
export async function removeTree(target: string): Promise<void> {
	const root = await lstat(target);
	if (!root.isDirectory()) {
		await unlink(target);
		return;
	}
	const folders: string[] = [];
	const stack = [target];
	let batch: Promise<void>[] = [];
	while (stack.length > 0) {
		const folder = stack.pop() as string;
		folders.push(folder);
		// biome-ignore lint/performance/noAwaitInLoops: one folder at a time keeps the walk's memory bounded
		const entries = await readdir(folder, { withFileTypes: true });
		for (const entry of entries) {
			const full = join(folder, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			batch.push(unlink(full));
			if (batch.length >= 64) {
				// biome-ignore lint/performance/noAwaitInLoops: the await is the cap on unlinks in flight
				await Promise.all(batch);
				batch = [];
				await yieldToLoop();
			}
		}
	}
	await Promise.all(batch);
	for (let i = folders.length - 1; i >= 0; i--) {
		// biome-ignore lint/performance/noAwaitInLoops: a folder can only go once what is inside it has
		await rmdir(folders[i] as string);
		if (i % 64 === 0) await yieldToLoop();
	}
}

/** Deletes files and folders (folders with everything in them). One that fails doesn't stop the rest. */
export async function deleteEntries(
	cwd: string,
	rels: string[],
): Promise<{ deleted: string[]; failed: { path: string; error: string }[] }> {
	const deleted: string[] = [];
	const failed: { path: string; error: string }[] = [];
	for (const rel of rels) {
		try {
			if (!rel) throw new FsError(400, "Refusing to delete this path");
			const target = resolve(cwd, rel);
			if (basename(target) === ".git") throw new FsError(400, "Refusing to delete .git");
			// biome-ignore lint/performance/noAwaitInLoops: deleting one at a time keeps the disk and the thread pool from being flooded
			await insideAsEntry(cwd, target);
			await lstat(target);
			await removeTree(target);
			deleted.push(rel);
		} catch (error) {
			failed.push({ path: rel, error: fsError(error).message });
		}
	}
	invalidateProjectFiles(cwd);
	return { deleted, failed };
}

/**
 * Streams a request body to `destRel` in the project: to a temporary file next
 * to it, renamed into place when complete, so a dropped connection never leaves
 * a half-written file under the real name. Refuses an existing file unless
 * `overwrite`, and a body past `maxBytes`.
 */
export async function saveUpload(
	cwd: string,
	body: IncomingMessage,
	destRel: string,
	options: { overwrite?: boolean; maxBytes?: number } = {},
): Promise<{ path: string; size: number }> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
	const segments = nameSegments(destRel);
	const dest = join(cwd, ...segments);
	await inside(cwd, dest);
	const declared = Number(body.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new FsError(413, `File too large: the limit is ${Math.round(maxBytes / (1024 * 1024))}MB`);
	}
	try {
		await mkdir(dirname(dest), { recursive: true });
		const existing = await lstat(dest).catch(() => undefined);
		if (existing && !options.overwrite) throw new FsError(409, `"${basename(dest)}" already exists`);
		if (existing?.isDirectory()) throw new FsError(400, `"${basename(dest)}" is a folder`);
	} catch (error) {
		throw fsError(error);
	}
	const partial = `${dest}.${randomUUID().slice(0, 8)}.cast-part`;
	let size = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			size += chunk.length;
			if (size > maxBytes)
				callback(new FsError(413, `File too large: the limit is ${Math.round(maxBytes / (1024 * 1024))}MB`));
			else callback(null, chunk);
		},
	});
	try {
		await pipeline(body, counter, createWriteStream(partial, { flags: "wx" }));
		if (body.aborted) throw new FsError(400, "Upload interrupted");
		if (options.overwrite) await unlink(dest).catch(() => {});
		await rename(partial, dest);
	} catch (error) {
		await unlink(partial).catch(() => {});
		throw fsError(error);
	}
	invalidateProjectFiles(cwd);
	return { path: relative(cwd, dest), size };
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` against a file of `size`; null when there is no usable single range. */
export function parseRange(
	header: string | undefined,
	size: number,
): { start: number; end: number } | "unsatisfiable" | null {
	if (!header) return null;
	const match = RANGE_RE.exec(header.trim());
	if (!match || (match[1] === "" && match[2] === "")) return null;
	let start: number;
	let end: number;
	if (match[1] === "") {
		const suffix = Number(match[2]);
		if (suffix === 0) return "unsatisfiable";
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
	}
	if (start >= size || start > end) return "unsatisfiable";
	return { start, end };
}

/** A gzipped tar of a folder, streamed from `tar`; the caller pipes it to the response. */
export function archiveFolder(parent: string, name: string): ReturnType<typeof spawn> {
	return spawn("tar", ["-czf", "-", "-C", parent, "--", name], { stdio: ["ignore", "pipe", "ignore"] });
}
