/**
 * Deterministic half of code review.
 *
 * The model is good at judging code and bad at guaranteeing process: on a large
 * changeset it quietly reviews some files and not others, and which rules it
 * had in mind varies with the phrasing. So the parts that must not go wrong are
 * computed here — which files are in scope, how they are grouped into review
 * units, and which language rules apply — and only the judging is left to the
 * model.
 *
 * What this module does NOT do: talk to a model, or decide whether a finding is
 * real. It produces a brief.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import { promptsDir } from "./prompts.ts";

const execFileAsync = promisify(execFile);

/** Files above this many changed lines are reviewed on their own. */
const LARGE_FILE_LINES = 400;
/** Cap per review unit — a group the model can hold in one context. */
export const MAX_FILES_PER_GROUP = 8;
/** A diff longer than this is truncated in the brief; the reviewer reads the file. */
const MAX_DIFF_CHARS = 20_000;
const WHITESPACE_RE = /\s+/;
const TRAILING_SLASH_RE = /\/$/;
/**
 * Above this many files, a review is worth narrowing. Not a hard limit: a
 * 45-file change made no tool calls at all inside a ten-minute window in
 * testing, and a user is better served by being told that up front than by
 * watching a turn that may not finish.
 */
export const LARGE_REVIEW_FILES = 25;
/** Past this age an open review is treated as abandoned — see readReviewState. */
const REVIEW_STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How many filtered paths the brief names before it just counts the rest. */
const MAX_SKIPPED_LISTED = 20;
/** Above this, an untracked file is not read just to count its lines. */
const MAX_UNTRACKED_BYTES = 2_000_000;

export interface ReviewFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed";
	/** Changed lines (added + removed), from --numstat. */
	changedLines: number;
	/** Why it was left out, when it was. */
	skipped?: string;
}

export interface ReviewGroup {
	/** What the group is, for the reviewer: a directory, a sibling set, or one big file. */
	label: string;
	files: ReviewFile[];
}

export interface ReviewScope {
	files: ReviewFile[];
	skipped: ReviewFile[];
	groups: ReviewGroup[];
	/** Rule documents matched to the languages actually present. */
	rules: Array<{ name: string; body: string }>;
	/** What was compared, for the brief's first line. */
	range: string;
}

/**
 * Paths whose diff is noise in a review: generated, vendored, or machine-owned.
 * Deterministic, because "should I review the lockfile" is not a judgement call
 * worth a model's attention or a reviewer's trust.
 */
const SKIP_PATTERNS: Array<{ re: RegExp; why: string }> = [
	{
		re: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/,
		why: "lockfile",
	},
	{
		re: /(^|\/)(node_modules|\.venv|venv|dist|build|out|target|coverage)\//,
		why: "installed or generated directory",
	},
	// `vendor/` and `third_party/` are deliberately NOT here. Those hold code a
	// person checks in and then edits by hand, so a change inside one is a
	// change someone made on purpose. Skipping them cost two measured cases:
	// chalk's fix lives in source/vendor/supports-color/, and filtering it left
	// one review with nothing in scope at all.
	{ re: /\.(min\.js|min\.css|map|snap)$/, why: "generated artifact" },
	{ re: /\.(png|jpe?g|gif|ico|svg|pdf|zip|tar|gz|woff2?|ttf|eot|mp4|mp3|wasm)$/i, why: "binary or asset" },
	{ re: /(^|\/)(\.pnp\.cjs|\.yarn)\//, why: "package manager internals" },
	{ re: /\.pb\.go$|_pb2\.py$|\.g\.dart$|\.generated\.[a-z]+$/, why: "generated source" },
];

/** Extension → rule document. Only matched documents are loaded. */
const RULE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".sh": "shell",
	".bash": "shell",
	".zsh": "shell",
	".sql": "sql",
	".yml": "config",
	".yaml": "config",
	".json": "config",
	".toml": "config",
};

function skipReason(path: string): string | undefined {
	for (const { re, why } of SKIP_PATTERNS) if (re.test(path)) return why;
	return undefined;
}

/**
 * Suffixes that make two files one review unit.
 *
 * Only the test/implementation pair, because it is the one a directory bucket
 * does not already catch: `handler.ts` and `handler.test.ts` are commonly in
 * `src/` and `test/`, and a change that updates one without the other is
 * exactly what a reviewer needs both halves in hand to see.
 *
 * Locale suffixes (`message_en`, `message_ru`) were here first and bought
 * nothing: translations of one bundle sit in the same directory, so directory
 * grouping already puts them in one unit, and locales split across directories
 * would not be caught by a suffix key anyway.
 */
const SIBLING_SUFFIX_RE = /[._-](test|spec)$/i;

/** Strip the extension and a trailing variant suffix: `handler.test` → `handler`. */
function siblingKey(path: string): string {
	const stem = basename(path, extname(path));
	return `${dirname(path)}/${stem.replace(SIBLING_SUFFIX_RE, "")}`;
}

/**
 * Group the in-scope files into review units.
 *
 * Related files belong in one unit so their contradiction is visible — a
 * handler and its test, two translations of one message bundle. A file large
 * enough to fill a context on its own gets that context. Everything else falls
 * back to its directory, which is the cheapest correct proxy for "related".
 */
export function groupReviewFiles(files: ReviewFile[]): ReviewGroup[] {
	const groups: ReviewGroup[] = [];
	const remaining: ReviewFile[] = [];

	for (const file of files) {
		if (file.changedLines >= LARGE_FILE_LINES) groups.push({ label: `${file.path} (large change)`, files: [file] });
		else remaining.push(file);
	}

	// Siblings first: they are the tighter relation, and a directory bucket
	// would otherwise scatter them across group boundaries.
	const bySibling = new Map<string, ReviewFile[]>();
	for (const file of remaining) {
		const key = siblingKey(file.path);
		bySibling.set(key, [...(bySibling.get(key) ?? []), file]);
	}
	const leftovers: ReviewFile[] = [];
	for (const [key, siblings] of bySibling) {
		if (siblings.length > 1)
			groups.push({ label: `${key}* (related files)`, files: siblings.slice(0, MAX_FILES_PER_GROUP) });
		else leftovers.push(...siblings);
	}

	const byDir = new Map<string, ReviewFile[]>();
	for (const file of leftovers) {
		const dir = dirname(file.path);
		byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
	}
	for (const [dir, dirFiles] of byDir) {
		for (let i = 0; i < dirFiles.length; i += MAX_FILES_PER_GROUP) {
			const chunk = dirFiles.slice(i, i + MAX_FILES_PER_GROUP);
			const part = dirFiles.length > MAX_FILES_PER_GROUP ? ` (${i / MAX_FILES_PER_GROUP + 1})` : "";
			groups.push({ label: `${dir}/${part}`, files: chunk });
		}
	}
	return groups;
}

/** Load the rule documents for the languages present, plus the shared default. */
export function rulesForFiles(files: ReviewFile[]): Array<{ name: string; body: string }> {
	const names = new Set<string>(["default"]);
	for (const file of files) {
		const rule = RULE_BY_EXTENSION[extname(file.path).toLowerCase()];
		if (rule) names.add(rule);
	}
	const rules: Array<{ name: string; body: string }> = [];
	for (const name of names) {
		const path = join(promptsDir, "review-rules", `${name}.md`);
		if (!existsSync(path)) continue;
		try {
			rules.push({ name, body: readFileSync(path, "utf-8").trim() });
		} catch {
			// A missing or unreadable rule file narrows the review; it must not
			// take the review down with it.
		}
	}
	return rules;
}

/** Lines in an untracked file, or 0 when it can't be read (binary, gone, huge). */
function countLines(path: string): number {
	try {
		const { size } = statSync(path);
		if (size > MAX_UNTRACKED_BYTES) return 0;
		const text = readFileSync(path, "utf-8");
		return text.length === 0 ? 0 : text.split("\n").length;
	} catch {
		return 0;
	}
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
		return stdout;
	} catch (error) {
		// `git diff` exits 1 when files differ, which is not a failure.
		const err = error as { code?: number; stdout?: string };
		if (err.code === 1 && typeof err.stdout === "string") return err.stdout;
		throw error;
	}
}

const STATUS_BY_LETTER: Record<string, ReviewFile["status"]> = {
	A: "added",
	M: "modified",
	D: "deleted",
	R: "renamed",
};

/**
 * Collect the changed files for `range` (default: the working tree against
 * HEAD, staged and unstaged together, plus untracked files).
 */
export async function collectReviewFiles(
	cwd: string,
	range?: string,
): Promise<{ files: ReviewFile[]; skipped: ReviewFile[] }> {
	const numstatArgs = range ? ["diff", "--numstat", range] : ["diff", "--numstat", "HEAD"];
	const nameStatusArgs = range ? ["diff", "--name-status", range] : ["diff", "--name-status", "HEAD"];

	const [numstat, nameStatus, untracked] = await Promise.all([
		git(cwd, numstatArgs),
		git(cwd, nameStatusArgs),
		range ? Promise.resolve("") : git(cwd, ["ls-files", "--others", "--exclude-standard"]),
	]);

	const linesByPath = new Map<string, number>();
	for (const line of numstat.split("\n")) {
		const [added, removed, path] = line.split("\t");
		if (!path) continue;
		// A binary file reports "-" for both counts.
		const count = (Number(added) || 0) + (Number(removed) || 0);
		linesByPath.set(path.trim(), count);
	}

	const files: ReviewFile[] = [];
	for (const line of nameStatus.split("\n")) {
		const parts = line.split("\t");
		const letter = parts[0]?.[0];
		// A rename carries the new path last.
		const path = (parts.length > 2 ? parts[2] : parts[1])?.trim();
		if (!letter || !path) continue;
		files.push({ path, status: STATUS_BY_LETTER[letter] ?? "modified", changedLines: linesByPath.get(path) ?? 0 });
	}
	for (const path of untracked.split("\n")) {
		const trimmed = path.trim();
		if (!trimmed) continue;
		// numstat knows nothing about untracked files, so count the lines here:
		// otherwise every new file reports 0 changed lines and a 900-line one
		// never earns the review unit of its own that the size rule promises.
		files.push({ path: trimmed, status: "added", changedLines: countLines(join(cwd, trimmed)) });
	}

	const kept: ReviewFile[] = [];
	const skipped: ReviewFile[] = [];
	for (const file of files) {
		const why = skipReason(file.path);
		if (why) skipped.push({ ...file, skipped: why });
		else kept.push(file);
	}
	kept.sort((a, b) => a.path.localeCompare(b.path));
	return { files: kept, skipped };
}

/**
 * Parse `/code-review [range] [-- path...]`.
 *
 * The paths matter for the case the first field runs into: a 45-file change
 * where the review is worth doing on one subtree at a time. Without them the
 * only way to narrow is a git range, which is the wrong axis.
 */
export function parseReviewArgs(input: string): { range?: string; paths: string[] } {
	const trimmed = input.trim();
	if (!trimmed) return { paths: [] };
	const separator = trimmed.indexOf("--");
	if (separator === -1) return { range: trimmed, paths: [] };
	const range = trimmed.slice(0, separator).trim();
	const paths = trimmed
		.slice(separator + 2)
		.split(WHITESPACE_RE)
		.map((path) => path.trim())
		.filter(Boolean);
	return { range: range || undefined, paths };
}

/** Everything the review needs, computed without asking a model anything. */
export async function buildReviewScope(cwd: string, range?: string, paths: string[] = []): Promise<ReviewScope> {
	const collected = await collectReviewFiles(cwd, range);
	// Narrowing drops files from the scope rather than filtering them: a path
	// the user excluded is not "skipped as generated", it was never asked for.
	const within = (path: string) =>
		paths.length === 0 || paths.some((p) => path === p || path.startsWith(`${p.replace(TRAILING_SLASH_RE, "")}/`));
	const files = collected.files.filter((file) => within(file.path));
	const skipped = collected.skipped.filter((file) => within(file.path));
	return {
		files,
		skipped,
		groups: groupReviewFiles(files),
		rules: rulesForFiles(files),
		range: `${range ?? "working tree vs HEAD"}${paths.length > 0 ? ` (limited to ${paths.join(", ")})` : ""}`,
	};
}

/**
 * Render the brief the model receives. The scope is stated as fact — this is
 * the list, these are the groups, these are the rules — rather than left for
 * the model to rediscover and quietly shorten.
 */
export function formatReviewBrief(scope: ReviewScope, options?: { delegate?: boolean }): string {
	if (scope.files.length === 0) {
		return `No reviewable changes in ${scope.range}.${scope.skipped.length > 0 ? ` (${scope.skipped.length} file(s) filtered as generated or vendored.)` : ""}`;
	}

	const lines: string[] = [
		`Review the changes in ${scope.range}. The scope below was computed, not guessed: review every group, and do not add files to it.`,
		"",
		`## Scope — ${scope.files.length} file(s) in ${scope.groups.length} group(s)`,
		"",
	];
	for (const group of scope.groups) {
		lines.push(`### ${group.label}`);
		for (const file of group.files) lines.push(`- ${file.path} (${file.status}, ${file.changedLines} changed lines)`);
		lines.push("");
	}
	if (scope.skipped.length > 0) {
		// Named, but bounded: a vendored-heavy change can filter hundreds of
		// paths, and listing them all would cost more of the brief than the
		// files actually under review.
		const shown = scope.skipped.slice(0, MAX_SKIPPED_LISTED).map((f) => f.path);
		const rest = scope.skipped.length - shown.length;
		lines.push(
			`Filtered out as generated, vendored, or binary — do not review these: ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`,
			"",
		);
	}

	lines.push(
		"## How to work",
		"",
		options?.delegate
			? '- One `task` per group, in parallel, each with `subagent: "review"` and the group\'s file list in the assignment. A group is a review unit: its files are related, so judge them together. Then merge the reports yourself and drop duplicates.'
			: "- Take the groups one at a time. A group is a review unit: its files are related, so judge them together.",
		"- Read the diff for a file before judging it (`git diff -- <path>`), and read the surrounding code when the change's effect depends on it.",
		"- Report through `review_report`, once, with every finding: `path`, `line` after the change, `quote` (the line's exact text) and `issue` (the concrete failure). The quote is what makes the position checkable — every finding is checked against the file, a wrong line is moved to where the quoted code actually is, and a finding whose code isn't there is dropped.",
		"- Then write the summary from the verdicts the tool returns, at the positions it gives. Nothing you were told was dropped goes in the summary.",
		"",
	);

	for (const rule of scope.rules) lines.push(rule.body, "");
	return lines.join("\n").trimEnd();
}

/** Truncate a diff for inclusion in a prompt, saying so when it is cut. */
export function clampDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_CHARS) return diff;
	return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated at ${MAX_DIFF_CHARS} characters — read the file directly for the rest]`;
}

// ============================================================================
// Finding positions — checked against the files, not trusted
// ============================================================================

/** One changed range on the new side of a diff, inclusive. */
export interface ChangedRange {
	start: number;
	end: number;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** New-side changed line ranges per file, from a zero-context diff. */
export async function changedRanges(cwd: string, path: string, range?: string): Promise<ChangedRange[]> {
	const args = range ? ["diff", "-U0", range, "--", path] : ["diff", "-U0", "HEAD", "--", path];
	let diff: string;
	try {
		diff = await git(cwd, args);
	} catch {
		return [];
	}
	const ranges: ChangedRange[] = [];
	for (const line of diff.split("\n")) {
		const match = HUNK_RE.exec(line);
		if (!match) continue;
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		// A pure deletion reports count 0 at the line it was removed from.
		ranges.push({ start, end: count === 0 ? start : start + count - 1 });
	}
	return ranges;
}

export interface Finding {
	path: string;
	line: number;
	/** The line as the reporter saw it — what makes the position checkable. */
	quote?: string;
	issue: string;
}

export type FindingVerdict =
	| { status: "ok"; finding: Finding }
	| { status: "relocated"; finding: Finding; from: number; note: string }
	| { status: "dropped"; finding: Finding; note: string }
	| { status: "unchanged-line"; finding: Finding; note: string };

/** Collapse whitespace so an indentation-only difference is not a mismatch. */
function normalize(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Check every finding's position against the file on disk, and move or drop the
 * ones that don't hold.
 *
 * A reported line is the reader's entry point: if it is off by six lines, or
 * names a file that isn't in the change, the finding costs more than it earns
 * even when the observation behind it is right. The reporter's own quote is
 * what makes this checkable — so the quote is the contract, and a finding
 * without one can only be range-checked.
 */
export function verifyFindings(
	cwd: string,
	findings: Finding[],
	scope: { files: ReviewFile[] },
	rangesByPath?: Map<string, ChangedRange[]>,
): FindingVerdict[] {
	const inScope = new Set(scope.files.map((f) => f.path));
	const verdicts: FindingVerdict[] = [];

	for (const finding of findings) {
		if (!inScope.has(finding.path)) {
			verdicts.push({
				status: "dropped",
				finding,
				note: `${finding.path} is not in the review scope — the finding cannot be placed.`,
			});
			continue;
		}

		let lines: string[];
		try {
			lines = readFileSync(join(cwd, finding.path), "utf-8").split("\n");
		} catch {
			verdicts.push({ status: "dropped", finding, note: `${finding.path} could not be read.` });
			continue;
		}

		const quote = finding.quote ? normalize(finding.quote) : "";
		const claimed = lines[finding.line - 1];
		const claimedMatches = quote !== "" && claimed !== undefined && normalize(claimed).includes(quote);

		if (quote === "") {
			// Nothing to match on, so all that can be checked is that the line exists.
			if (finding.line < 1 || finding.line > lines.length) {
				verdicts.push({
					status: "dropped",
					finding,
					note: `${finding.path} has ${lines.length} lines; line ${finding.line} does not exist, and the finding quotes nothing to relocate by.`,
				});
				continue;
			}
			verdicts.push({ status: "ok", finding });
			continue;
		}

		if (!claimedMatches) {
			// Relocate by the quote: the nearest line that actually contains it.
			const candidates = lines
				.map((text, index) => ({ line: index + 1, text }))
				.filter((candidate) => normalize(candidate.text).includes(quote));
			if (candidates.length === 0) {
				verdicts.push({
					status: "dropped",
					finding,
					note: `the quoted code is not in ${finding.path} at all — neither at line ${finding.line} nor anywhere else in the file.`,
				});
				continue;
			}
			const nearest = candidates.reduce((best, candidate) =>
				Math.abs(candidate.line - finding.line) < Math.abs(best.line - finding.line) ? candidate : best,
			);
			verdicts.push({
				status: "relocated",
				finding: { ...finding, line: nearest.line },
				from: finding.line,
				note: `moved from line ${finding.line} to ${nearest.line}, where the quoted code actually is.`,
			});
			continue;
		}

		const ranges = rangesByPath?.get(finding.path);
		if (ranges && ranges.length > 0 && !ranges.some((r) => finding.line >= r.start && finding.line <= r.end)) {
			// Not a drop: a finding about a caller the change breaks is exactly
			// the kind worth having. It is flagged so the reader knows it is
			// about surrounding code rather than the diff.
			verdicts.push({
				status: "unchanged-line",
				finding,
				note: `line ${finding.line} is not part of this change — say how the change makes it wrong.`,
			});
			continue;
		}

		verdicts.push({ status: "ok", finding });
	}
	return verdicts;
}

/** Render the verdicts back to the reporter: what stands, what moved, what went. */
export function formatFindingVerdicts(verdicts: FindingVerdict[]): string {
	const kept = verdicts.filter((v) => v.status === "ok" || v.status === "relocated" || v.status === "unchanged-line");
	const dropped = verdicts.filter((v) => v.status === "dropped");
	const lines: string[] = [
		`Checked ${verdicts.length} finding(s) against the files: ${kept.length} stand, ${dropped.length} dropped.`,
		"",
	];
	for (const verdict of verdicts) {
		const where = `${verdict.finding.path}:${verdict.finding.line}`;
		if (verdict.status === "ok") lines.push(`- ok — ${where}`);
		else if (verdict.status === "relocated") lines.push(`- relocated — ${where}: ${verdict.note}`);
		else if (verdict.status === "unchanged-line") lines.push(`- outside the change — ${where}: ${verdict.note}`);
		else lines.push(`- dropped — ${verdict.finding.path}:${verdict.finding.line}: ${verdict.note}`);
	}
	lines.push(
		"",
		"Report only the findings above that stand, at the positions given here — a relocated line is the correct one. Do not restate a dropped finding.",
	);
	return lines.join("\n");
}

// ============================================================================
// Per-session review state — what the position check verifies against
// ============================================================================

export interface ReviewState {
	cwd: string;
	range: string;
	/** Paths in scope, so a finding outside the change can be rejected. */
	files: string[];
	/** New-side changed ranges per path, so a finding can be told from its context. */
	ranges: Record<string, ChangedRange[]>;
	startedAt: string;
}

function reviewStatePath(sessionId: string): string {
	return join(homedir(), ".cast", "reviews", `${sessionId}.json`);
}

/** Read this session's review state, or undefined when no review is open. */
export function readReviewState(sessionId: string): ReviewState | undefined {
	const path = reviewStatePath(sessionId);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReviewState>;
		if (typeof parsed.cwd !== "string" || !Array.isArray(parsed.files)) return undefined;
		// A crash between opening a review and finishing it leaves this file
		// behind, and a stale scope is worse than none: it offers the tool in
		// unrelated later turns and checks findings against a diff that has
		// moved on. Every ordinary ending — reported, abandoned, aborted —
		// clears it, so age is only the backstop for the one that doesn't.
		const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString();
		if (Date.now() - new Date(startedAt).getTime() > REVIEW_STATE_MAX_AGE_MS) return undefined;
		return {
			cwd: parsed.cwd,
			range: typeof parsed.range === "string" ? parsed.range : "unknown range",
			files: parsed.files.filter((f): f is string => typeof f === "string"),
			ranges: (parsed.ranges as Record<string, ChangedRange[]>) ?? {},
			startedAt,
		};
	} catch {
		return undefined;
	}
}

/**
 * Open a review for this session: the scope the position check will hold
 * findings against. Collecting the changed ranges here, once, is what lets the
 * check tell "this line is in the diff" from "this line is context".
 */
export async function startReviewState(sessionId: string, cwd: string, scope: ReviewScope): Promise<ReviewState> {
	const ranges: Record<string, ChangedRange[]> = {};
	const rangeArg = scope.range === "working tree vs HEAD" ? undefined : scope.range;
	await Promise.all(
		scope.files.map(async (file) => {
			ranges[file.path] = await changedRanges(cwd, file.path, rangeArg);
		}),
	);
	const state: ReviewState = {
		cwd,
		range: scope.range,
		files: scope.files.map((f) => f.path),
		ranges,
		startedAt: new Date().toISOString(),
	};
	const path = reviewStatePath(sessionId);
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
	renameSync(temporary, path);
	return state;
}

/** Close the review for this session. */
export function clearReviewState(sessionId: string): void {
	rmSync(reviewStatePath(sessionId), { force: true });
}

/** Verify findings against an open review's state. */
export function verifyFindingsForSession(sessionId: string, findings: Finding[]): FindingVerdict[] | undefined {
	const state = readReviewState(sessionId);
	if (!state) return undefined;
	return verifyFindings(
		state.cwd,
		findings,
		{ files: state.files.map((path) => ({ path, status: "modified" as const, changedLines: 0 })) },
		new Map(Object.entries(state.ranges)),
	);
}

/** Parse the tool's `findings` argument, keeping only well-formed entries. */
export function parseFindings(raw: unknown): Finding[] {
	if (!Array.isArray(raw)) return [];
	const findings: Finding[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as Record<string, unknown>;
		const path = typeof candidate.path === "string" ? candidate.path : undefined;
		const line = typeof candidate.line === "number" ? Math.trunc(candidate.line) : undefined;
		const issue = typeof candidate.issue === "string" ? candidate.issue : undefined;
		if (!path || !line || !issue) continue;
		findings.push({ path, line, issue, quote: typeof candidate.quote === "string" ? candidate.quote : undefined });
	}
	return findings;
}

/**
 * Injected where a turn with an open review would otherwise end without the
 * findings having been through the position check.
 *
 * Measured on nine public pull requests: the tool was called in five. The other
 * four reviewed the diff properly and wrote their conclusion as prose, which
 * means no line was ever checked against a file — the whole point of the check.
 * Asking once, at the moment it matters, is cheaper than asking harder in the
 * brief.
 */
export const REVIEW_REPORT_REMINDER = `This review hasn't gone through \`review_report\` yet, so nothing you found has been checked against the files.

Call it now with every finding — \`path\`, \`line\`, \`quote\` (the line's exact text) and \`issue\`. Found nothing? Call it with an empty \`findings\` array; that is the answer, and it still closes the review properly. Then write your summary from what the tool returns.`;
