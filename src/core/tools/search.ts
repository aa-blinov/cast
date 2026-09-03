/**
 * Search tools — `glob` (filename patterns, via fd), `grep` (content, via rg),
 * and `ls`. fd/rg are used when installed; otherwise a built-in tree walk
 * provides a degraded fallback that still skips default-ignored dirs and
 * honours .gitignore (including nested ones), which a bare `find`/`grep -r`
 * wouldn't.
 */

import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "../config.ts";
import { formatSize, relativeToCwd, resolvePath, type ToolResult, toolError } from "./shared.ts";

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const SEARCH_PATH_PREFIX_RE = /^\.\//gm;
const PERMISSION_DENIED_RE = /operation not permitted|permission denied/i;

// execFile (not execFileSync) — the sync variant blocks the whole Node event
// loop for as long as fd/rg run. Under concurrent tool execution (several
// eval cases, or several agent turns, spawning searches around the same
// time) that stalls every other in-flight call, not just this one — a
// correctness-neutral but real efficiency cost the async variant avoids.
const execFileAsync = promisify(execFile);

class SearchAbortedError extends Error {}

function abortedSearchResult(): ToolResult {
	return toolError("[ABORTED] Search was interrupted by the user.", {
		code: "ABORTED",
		retryable: false,
		suggestedFix: "Only restart the search if the user still wants it to run.",
	});
}

function throwIfSearchAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new SearchAbortedError();
}

// ============================================================================
// Fallback file walking — used when fd/rg aren't installed. fd/rg both skip
// node_modules/.git/etc and respect .gitignore by default; a bare `find`/
// `grep -r` doesn't, and without this a fallback search over a real repo
// returns thousands of node_modules matches instead of failing cleanly.
// This isn't a full .gitignore implementation (no negation, no nested
// .gitignore files) — just enough to keep a degraded-but-missing-fd/rg
// search usable.
// ============================================================================

const DEFAULT_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".next",
	".nuxt",
	"out",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	".turbo",
]);

const MAX_WALK_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;

interface GitignoreRule {
	regex: RegExp;
	dirOnly: boolean;
	negated: boolean;
}

function escapeRegExp(text: string): string {
	return text.replace(REGEX_ESCAPE_RE, "\\$&");
}

/**
 * Convert a glob pattern to a regex source, character by character -- avoids
 * chained .replace() calls with placeholder tokens, which are easy to get
 * subtly wrong. `**` matches across path separators; a lone `*` doesn't.
 */
function globToRegExpSource(glob: string): string {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					// `**/` matches zero or more whole path segments —
					// `**/*.ts` must also match a root-level `top.ts`,
					// not just files at least one directory deep. A bare
					// ".*" + literal "/" would demand a slash even when
					// ** matches nothing, so fold the separator into an
					// optional group instead of emitting it as a literal.
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i++;
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else if (ch === "{") {
			// Brace expansion: {a,b,c} → (a|b|c)
			const close = glob.indexOf("}", i);
			if (close !== -1) {
				const alternatives = glob
					.slice(i + 1, close)
					.split(",")
					.map((alt) => globToRegExpSource(alt));
				out += `(${alternatives.join("|")})`;
				i = close;
			} else {
				out += escapeRegExp(ch);
			}
		} else {
			out += escapeRegExp(ch);
		}
	}
	return out;
}

function parseGitignoreFile(text: string): GitignoreRule[] {
	const rules: GitignoreRule[] = [];
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const negated = line.startsWith("!");
		const body = negated ? line.slice(1) : line;
		const dirOnly = body.endsWith("/");
		const pattern = dirOnly ? body.slice(0, -1) : body;
		const anchored = pattern.startsWith("/");
		const globBody = globToRegExpSource(anchored ? pattern.slice(1) : pattern);

		rules.push({ regex: new RegExp(anchored ? `^${globBody}$` : `(^|/)${globBody}$`), dirOnly, negated });
	}
	return rules;
}

async function parseGitignore(root: string): Promise<GitignoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(root, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return parseGitignoreFile(text);
}

async function parseGitignoreNested(dir: string): Promise<GitignoreRule[]> {
	let text: string;
	try {
		text = await readFile(join(dir, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return parseGitignoreFile(text);
}

function isGitignored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (!rule.dirOnly || isDir) {
			if (rule.regex.test(relPath)) {
				ignored = !rule.negated;
			}
		}
	}
	return ignored;
}

function globToFileRegExp(glob: string): RegExp {
	return new RegExp(`^${globToRegExpSource(glob)}$`);
}

/** Collect file paths under searchPath, skipping default-ignored dirs and .gitignore matches. */
async function walkFiles(
	cwd: string,
	searchPath: string,
	maxFiles: number = MAX_WALK_FILES,
	signal?: AbortSignal,
): Promise<string[]> {
	throwIfSearchAborted(signal);
	const rootRules = await parseGitignore(cwd);
	const visited = new Set<string>();
	const stack: Array<{ dir: string; rules: GitignoreRule[] }> = [{ dir: searchPath, rules: rootRules }];
	const results: string[] = [];

	while (stack.length > 0 && results.length < maxFiles) {
		throwIfSearchAborted(signal);
		const { dir, rules } = stack.pop()!;
		let entries: Dirent[];
		try {
			// biome-ignore lint/performance/noAwaitInLoops: sequential — each step depends on the previous
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			throwIfSearchAborted(signal);
			if (results.length >= maxFiles) break;
			const absPath = join(dir, entry.name);
			const relPath = relative(cwd, absPath);
			const isDir = entry.isDirectory();

			if (isDir && DEFAULT_IGNORE_DIRS.has(entry.name)) continue;

			// Resolve symlinks to detect cycles — a symlink pointing to an
			// ancestor directory would loop forever without this.
			if (entry.isSymbolicLink()) {
				try {
					// biome-ignore lint/performance/noAwaitInLoops: sequential — each step depends on the previous
					const real = await realpath(absPath);
					if (visited.has(real)) continue;
					visited.add(real);
					const st = await stat(real);
					if (st.isDirectory()) {
						const nestedRules = await parseGitignoreNested(real);
						stack.push({ dir: real, rules: [...rules, ...nestedRules] });
					} else if (st.isFile()) {
						if (!isGitignored(relPath, false, rules)) results.push(real);
					}
				} catch {
					continue;
				}
				continue;
			}

			if (isGitignored(relPath, isDir, rules)) continue;

			if (isDir) {
				const nestedRules = await parseGitignoreNested(absPath);
				stack.push({ dir: absPath, rules: [...rules, ...nestedRules] });
			} else if (entry.isFile()) {
				results.push(absPath);
			}
		}
	}
	return results;
}

export async function execGlob(
	args: Record<string, unknown>,
	cwd: string,
	_config: AppConfig,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (signal?.aborted) return abortedSearchResult();
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	if (!pattern.trim())
		return { content: 'Error: "pattern" is required. Retry with a glob such as "**/*.ts".', isError: true };
	if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) {
		return {
			content: 'Error: "path" must be a non-empty directory path when provided. Retry with a valid directory.',
			isError: true,
		};
	}
	if (
		args.limit !== undefined &&
		(typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)
	) {
		return { content: 'Error: "limit" must be a positive integer. Retry with limit: 1 or greater.', isError: true };
	}
	const searchPath = typeof args.path === "string" ? resolvePath(args.path, cwd) : cwd;
	const limit = typeof args.limit === "number" ? args.limit : 1000;
	let searchStats: Awaited<ReturnType<typeof stat>>;
	try {
		searchStats = await stat(searchPath);
	} catch (error) {
		const code = (error as { code?: string })?.code;
		if (code === "ENOENT")
			return {
				content: `Error: search directory not found: ${searchPath}. Check the path and retry.`,
				isError: true,
			};
		return {
			content: `Error: cannot access search directory ${searchPath}. Check permissions and retry.`,
			isError: true,
		};
	}
	if (!searchStats.isDirectory()) {
		return {
			content: `Error: glob path must be a directory, but ${searchPath} is not. Retry with a directory path.`,
			isError: true,
		};
	}

	const gitignorePath = join(searchPath, ".gitignore");
	const hasGitignore = await access(gitignorePath, constants.R_OK)
		.then(() => true)
		.catch(() => false);

	let absolutePaths: string[];
	try {
		// execFileSync runs the binary directly, no shell involved — unlike the
		// execSync(`fd ... '${pattern}' ...`) this replaced, a pattern
		// containing a single quote can't break out of the argument and inject
		// arbitrary shell commands (confirmed exploitable: a pattern like
		// `x'; echo pwned > /tmp/x; echo '` ran the injected command). Callers
		// don't get a say here — pattern/path come straight from a tool call
		// argument, so this can't rely on the input being well-behaved.
		//
		// --ignore-file: fd doesn't respect .gitignore outside git repos;
		// pass it explicitly so negation rules work everywhere. Nested
		// .gitignore files in subdirectories are not auto-discovered by fd
		// (ponytail: would need a pre-walk to collect them); the walkFiles
		// fallback handles them when fd is absent.
		const fdArgs = ["--glob", "--type", "f", "--max-results", String(limit)];
		if (hasGitignore) fdArgs.push("--ignore-file", gitignorePath);
		// Without -p, fd matches the pattern against the basename only — a
		// pattern with a directory component (`src/**/*.ts`, `**/tools/*.ts`)
		// would then never match anything, since a basename never contains a
		// "/". Only opt into full-path matching (and only then anchor with a
		// leading "**/") for such patterns, so plain patterns like `*.ts` keep
		// matching by basename exactly as before — full-path matching would
		// otherwise break them, since a bare `*` never crosses a "/".
		let fdPattern = pattern;
		if (pattern.includes("/")) {
			fdArgs.push("--full-path");
			fdPattern = pattern.startsWith("**/") ? pattern : `**/${pattern}`;
		}
		fdArgs.push(fdPattern, searchPath);
		// Capture stderr rather than inheriting it — an invalid glob makes fd
		// print "[fd error]: …" which would otherwise land in the TUI frame.
		const { stdout } = await execFileAsync("fd", fdArgs, {
			encoding: "utf-8",
			timeout: 10_000,
			cwd: searchPath,
			signal,
		});
		absolutePaths = stdout.trim().split("\n").filter(Boolean);
	} catch {
		if (signal?.aborted) return abortedSearchResult();
		// fd isn't installed or returned an error (e.g. invalid glob
		// pattern) — walk the tree ourselves. Patterns with a directory
		// component match against the path relative to searchPath (mirrors
		// the --full-path handling above); plain patterns match the basename,
		// same as `find -name`.
		try {
			const allFiles = await walkFiles(cwd, searchPath, MAX_WALK_FILES, signal);
			if (pattern.includes("/")) {
				const anchoredPattern = pattern.startsWith("**/") ? pattern : `**/${pattern}`;
				const pathRe = globToFileRegExp(anchoredPattern);
				absolutePaths = allFiles.filter((p) => pathRe.test(relative(searchPath, p))).slice(0, limit);
			} else {
				const nameRe = globToFileRegExp(pattern);
				absolutePaths = allFiles.filter((p) => nameRe.test(basename(p))).slice(0, limit);
			}
		} catch (error) {
			if (error instanceof SearchAbortedError) return abortedSearchResult();
			throw error;
		}
	}

	if (absolutePaths.length === 0) return { content: "No files found" };

	const relativePaths = absolutePaths.map((p) => relativeToCwd(p, cwd));
	let content = relativePaths.join("\n");
	// Few hits → steer the model straight to read instead of another glob/ls.
	if (relativePaths.length <= 3) {
		content += "\n[note: call read on one of these paths — do not glob or ls again]";
	}
	return { content };
}

const MISSING_FILE_SUGGESTION_LIMIT = 5;

/**
 * Run the same basename search as `glob` (under the hood) when a tool path
 * misses. Returns relative hits only — never invents paths that aren't on disk.
 * Empty when nothing matches or the name is unusable.
 */
export async function findFilesByBasename(
	name: string,
	cwd: string,
	config: AppConfig,
	limit: number = MISSING_FILE_SUGGESTION_LIMIT,
): Promise<string[]> {
	const trimmed = name.trim();
	if (!trimmed || trimmed === "." || trimmed === "..") return [];
	// Exact basename match — same pattern shape a model would pass to `glob`.
	const result = await execGlob({ pattern: trimmed, limit }, cwd, config);
	if (result.isError || !result.content || result.content === "No files found") return [];
	return result.content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("[note:"))
		.slice(0, limit);
}

/** True for filesystem errors that mean "not allowed to read this", as opposed
 * to "doesn't exist". On macOS these are what a denied Full Disk Access / folder
 * (TCC) permission produces when a tool walks into ~/Documents, ~/Desktop, etc. */
export function isPermissionError(err: unknown): boolean {
	const code = (err as { code?: string })?.code;
	return code === "EPERM" || code === "EACCES";
}

/** Append a one-line note when the search couldn't read everything because of
 * permissions — either the JS fallback hit EPERM/EACCES on some paths, or rg's
 * stderr reported it. Without this the tool silently under-matches: the model
 * (and the user) never learn that files were skipped, not simply absent. */
export function withAccessNote(output: string, rgStderr: string, permissionSkips: number): string {
	const rgDenied = PERMISSION_DENIED_RE.test(rgStderr);
	if (permissionSkips === 0 && !rgDenied) return output;
	const skipped = permissionSkips > 0 ? `${permissionSkips} path(s)` : "some paths";
	const note = `[note: ${skipped} skipped — permission denied. On macOS, grant your terminal app Full Disk Access in System Settings → Privacy & Security, then restart it.]`;
	return output ? `${output}\n${note}` : note;
}

export async function execGrep(
	args: Record<string, unknown>,
	cwd: string,
	config: AppConfig,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (signal?.aborted) return abortedSearchResult();
	const pattern = typeof args.pattern === "string" ? args.pattern : "";
	if (!pattern)
		return {
			content: 'Error: "pattern" is required. Retry with the text or regular expression to search for.',
			isError: true,
		};
	if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) {
		return {
			content: 'Error: "path" must be a non-empty file or directory path when provided. Retry with a valid path.',
			isError: true,
		};
	}
	if (
		args.limit !== undefined &&
		(typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)
	) {
		return { content: 'Error: "limit" must be a positive integer. Retry with limit: 1 or greater.', isError: true };
	}
	if (
		args.context !== undefined &&
		(typeof args.context !== "number" || !Number.isInteger(args.context) || args.context < 0)
	) {
		return {
			content: 'Error: "context" must be a non-negative integer. Retry with context: 0 or greater.',
			isError: true,
		};
	}
	const searchPath = typeof args.path === "string" ? resolvePath(args.path, cwd) : cwd;
	try {
		await stat(searchPath);
	} catch (error) {
		const code = (error as { code?: string })?.code;
		if (code === "ENOENT")
			return { content: `Error: search path not found: ${searchPath}. Check the path and retry.`, isError: true };
		return { content: `Error: cannot access search path ${searchPath}. Check permissions and retry.`, isError: true };
	}
	const glob = args.glob ? String(args.glob) : undefined;
	const ignoreCase = args.ignoreCase === true;
	const literal = args.literal === true;
	const context = typeof args.context === "number" ? args.context : 0;
	const limit = typeof args.limit === "number" ? args.limit : 100;

	// Build rg command
	const flags: string[] = ["--line-number", "--no-heading"];
	if (ignoreCase) flags.push("--ignore-case");
	if (literal) flags.push("--fixed-strings");
	if (context > 0) flags.push(`--context=${context}`);
	if (glob) {
		// Normalize directory globs the same way as the JS fallback so both
		// implementations accept `src/**/*.ts` as well as `**/src/**/*.ts`.
		const negated = glob.startsWith("!");
		const globBody = negated ? glob.slice(1) : glob;
		const rgGlob = globBody.includes("/") && !globBody.startsWith("**/") ? `**/${globBody}` : globBody;
		flags.push(`--glob=${negated ? "!" : ""}${rgGlob}`);
	}
	flags.push("--max-count", String(limit));

	let output: string;
	try {
		// See execGlob for why this is execFile (argument array, not a shell
		// string) — pattern/glob come straight from a tool call argument, and
		// a shell-interpolated `'${pattern}'` is exploitable by anything
		// containing a single quote (confirmed with a payload that ran an
		// injected command).
		const searchPathIsDirectory = await stat(searchPath)
			.then((stats) => stats.isDirectory())
			.catch(() => false);
		const { stdout } = await execFileAsync(
			"rg",
			[...flags, "--", pattern, searchPathIsDirectory ? "." : searchPath],
			{
				encoding: "utf-8",
				timeout: 10_000,
				maxBuffer: config.maxToolOutputBytes,
				signal,
				...(searchPathIsDirectory ? { cwd: searchPath } : {}),
			},
		);
		// Match globs relative to the requested directory, rather than an
		// absolute command argument whose parent names could accidentally match
		// a directory component. The fallback uses the same root-relative form.
		output = searchPathIsDirectory ? stdout.replace(SEARCH_PATH_PREFIX_RE, "") : stdout;
	} catch (err) {
		if (signal?.aborted) return abortedSearchResult();
		// rg's exit codes: 0 = matches found, 1 = ran cleanly but nothing
		// matched, 2 = a real error (bad regex, unreadable root, …). The
		// promisified execFile rejects on any non-zero exit, with the exit
		// code on `.code` (a number) — spawn-level failures like ENOENT put a
		// string there instead ('ENOENT'), so `e.code === 1` only ever matches
		// a real "ran cleanly, no matches" exit.
		const e = err as { code?: number | string; stderr?: string | Buffer };
		const rgStderr = typeof e.stderr === "string" ? e.stderr : e.stderr ? e.stderr.toString() : "";

		// Exit 1 = "no matches". rg already did the work and found nothing —
		// return immediately. The old code fell through to the whole-tree JS
		// walk here on *every* empty search: pointless work, and on a large
		// tree under ~/Documents it re-walks macOS-protected folders, firing a
		// TCC permission prompt for a query that was simply going to be empty.
		if (e.code === 1) {
			return { content: withAccessNote("No matches found", rgStderr, 0) };
		}

		// Anything else — rg not installed (ENOENT), wrong-arch binary, timeout,
		// buffer overflow, or a genuine rg error (status 2) — falls back to the
		// JS walk. Track paths skipped for permission reasons so a macOS TCC /
		// Full Disk Access problem surfaces instead of silently under-matching.
		let permissionSkips = 0;

		let patternRe: RegExp;
		try {
			patternRe = new RegExp(literal ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
		} catch {
			return { content: `Invalid pattern: ${pattern}`, isError: true };
		}

		// Mirrors execGlob's fd/no-fd parity fix: rg's own --glob matches a
		// slash-free pattern against the basename anywhere, but anchors a
		// pattern containing "/" against the path relative to the search
		// root. Testing every glob against basename() here (as this used to)
		// silently dropped the directory-component case in this fallback,
		// even though the primary rg path handled it correctly.
		const globHasDir = glob?.includes("/") ?? false;
		const globRe = glob ? globToFileRegExp(globHasDir && !glob.startsWith("**/") ? `**/${glob}` : glob) : undefined;
		// walkFiles assumes a directory (readdir); a searchPath that names a
		// single file made it `readdir` an ENOTDIR, get swallowed by the
		// catch-and-skip below, and silently return zero candidates — the rg
		// path above already special-cases this (searchPathIsDirectory), the
		// fallback needs the same.
		const searchPathIsFile = await stat(searchPath)
			.then((stats) => stats.isFile())
			.catch(() => false);
		let allFiles: string[];
		try {
			allFiles = searchPathIsFile ? [searchPath] : await walkFiles(cwd, searchPath, MAX_WALK_FILES, signal);
		} catch (error) {
			if (error instanceof SearchAbortedError) return abortedSearchResult();
			throw error;
		}
		const candidates = globRe
			? allFiles.filter((p) => globRe.test(globHasDir ? relative(searchPath, p) : basename(p)))
			: allFiles;

		// `limit` caps matches PER FILE here, same as rg's own `--max-count` —
		// the fallback used to treat it as a hard cap on the WHOLE search
		// instead (found via evals/lib/trace-view.ts: a real eval run silently
		// returned 100 of 238 matching lines this way, well before reaching
		// most of the matching files, and the model reasonably reported what
		// it was shown as the whole answer). `SAFETY_VALVE` is a much higher
		// ceiling that exists only to bound memory on a pathological total
		// match count — normal-sized "too many results" cases are truncated
		// (and correctly labeled with a real total) by the existing
		// `config.maxToolOutputLines` check below, same as the rg path.
		const SAFETY_VALVE = config.maxToolOutputLines * 4;
		const blocks: string[] = [];
		let safetyValveHit = false;
		outer: for (const absPath of candidates) {
			if (signal?.aborted) return abortedSearchResult();
			let stats: Awaited<ReturnType<typeof stat>>;
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sequential — each step depends on the previous
				stats = await stat(absPath);
			} catch (statErr) {
				if (isPermissionError(statErr)) permissionSkips++;
				continue;
			}
			if (stats.size > MAX_GREP_FILE_BYTES) continue;

			let fileText: string;
			try {
				fileText = await readFile(absPath, "utf-8");
			} catch (readErr) {
				if (isPermissionError(readErr)) permissionSkips++;
				continue;
			}

			const fileLines = fileText.split("\n");
			const relPath = relativeToCwd(absPath, cwd);

			let fileMatches = 0;
			for (let i = 0; i < fileLines.length; i++) {
				if (signal?.aborted) return abortedSearchResult();
				if (!patternRe.test(fileLines[i]!)) continue;
				const start = Math.max(0, i - context);
				const end = Math.min(fileLines.length, i + context + 1);
				blocks.push(
					fileLines
						.slice(start, end)
						.map((line, j) => `${relPath}:${start + j + 1}:${line}`)
						.join("\n"),
				);
				fileMatches++;
				if (blocks.length >= SAFETY_VALVE) {
					safetyValveHit = true;
					break outer;
				}
				if (fileMatches >= limit) break; // this file's own cap — move on to the next file
			}
		}

		output = withAccessNote(blocks.join("\n"), rgStderr, permissionSkips);
		if (safetyValveHit) {
			output = `[note: rg unavailable or failed, used a slower fallback search — stopped after ${SAFETY_VALVE} total match(es) to bound memory use. Narrow the pattern/glob/path for a complete result.]\n${output}`;
		}
	}

	const lines = output.trim().split("\n");
	if (lines.length > config.maxToolOutputLines) {
		const kept = lines.slice(0, config.maxToolOutputLines);
		return {
			content: `[Showing first ${config.maxToolOutputLines} of ${lines.length} lines]\n${kept.join("\n")}`,
		};
	}

	return { content: output.trim() || "No matches found" };
}

export async function execLs(args: Record<string, unknown>, cwd: string, _config: AppConfig): Promise<ToolResult> {
	if (args.path !== undefined && (typeof args.path !== "string" || !args.path.trim())) {
		return {
			content: 'Error: "path" must be a non-empty directory path when provided. Retry with a valid directory.',
			isError: true,
		};
	}
	if (
		args.limit !== undefined &&
		(typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)
	) {
		return { content: 'Error: "limit" must be a positive integer. Retry with limit: 1 or greater.', isError: true };
	}
	const dirPath = typeof args.path === "string" ? resolvePath(args.path, cwd) : cwd;
	const limit = typeof args.limit === "number" ? args.limit : 500;

	let entries: Dirent[];
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch (err) {
		const code = (err as { code?: string })?.code;
		if (code === "ENOENT") return { content: `Directory not found: ${dirPath}`, isError: true };
		if (code === "ENOTDIR") return { content: `Not a directory: ${dirPath}`, isError: true };
		throw err;
	}
	const lines: string[] = [];

	for (const entry of entries.slice(0, limit)) {
		// entry.isDirectory() reflects the dirent itself: a symlink pointing
		// at a directory reports false here (it's a symlink, not a
		// directory), which used to print it as a "file" with the target
		// directory's meaningless inode "size" and no trailing slash. Follow
		// the symlink with stat to classify it by what it actually points to,
		// same as walkFiles does for glob/grep's fallback tree walk.
		let isDir = entry.isDirectory();
		const statTarget = join(dirPath, entry.name);
		if (entry.isSymbolicLink()) {
			try {
				// biome-ignore lint/performance/noAwaitInLoops: sequential — each step depends on the previous
				const target = await stat(statTarget);
				isDir = target.isDirectory();
			} catch {
				// Broken symlink — keep the dirent's own (non-directory) type.
			}
		}
		const prefix = isDir ? "d" : "f";
		let size = "";
		if (!isDir) {
			try {
				const s = await stat(statTarget);
				size = formatSize(s.size);
			} catch {
				size = "?";
			}
		}
		lines.push(`${prefix}  ${size.padStart(8)}  ${entry.name}${isDir ? "/" : ""}`);
	}

	if (entries.length > limit) {
		lines.push(`\n... (${entries.length - limit} more entries, ${entries.length} total)`);
	}

	return { content: lines.join("\n") || "(empty directory)" };
}
