/**
 * File tools — `read`, `write`, and `edit` (see docs/tools.md): `read`
 * numbers lines plainly (`N: content`), and `edit` takes
 * `oldString`/`newString` literal text, matched via tools/text-replace.ts's
 * fallback chain of matchers. All paths resolve against the agent's cwd via
 * resolvePath.
 */

import { constants, createReadStream, readFileSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AppConfig } from "../config.ts";
import { resizeImageForEmbedding } from "../image-resize.ts";
import { findFilesByBasename } from "./search.ts";
import { formatSize, resolvePath, type ToolResult } from "./shared.ts";
import { convertToLineEnding, detectLineEnding, normalizeLineEndings, replace } from "./text-replace.ts";

function isEnoent(err: unknown): boolean {
	return (err as { code?: string })?.code === "ENOENT";
}

/**
 * Turn the errno the filesystem raised into something a model can act on.
 *
 * These used to escape to the dispatcher's catch-all, which reports "write
 * failed unexpectedly: EISDIR: illegal operation on a directory, read" — the
 * mention of *read* comes from loading the previous content for the diff, so
 * the message actively misleads about what went wrong. Each case here names
 * the actual obstacle instead.
 */
function describeFileWriteError(err: unknown, path: string): string | null {
	const code = (err as { code?: string })?.code;
	switch (code) {
		case "EISDIR":
			return `${path} is a directory, not a file. Pass a file path (use ls to see what is inside it).`;
		case "EACCES":
		case "EPERM":
			return `No permission to write ${path}. Check the file's mode and ownership, or ask the user to change it.`;
		case "EROFS":
			return `${path} is on a read-only filesystem.`;
		case "ENOSPC":
			return `No space left on the device holding ${path}.`;
		case "ENOTDIR":
			return `A path component of ${path} is a file, not a directory.`;
		case "ELOOP":
			return `Too many symbolic links resolving ${path} — the link chain is circular.`;
		default:
			return null;
	}
}

/**
 * When the requested path is missing, run `glob` by basename under the hood
 * and attach real hits so the model can retry `read`/`edit` without starting
 * its own search loop. No guessed prefixes — only what the search returns.
 */
async function fileNotFoundResult(filePath: string, cwd: string, config: AppConfig): Promise<ToolResult> {
	const hits = await findFilesByBasename(basename(filePath), cwd, config);
	if (hits.length === 0) {
		return { content: `File not found: ${filePath}`, isError: true };
	}
	const list = hits.map((h) => `- ${h}`).join("\n");
	return {
		content:
			`File not found: ${filePath}\n` +
			`Found by name (use one of these paths with read/edit — do not call glob):\n${list}`,
		isError: true,
	};
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};
// Providers reject image data URLs over ~5MB (Anthropic, the most permissive
// of the widely-used providers). A file that's 5MB raw balloons to ~6.7MB as
// base64 data URL — still over most provider limits — but the cross-message
// total cap (MAX_TOTAL_EMBEDDED_IMAGE_BYTES, 6MB) catches the remaining
// overhead. This ceiling keeps individual reads of absurdly large files from
// even attempting embed.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Binary-file detection: a known-binary extension short-circuits, otherwise
// a sample of the file's own bytes is checked for null bytes or a high
// proportion of non-printable control characters.
const BINARY_EXTENSIONS = new Set([
	".zip",
	".tar",
	".gz",
	".exe",
	".dll",
	".so",
	".class",
	".jar",
	".war",
	".7z",
	".doc",
	".docx",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".odt",
	".ods",
	".odp",
	".bin",
	".dat",
	".obj",
	".o",
	".a",
	".lib",
	".wasm",
	".pyc",
	".pyo",
]);

function isBinaryFile(filePath: string, sample: Buffer): boolean {
	if (BINARY_EXTENSIONS.has(extname(filePath).toLowerCase())) return true;
	if (sample.length === 0) return false;

	let nonPrintableCount = 0;
	for (let i = 0; i < sample.length; i++) {
		const byte = sample[i]!;
		if (byte === 0) return true;
		if (byte < 9 || (byte > 13 && byte < 32)) nonPrintableCount++;
	}
	return nonPrintableCount / sample.length > 0.3;
}

const SAMPLE_BYTES = 4096;

/** Above this, `read` streams instead of loading the file into memory. Well
 * clear of any source file, and small enough that the whole-file path's ~3x
 * memory cost stays negligible. */
const MAX_WHOLE_FILE_BYTES = 8 * 1024 * 1024;

function startLineFrom(offset: number | undefined): number {
	return offset ? Math.max(0, offset - 1) : 0;
}

/** First `bytes` bytes of a file, without reading the rest of it. */
async function readSample(absolutePath: string, bytes: number): Promise<Buffer> {
	const handle = await open(absolutePath, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
}

/**
 * Streams a large file, keeping only the requested line window in memory.
 *
 * The total line count is deliberately not reported: knowing it means reading
 * to the end, which for the files this path exists for is exactly the work
 * being avoided. The continuation hint carries the offset to resume from
 * instead, which is what a caller actually needs.
 */
async function readLargeFile(
	absolutePath: string,
	sizeBytes: number,
	startLine: number,
	limit: number | undefined,
	config: AppConfig,
): Promise<ToolResult> {
	const maxLines = Math.min(limit ?? config.maxToolOutputLines, config.maxToolOutputLines);
	const maxBytes = config.maxToolOutputBytes;
	const kept: string[] = [];
	let lineNumber = 0;
	let usedBytes = 0;
	let stoppedOnBytes = false;
	const stream = createReadStream(absolutePath, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			lineNumber++;
			if (lineNumber <= startLine) continue;
			const rendered = `${lineNumber}: ${line}`;
			usedBytes += Buffer.byteLength(rendered, "utf-8") + 1;
			if (usedBytes > maxBytes && kept.length > 0) {
				stoppedOnBytes = true;
				break;
			}
			kept.push(usedBytes > maxBytes ? `${rendered.slice(0, maxBytes)}… [line truncated, too large]` : rendered);
			if (kept.length >= maxLines) break;
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	if (kept.length === 0) {
		return {
			content: `Offset ${startLine + 1} is beyond end of file (${lineNumber} lines, ${formatSize(sizeBytes)})`,
			isError: true,
		};
	}
	const nextOffset = startLine + kept.length + 1;
	const why = stoppedOnBytes ? `stopped at ${formatSize(maxBytes)}` : `${kept.length} line(s) shown`;
	const hint =
		`\n\n[Large file (${formatSize(sizeBytes)}) — read streams it, so the total line count is not counted. ` +
		`Showing lines ${startLine + 1}-${startLine + kept.length} (${why}). Use offset=${nextOffset} to continue, ` +
		`or grep/bash for a targeted search.]`;
	return { content: kept.join("\n") + hint };
}

/**
 * cast's own installation root, or null when this build isn't running from
 * one. Found by walking up from this module looking for cast's package.json —
 * works both from the repo (src/core/tools/) and from a built install
 * (<root>/dist/index.js).
 */
let castRootCache: string | null | undefined;
function castRoot(): string | null {
	if (castRootCache !== undefined) return castRootCache;
	castRootCache = null;
	let dir = import.meta.dirname;
	for (let up = 0; dir && up < 6; up++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { name?: string };
			if (pkg.name === "cast") {
				castRootCache = dir;
				break;
			}
		} catch {
			// No package.json here (or unreadable/not JSON) — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return castRootCache;
}

/**
 * The built-in web UI is read-only: the agent is meant to add UIs under
 * ~/.cast/ui/, not overwrite cast's own.
 *
 * The check used to be a substring test for "/src/server/public/" and
 * "/dist/public/" against the path alone, which matched those directory
 * names *in any project* — a user working on their own Node app that happens
 * to have src/server/public could not have the agent write there at all
 * (verified: a plain write into an unrelated project's own
 * src/server/public/app.js was refused). It is anchored to cast's own
 * installation root now, so it protects what it was meant to protect and
 * nothing else.
 */
function builtInUiBlockReason(absolutePath: string): string | null {
	const root = castRoot();
	if (!root) return null;
	const protectedDirs = [
		join(root, "src", "server", "public"),
		join(root, "dist", "public"),
		join(root, "src", "server", "ui-factory", "template"),
	];
	const full = resolve(absolutePath);
	return protectedDirs.some((dir) => full === dir || full.startsWith(dir + sep)) ? root : null;
}

export async function execRead(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
	const filePath = typeof args.path === "string" ? args.path : "";
	if (!filePath.trim()) return { content: 'Error: "path" is required and must be a non-empty string.', isError: true };
	if (
		args.offset !== undefined &&
		(typeof args.offset !== "number" || !Number.isInteger(args.offset) || args.offset < 1)
	) {
		return { content: 'Error: "offset" must be a positive integer. Retry with offset: 1 or greater.', isError: true };
	}
	if (
		args.limit !== undefined &&
		(typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 0)
	) {
		return {
			content: 'Error: "limit" must be a non-negative integer. Retry with limit: 0 or greater.',
			isError: true,
		};
	}
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	const absolutePath = resolvePath(filePath, cwd);

	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		await access(absolutePath, constants.R_OK);
		stats = await stat(absolutePath);
	} catch (err) {
		if (isEnoent(err)) return fileNotFoundResult(filePath, cwd, config);
		throw err;
	}

	// Directory: list entries one per line (files and subdirectories, the
	// latter with a trailing "/") — not a replacement for `ls` (no
	// size/type column), just enough that pointing `read` at a directory by
	// mistake doesn't throw and does something useful.
	if (stats.isDirectory()) {
		const entries = await readdir(absolutePath, { withFileTypes: true });
		const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort((a, b) => a.localeCompare(b));
		const start = offset ? Math.max(0, offset - 1) : 0;
		const cap = limit ?? config.maxToolOutputLines;
		const sliced = names.slice(start, start + cap);
		const truncated = start + sliced.length < names.length;
		const hint = truncated
			? `\n\n[Showing ${sliced.length} of ${names.length} entries. Use offset=${start + sliced.length + 1} to continue.]`
			: `\n\n(${names.length} entries)`;
		return { content: sliced.join("\n") + hint };
	}

	const mimeType = IMAGE_MIME_TYPES[extname(absolutePath).toLowerCase()];
	if (mimeType) {
		if (stats.size > MAX_IMAGE_BYTES) {
			return {
				content: `Image too large to read (${formatSize(stats.size)}, max ${formatSize(MAX_IMAGE_BYTES)}): ${filePath}`,
				isError: true,
			};
		}
		const original = await readFile(absolutePath);
		const resized = await resizeImageForEmbedding(original, mimeType);
		const embedded = resized?.buffer ?? original;
		const note = resized ? ` — downscaled from ${formatSize(stats.size)} to ${formatSize(embedded.length)}` : "";
		return {
			content: `[Image: ${filePath} (${mimeType}, ${formatSize(stats.size)}${note}) — shown in the next message]`,
			imageDataUrl: `data:${mimeType};base64,${embedded.toString("base64")}`,
		};
	}

	// Sample the first few KB to classify binary-vs-text *before* reading the
	// whole file — the old order read everything first, so a binary blob was
	// pulled fully into memory only to be rejected.
	const sample = await readSample(absolutePath, SAMPLE_BYTES);
	if (isBinaryFile(absolutePath, sample)) {
		return { content: `Cannot read binary file: ${filePath}`, isError: true };
	}

	// A file above the scan ceiling is read line by line and only the
	// requested window is kept. Reading it whole cost roughly three times its
	// size in memory (buffer + UTF-16 string + split array): measured 592MB of
	// RSS to return five lines of a 200MB log, so a multi-GB file — a log, a
	// dump, a .jsonl dataset — took the process down before printing anything.
	if (stats.size > MAX_WHOLE_FILE_BYTES) {
		return readLargeFile(absolutePath, stats.size, startLineFrom(offset), limit, config);
	}

	const fullBuffer = await readFile(absolutePath);
	const allLines = fullBuffer.toString("utf-8").split("\n");

	const startLine = startLineFrom(offset);
	if (startLine >= allLines.length) {
		return { content: `Offset ${offset} is beyond end of file (${allLines.length} lines total)`, isError: true };
	}

	// `limit ? ... : allLines.length` would treat an explicit `limit: 0` as
	// "no limit" (0 is falsy) and dump the whole file instead of reading zero
	// lines — check for "was a limit given at all" instead of truthiness.
	const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
	let selectedLines = allLines.slice(startLine, endLine);

	// Truncate if too many lines
	if (selectedLines.length > config.maxToolOutputLines) {
		selectedLines = selectedLines.slice(0, config.maxToolOutputLines);
	}

	// Plain `<line>: <content>` — no hashline gutter (see this file's header).
	const rendered = selectedLines.map((line, i) => `${startLine + i + 1}: ${line}`);

	// Cap total output bytes too, not just line count: maxToolOutputLines
	// doesn't help when a handful of lines — or even one, e.g. a minified
	// bundle — are each many MB long. Without this a single-line file blew
	// straight past config.maxToolOutputBytes regardless of size, unlike
	// every other tool (bash/ssh/grep) which enforces this cap.
	const maxBytes = config.maxToolOutputBytes;
	let usedBytes = 0;
	let cutIndex = rendered.length;
	for (let i = 0; i < rendered.length; i++) {
		usedBytes += Buffer.byteLength(rendered[i]!, "utf-8") + 1; // +1 for the joining "\n"
		if (usedBytes > maxBytes) {
			cutIndex = i;
			break;
		}
	}
	let displayLines = rendered.slice(0, cutIndex);
	let firstLineTruncated = false;
	if (cutIndex === 0 && rendered.length > 0) {
		// Even the first line alone blows the byte budget — truncate its text
		// directly so `read` still returns something bounded instead of an
		// empty result for a file that does have content.
		const buf = Buffer.from(rendered[0]!, "utf-8");
		displayLines = [`${buf.subarray(0, maxBytes).toString("utf-8")}… [line truncated, too large]`];
		firstLineTruncated = true;
	}
	const byteTruncated = cutIndex < rendered.length;
	const numbered = displayLines.join("\n");

	// Build continuation hint
	const totalLines = allLines.length;
	const shownLineCount = firstLineTruncated ? 1 : displayLines.length;
	const shownEnd = startLine + shownLineCount;
	let hint = "";
	if (byteTruncated) {
		hint = firstLineTruncated
			? `\n\n[Line ${startLine + 1} truncated at ${formatSize(maxBytes)} — the line itself is larger than the output limit.]`
			: `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${totalLines} (stopped at ${formatSize(maxBytes)}). Use offset=${shownEnd + 1} to continue.]`;
	} else if (shownEnd < totalLines) {
		hint =
			shownLineCount > 0
				? `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${totalLines}. Use offset=${shownEnd + 1} to continue.]`
				: // limit:0 (or any zero-width request) selects no lines — "lines 1-0"
					// misreads as a range rather than an explicit zero, and shownEnd
					// equals startLine here so it can't anchor the message either.
					`\n\n[Showing 0 lines of ${totalLines}. Use offset=${startLine + 1} to continue.]`;
	}

	return { content: numbered + hint };
}

export async function execWrite(args: Record<string, unknown>, cwd: string): Promise<ToolResult> {
	const filePath = typeof args.path === "string" ? args.path : "";
	if (!filePath.trim()) return { content: 'Error: "path" is required and must be a non-empty string.', isError: true };
	if (typeof args.content !== "string") {
		return {
			content: 'Error: "content" is required and must be a string. Retry write with the complete file content.',
			isError: true,
		};
	}
	const content = args.content;
	const absolutePath = resolvePath(filePath, cwd);
	// Guard cast's own built-in UI — the agent must add UIs under ~/.cast/ui/.
	if (builtInUiBlockReason(absolutePath)) {
		return {
			content: `Blocked: built-in UI at ${absolutePath} is read-only. Use ~/.cast/ui/<name>/ (served at /ui/<name>/) or POST /api/uis — see ui-factory skill.`,
			isError: true,
		};
	}

	let oldContent: string | null = null;
	try {
		oldContent = await readFile(absolutePath, "utf-8");
	} catch (err) {
		if (!isEnoent(err)) {
			const described = describeFileWriteError(err, filePath);
			if (described) return { content: `Error: ${described}`, isError: true };
			throw err;
		}
	}

	try {
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content, "utf-8");
	} catch (err) {
		const described = describeFileWriteError(err, filePath);
		if (described) return { content: `Error: ${described}`, isError: true };
		throw err;
	}

	const newLines = content.split("\n");
	const dupWarning = duplicateRunWarning(newLines);
	const warn = dupWarning ? `\nWarning: ${dupWarning}` : "";

	if (oldContent === null) {
		// content.length counts UTF-16 code units, not bytes — for any
		// non-ASCII content (Cyrillic, CJK, emoji) that undercounts what
		// writeFile's "utf-8" encoding actually put on disk (confirmed: a
		// 13-character Cyrillic+emoji string reported "13 bytes" for a file
		// that was actually 24 bytes). Buffer.byteLength gives the real count.
		const byteLength = Buffer.byteLength(content, "utf-8");
		return { content: `Created ${filePath} (${newLines.length} lines, ${byteLength} bytes).${warn}` };
	}
	if (oldContent === content) {
		return { content: `Wrote ${filePath} — content is identical to what was already on disk.${warn}` };
	}
	// Echo the change as a diff rather than a byte count. A full rewrite is
	// where the model most often reproduces stale or corrupted content from
	// its context; a visible diff of what actually changed catches that
	// immediately, where "wrote N bytes" hides it.
	//
	// The trailing newline is diffed out-of-band: models drop or add it all
	// the time, and letting it into the line diff destroys the common-suffix
	// match — every trailing line then shows as -/+ noise drowning the real
	// change.
	const oldDiffLines = oldContent.split("\n");
	const hadTrailingNl = oldDiffLines[oldDiffLines.length - 1] === "" && oldDiffLines.length > 1;
	const hasTrailingNl = newLines[newLines.length - 1] === "" && newLines.length > 1;
	if (hadTrailingNl) oldDiffLines.pop();
	const newDiffLines = hasTrailingNl ? newLines.slice(0, -1) : newLines;
	let nlNote = "";
	if (hadTrailingNl !== hasTrailingNl) {
		nlNote = hasTrailingNl
			? "\nNote: trailing newline added."
			: "\nNote: trailing newline removed — the file no longer ends with a newline.";
	}
	const diff = formatWriteDiff(oldDiffLines, newDiffLines);
	return {
		content: `Overwrote ${filePath} (${newLines.length} lines). Diff vs previous content:\n\n${diff}${nlNote}${warn}`,
	};
}

const MAX_DIFF_LINES = 80;

/**
 * Minimal line diff for the `write`/`edit` echo: trim the common prefix and
 * suffix, show what's left as `-`/`+` blocks with one context line on
 * each side. Not an LCS — a full rewrite usually changes one region, and
 * when it doesn't, the (truncated) coarse diff still shows the shape of
 * the change.
 */
function formatWriteDiff(oldLines: string[], newLines: string[]): string {
	let prefix = 0;
	const maxPrefix = Math.min(oldLines.length, newLines.length);
	while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	const maxSuffix = Math.min(oldLines.length, newLines.length) - prefix;
	while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) {
		suffix++;
	}
	const out: string[] = [];
	if (prefix > 0) out.push(`  ${oldLines[prefix - 1]}`);
	const removed = oldLines.slice(prefix, oldLines.length - suffix);
	const added = newLines.slice(prefix, newLines.length - suffix);
	let budget = MAX_DIFF_LINES;
	for (const line of removed) {
		if (budget-- <= 0) break;
		out.push(`- ${line}`);
	}
	for (const line of added) {
		if (budget-- <= 0) break;
		out.push(`+ ${line}`);
	}
	if (budget < 0) out.push(`⋯ (diff truncated: ${removed.length} removed, ${added.length} added in total)`);
	if (suffix > 0) out.push(`  ${newLines[newLines.length - suffix]}`);
	return out.join("\n");
}

/**
 * Detect runs of consecutive byte-identical non-blank lines — the classic
 * symptom of a botched edit or a rewrite that copied corrupted context
 * (e.g. the same comment pasted twice). Surfaced as a warning, never an
 * error: legitimate duplicates exist, but they're rare enough that a nudge
 * to double-check is worth it.
 */
function duplicateRunWarning(lines: string[]): string | null {
	const runs: string[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "" || line !== lines[i - 1]) continue;
		let end = i;
		while (end + 1 < lines.length && lines[end + 1] === line) end++;
		runs.push(`lines ${i}-${end + 1} ("${line.trim().slice(0, 60)}")`);
		i = end;
	}
	if (runs.length === 0) return null;
	return `file contains consecutive identical lines — ${runs.join("; ")}. If unintentional, remove the duplicates.`;
}

/**
 * `oldString`/`newString` literal-text edit — see tools/text-replace.ts for
 * the matching algorithm itself. Unlike the legacy anchor-based edit,
 * there's no separate read-then-cache step: the file is read fresh on
 * every call, matched, and rewritten.
 */
export async function execEdit(args: Record<string, unknown>, cwd: string, config: AppConfig): Promise<ToolResult> {
	const filePath = typeof args.filePath === "string" ? args.filePath : "";
	if (!filePath.trim())
		return { content: 'Error: "filePath" is required and must be a non-empty string.', isError: true };
	const oldString = typeof args.oldString === "string" ? args.oldString : undefined;
	const newString = typeof args.newString === "string" ? args.newString : undefined;
	if (oldString === undefined || newString === undefined) {
		return { content: "oldString and newString are required", isError: true };
	}
	const replaceAll = args.replaceAll === true;

	const absolutePath = resolvePath(filePath, cwd);
	if (builtInUiBlockReason(absolutePath)) {
		return {
			content: `Blocked: built-in UI at ${absolutePath} is read-only. Use ~/.cast/ui/<name>/ (served at /ui/<name>/) — see ui-factory skill.`,
			isError: true,
		};
	}

	// oldString: "" means "create a new file with newString" — the documented
	// way to create a file via `edit` instead of `write`.
	if (oldString === "") {
		let existed = false;
		try {
			await access(absolutePath, constants.F_OK);
			existed = true;
		} catch {
			existed = false;
		}
		if (existed) {
			return {
				content:
					"oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
				isError: true,
			};
		}
		try {
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, newString, "utf-8");
		} catch (err) {
			const described = describeFileWriteError(err, filePath);
			if (described) return { content: `Error: ${described}`, isError: true };
			throw err;
		}
		const dupWarning = duplicateRunWarning(newString.split("\n"));
		return { content: `Created ${filePath}.${dupWarning ? `\nWarning: ${dupWarning}` : ""}` };
	}

	try {
		await access(absolutePath, constants.R_OK | constants.W_OK);
	} catch (err) {
		if (isEnoent(err)) return fileNotFoundResult(filePath, cwd, config);
		// A file the agent may read but not write reached here as an
		// unhandled EACCES from the access() probe itself, so `edit` on a
		// read-only file threw out of the tool instead of reporting why.
		const described = describeFileWriteError(err, filePath);
		if (described) return { content: `Error: ${described}`, isError: true };
		throw err;
	}

	const rawContent = await readFile(absolutePath, "utf-8");
	const ending = detectLineEnding(rawContent);
	const contentOld = normalizeLineEndings(rawContent);
	// Model-authored oldString/newString may carry their own \r\n or stray \r
	// (e.g. copy-pasted from a CRLF source) — normalize both to bare \n before
	// matching/replacing, then convert the whole result back to the file's
	// own line ending in one pass below. Without stripping stray \r here, a
	// lone \r survives into the match and gets doubled when convertToLineEnding
	// appends its own \r before every \n.
	const oldNormalized = normalizeLineEndings(oldString).replaceAll("\r", "");
	const newNormalized = normalizeLineEndings(newString).replaceAll("\r", "");

	let contentNew: string;
	try {
		contentNew = replace(contentOld, oldNormalized, newNormalized, replaceAll);
	} catch (err) {
		return { content: err instanceof Error ? err.message : String(err), isError: true };
	}

	try {
		await writeFile(absolutePath, convertToLineEnding(contentNew, ending), "utf-8");
	} catch (err) {
		const described = describeFileWriteError(err, filePath);
		if (described) return { content: `Error: ${described}`, isError: true };
		throw err;
	}

	const diff = formatWriteDiff(contentOld.split("\n"), contentNew.split("\n"));
	const dupWarning = duplicateRunWarning(contentNew.split("\n"));
	return {
		content: `Edit applied to ${filePath}. Diff:\n\n${diff}${dupWarning ? `\nWarning: ${dupWarning}` : ""}`,
	};
}
