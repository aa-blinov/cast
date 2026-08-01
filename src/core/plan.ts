/**
 * Plan mode — restricted agent state for exploring and planning before implementation.
 *
 * The model can read files and produce a structured plan, but cannot execute code
 * or run shell commands. Plans are persisted as markdown files at
 * <project>/.cast/plans/<session-id>/<name>.md — one directory per session, so a session
 * can hold several named plans.
 *
 * Authoring the plan itself goes through the SAME `write`/`edit` tools the model
 * already uses for real code: no separate plan-write/plan-edit tool — the
 * plan-mode permission gate just carves out one path exception.
 * `checkPlanFileGate`/`finalizePlanFileWrite`/
 * `enforcePlanCapAfterEdit` below are that gate, called from tools.ts's
 * createToolExecutor around the ordinary execWrite/execEdit calls whenever
 * planState.enabled is true. This used to be two dedicated tools
 * (plan_write/plan_edit) with their own heading-based section editor; removed
 * because the model, already calibrated by write/edit's own "prefer edit over
 * write" description, kept reaching for a full plan_write rewrite instead of
 * plan_edit far more than it did for real files — reusing write/edit directly
 * gives it the same tool (and the same nudge) it already uses correctly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { TodoItem } from "./todo.ts";
import { invalidateCachedFile } from "./tools/hashline-cache.ts";
import type { ToolResult } from "./tools.ts";

// ============================================================================
// State
// ============================================================================

/** All plan tool names — used to disable them wherever plan mode can't apply
 * (headless runs, subagents). */
export const PLAN_TOOL_NAMES = ["plan_done"] as const;
export const QUESTION_TOOL_NAME = "question";

/**
 * Terminal (signal) tools: a successful call ends the turn. Their contract is
 * "call it, then wait for the user" — the UI opens a mode-transition dialog
 * once the run settles (App.tsx waits for status !== "running"). Enforced by
 * the loop rather than the model's goodwill: the model returning a slightly
 * reworded summary on every call used to keep the run alive forever, and the
 * doom-loop detector (keyed on exact args) couldn't catch the varying args.
 * Declared here so a new signal tool can't be added without deciding this.
 */
export const TERMINAL_TOOL_NAMES: readonly string[] = ["plan_done", QUESTION_TOOL_NAME];

/**
 * Mode policy as data: which tools the TUI hides for a given mode. Plan mode
 * blocks bash's writer surface (bash stays advertised — the executor gate
 * restricts it to the read-only allowlist) plus the build-only plan tools;
 * build mode blocks the plan-authoring signal tools. Kept next to
 * PLAN_TOOL_NAMES so a new plan tool can't be added without deciding its
 * mode here (a test enforces this).
 */
export function modeDisabledTools(planMode: boolean): readonly string[] {
	// write/edit/read are NOT in either list: they stay advertised (and
	// executable) in both modes. In plan mode write/edit are gated per-call to
	// the active plan file's path (checkPlanFileGate, called from tools.ts)
	// instead of being blanket hidden, and a read of that same path sets it
	// active (maybeActivatePlanOnRead) — no plan_read tool needed. The model
	// uses the exact same tools it already uses for real code, just pointed
	// at one file.
	return planMode ? ["ssh"] : ["plan_done"];
}

export interface PlanState {
	enabled: boolean;
	/** Directory holding this session's plans: <project>/.cast/plans/<session-id>/ */
	plansDir: string;
	/** Plan most recently written via write/edit (gated to plansDir) in this
	 * process. When unset (e.g. a resumed session), the newest file in
	 * plansDir is the active plan. */
	activePlanPath?: string;
	/** Pending UI decisions are session metadata, persisted by the caller's
	 * callback rather than hidden files beside the user-authored plan. */
	planQuestion?: PlanQuestion;
	planTransition?: PlanTransition;
	onPendingStateChange?: (question: PlanQuestion | undefined, transition: PlanTransition | undefined) => void;
}

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface QuestionItem {
	question: string;
	options: QuestionOption[];
	recommended?: string;
}

export interface PlanQuestion {
	questions: QuestionItem[];
}

export interface PlanTransition {
	kind: "done";
}

export function createPlanState(
	cwd: string,
	sessionId: string,
	pending?: {
		question?: PlanQuestion;
		transition?: PlanTransition;
		onChange?: (question: PlanQuestion | undefined, transition: PlanTransition | undefined) => void;
	},
): PlanState {
	// Path only — the directory is created lazily on first write, so merely
	// constructing the state (every App render) touches nothing on disk.
	return {
		enabled: false,
		plansDir: join(cwd, ".cast", "plans", sessionId),
		planQuestion: pending?.question,
		planTransition: pending?.transition,
		onPendingStateChange: pending?.onChange,
	};
}

/** Reduce a model-supplied plan name to a safe kebab-case filename stem.
 * Everything outside [a-z0-9] collapses to "-", which also neutralizes path
 * traversal attempts ("../evil" → "evil"). */
export function slugifyPlanName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

// ============================================================================
// Read-only bash gate (plan mode)
// ============================================================================

/** Binaries that only inspect state. Deliberately excludes test runners and
 * package managers (`npm test` runs an arbitrary package.json script), editors
 * (`sed -i`), and anything that can spawn other commands (`xargs`, `awk`). */
const READONLY_BINARIES = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"wc",
	"grep",
	"rg",
	"fd",
	"find",
	"file",
	"stat",
	"du",
	"df",
	"tree",
	"diff",
	"sort",
	"uniq",
	"cut",
	"nl",
	"realpath",
	"dirname",
	"basename",
	"which",
	"pwd",
	"echo",
	"printf",
	"date",
	"column",
	"strings",
	"jq",
	"yq",
]);

/** Flags that turn an otherwise read-only binary into a writer or executor.
 * `--output`/`--output=` is checked globally (git log, sort, tree all have
 * output flags); these are the per-binary extras. */
const FORBIDDEN_FLAGS: Record<string, RegExp> = {
	find: /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/,
	fd: /^(-x|-X|--exec|--exec-batch)$/,
	sort: /^(-o|--output)$/,
	tree: /^-o$/,
};

/** Git subcommands that cannot mutate the repository. `branch`/`tag`/`remote`
 * are excluded on purpose — without arguments they list, with arguments they
 * create; `status`/`log` cover the listing use cases. */
const READONLY_GIT_SUBCOMMANDS = new Set([
	"log",
	"show",
	"diff",
	"status",
	"blame",
	"rev-parse",
	"ls-files",
	"ls-tree",
	"ls-remote",
	"shortlog",
	"describe",
	"grep",
	"reflog",
	"cat-file",
	"count-objects",
]);

/**
 * Conservative read-only check for a bash command in plan mode. Allows plain
 * pipelines of inspection binaries; rejects anything that can write: output
 * redirection, command substitution, or a pipeline stage whose binary is not
 * on the allowlist. False negatives (a safe command rejected) are acceptable;
 * false positives (a mutating command allowed) are not.
 */
// Fd-duplication (`2>&1`, `1>&2`) and redirecting to the null device
// (`2>/dev/null`, `&>/dev/null`) never write a persistent file — stripped
// before the blanket `>` check below so a plain `ls -la 2>&1` isn't rejected
// alongside a real `> realfile.txt`.
const SAFE_REDIRECTS = /\d*>&\d+\b|&?\d*>\s*\/dev\/null\b/g;

export function checkReadOnlyCommand(command: string): { ok: boolean; reason?: string } {
	// Stripped once, up front: the stage-splitter below treats a bare `&` as
	// a background-job separator, which would otherwise chop "2>&1" into
	// bogus stages "2>" and "1" and reject it for the wrong reason.
	const sanitized = command.replace(SAFE_REDIRECTS, "");
	if (/>/.test(sanitized)) {
		return { ok: false, reason: "output redirection (>) can write files" };
	}
	if (/\$\(|`|<\(/.test(command)) {
		return { ok: false, reason: "command/process substitution can run arbitrary commands" };
	}
	// Split into pipeline/sequence stages; every stage must be read-only.
	const stages = sanitized
		.split(/\|\||&&|;|\||\n|&/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (stages.length === 0) return { ok: false, reason: "empty command" };
	for (const stage of stages) {
		const tokens = stage.split(/\s+/);
		// Skip leading VAR=value assignments — they only affect the stage env.
		let i = 0;
		while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
		const binary = tokens[i]?.replace(/^.*\//, "");
		if (!binary) return { ok: false, reason: "empty pipeline stage" };
		const args = tokens.slice(i + 1);
		// Output flags write files without any `>` — git log --output, sort -o, …
		if (args.some((t) => t === "--output" || t.startsWith("--output="))) {
			return { ok: false, reason: "--output writes a file" };
		}
		if (binary === "git") {
			const sub = args.find((t) => !t.startsWith("-"));
			if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) {
				return { ok: false, reason: `git ${sub ?? "(none)"} is not a read-only subcommand` };
			}
			continue;
		}
		if (!READONLY_BINARIES.has(binary)) {
			return { ok: false, reason: `"${binary}" is not on the read-only allowlist` };
		}
		const forbidden = FORBIDDEN_FLAGS[binary];
		if (forbidden) {
			const hit = args.find((t) => forbidden.test(t));
			if (hit) return { ok: false, reason: `${binary} ${hit} can modify files or run commands` };
		}
		// `uniq input output` writes its second positional argument.
		if (binary === "uniq" && args.filter((t) => !t.startsWith("-")).length > 1) {
			return { ok: false, reason: "uniq with two file arguments writes the second one" };
		}
	}
	return { ok: true };
}

// ============================================================================
// Plan file I/O
// ============================================================================

function writeFileAtomic(filePath: string, data: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, data, "utf-8");
	renameSync(tmpPath, filePath);
}

export function readPlanFile(planFilePath: string): {
	exists: boolean;
	content: string;
	headings: string[];
	/** Set when the file exists but could not be read — distinct from "no plan
	 * yet" so callers don't tell the model to overwrite a plan they failed to read. */
	error?: string;
} {
	if (!existsSync(planFilePath)) {
		return { exists: false, content: "", headings: [] };
	}
	try {
		const content = readFileSync(planFilePath, "utf-8").trim();
		if (!content) return { exists: false, content: "", headings: [] };
		const headings = extractHeadings(content);
		return { exists: true, content, headings };
	} catch (err) {
		return {
			exists: false,
			content: "",
			headings: [],
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

function persistPendingState(planState: PlanState): void {
	planState.onPendingStateChange?.(planState.planQuestion, planState.planTransition);
}

/** Pending mode changes are session state, so they survive client reloads. */
export function readPlanTransition(planState: PlanState): PlanTransition | undefined {
	return planState.planTransition;
}

export function resolvePlanTransition(planState: PlanState): void {
	planState.planTransition = undefined;
	persistPendingState(planState);
}

/** The outstanding question is session state, so restarting the TUI cannot
 * bypass the plan_done gate before the user makes the decision. */
export function readPlanQuestion(planState: PlanState): PlanQuestion | undefined {
	return planState.planQuestion;
}

export function resolvePlanQuestion(planState: PlanState): void {
	planState.planQuestion = undefined;
	persistPendingState(planState);
}

/** All plan names (filename stems) in a session's plans directory, sorted. */
export function listPlanNames(plansDir: string): string[] {
	try {
		return readdirSync(plansDir)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -".md".length))
			.sort();
	} catch {
		return [];
	}
}

/** The plan write/edit/plan_done operate on: the one most
 * recently written/edited/read, or — after a resume, when that in-memory
 * marker is gone — the newest .md file in the session's plans directory. */
export function resolveActivePlanPath(planState: PlanState): string | undefined {
	if (planState.activePlanPath && existsSync(planState.activePlanPath)) return planState.activePlanPath;
	try {
		let newest: string | undefined;
		let newestMtime = -1;
		for (const entry of readdirSync(planState.plansDir)) {
			if (!entry.endsWith(".md")) continue;
			const path = join(planState.plansDir, entry);
			const mtime = statSync(path).mtimeMs;
			if (mtime > newestMtime) {
				newestMtime = mtime;
				newest = path;
			}
		}
		return newest;
	} catch {
		return undefined;
	}
}

export function readActivePlan(planState: PlanState): ReturnType<typeof readPlanFile> & { path?: string } {
	const path = resolveActivePlanPath(planState);
	if (!path) return { exists: false, content: "", headings: [] };
	return { ...readPlanFile(path), path };
}

function extractHeadings(content: string): string[] {
	return parseSections(content).map((s) => s.heading);
}

/** True for lines inside ```/~~~ code fences (fence markers included) — a
 * `- [ ]` or `# heading` inside a fenced example is content, not structure.
 * Shared by the section parser and both checklist scanners so they can't
 * drift apart on what counts as a fence. */
function fencedLineMask(lines: string[]): boolean[] {
	const mask: boolean[] = new Array(lines.length);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i]!)) {
			inFence = !inFence;
			mask[i] = true;
			continue;
		}
		mask[i] = inFence;
	}
	return mask;
}

/** Checklist progress of a plan: counts of unchecked and checked items.
 * Fence-aware — checkbox-like lines inside code blocks don't count. */
export function planChecklistState(content: string): { unchecked: number; checked: number } {
	const lines = content.split("\n");
	const fenced = fencedLineMask(lines);
	let unchecked = 0;
	let checked = 0;
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i]) continue;
		if (/^\s*[-*]\s+\[ \]/.test(lines[i]!)) unchecked++;
		else if (/^\s*[-*]\s+\[x\]/i.test(lines[i]!)) checked++;
	}
	return { unchecked, checked };
}

/** Unchecked checklist item texts (checkbox marker stripped). Fence-aware. */
export function listUncheckedPlanSteps(content: string): string[] {
	const lines = content.split("\n");
	const fenced = fencedLineMask(lines);
	const steps: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i]) continue;
		const match = lines[i]!.match(/^\s*[-*]\s+\[ \]\s+(.*)$/);
		if (match) steps.push(match[1]!.trim());
	}
	return steps;
}

/**
 * Open work items for post-compact TODO reminder and the turn-end open-work
 * gate. Prefer `- [ ]` checkboxes — that's the plan-mode contract. When a plan
 * authors Steps as `### N. …` headings instead (common in real sessions), fall
 * back to those direct child headings under `## Steps` so remaining work is
 * still visible.
 */
export function listOpenPlanSteps(content: string): string[] {
	const unchecked = listUncheckedPlanSteps(content);
	if (unchecked.length > 0) return unchecked;
	return listHeadingStepsUnderSteps(content);
}

/** Projects the approved plan's open checklist into the build phase's live
 * todo state. The plan remains the specification; todos carry execution status. */
export function createPlanTodos(planState: PlanState): TodoItem[] {
	const plan = readActivePlan(planState);
	if (!plan.exists) return [];
	return listOpenPlanSteps(plan.content).map((step) => ({
		content: step,
		status: "pending",
		priority: "medium",
		planStep: step,
	}));
}

/** Direct child heading sections (one level below `## Steps`) of the Steps
 * section with the most children. Real plans sometimes emit a duplicate empty
 * `## Steps` above the real one (email-tool.md) — the section that actually
 * has children wins. */
function stepHeadingSections(content: string): Section[] {
	const sections = parseSections(content);
	const candidates = sections.filter(
		(s) => s.level === 2 && (s.heading.toLowerCase() === "steps" || s.heading.toLowerCase().startsWith("steps")),
	);
	let best: Section[] = [];
	for (const stepsSection of candidates) {
		const childLevel = stepsSection.level + 1;
		const steps = sections.filter(
			(s) =>
				s.startLine > stepsSection.startLine && s.startLine < stepsSection.bodyEndLine && s.level === childLevel,
		);
		if (steps.length > best.length) best = steps;
	}
	return best;
}

/** `###` (one level below `## Steps`) headings inside the Steps section. */
function listHeadingStepsUnderSteps(content: string): string[] {
	return stepHeadingSections(content).map((s) => s.heading);
}

/**
 * Auto-normalize Steps written as bare `###` headings by inserting a checkbox
 * line under each one that doesn't already carry one. Without this, a plan
 * authored one-heading-per-step (each step carrying its own spec — common in
 * real plans) would otherwise project differently from checklist-based plans.
 * Normalizing during authoring gives the build-mode todo projection one stable
 * source shape without changing the approved plan later.
 * Idempotent (skips headings that already have a checkbox) and fence-aware.
 */
function normalizeStepChecklist(content: string): string {
	const steps = stepHeadingSections(content);
	if (steps.length === 0) return content;

	const lines = content.split("\n");
	const fenced = fencedLineMask(lines);
	const insertions: Array<{ afterLine: number; text: string }> = [];
	for (const step of steps) {
		let hasCheckbox = false;
		for (let i = step.bodyStartLine; i < step.bodyEndLine; i++) {
			if (!fenced[i] && /^\s*[-*]\s+\[[ xX]\]/.test(lines[i]!)) {
				hasCheckbox = true;
				break;
			}
		}
		if (!hasCheckbox) insertions.push({ afterLine: step.startLine, text: `- [ ] ${step.heading}` });
	}
	if (insertions.length === 0) return content;

	// Back-to-front so earlier splices don't shift later insertion indices.
	for (const { afterLine, text } of insertions.sort((a, b) => b.afterLine - a.afterLine)) {
		lines.splice(afterLine + 1, 0, "", text);
	}
	return lines.join("\n");
}

// ============================================================================
// Plan section extraction (for plan_edit)
// ============================================================================

interface Section {
	heading: string;
	level: number;
	startLine: number;
	bodyStartLine: number;
	bodyEndLine: number;
}

function parseSections(content: string): Section[] {
	const lines = content.split("\n");
	const sections: Section[] = [];

	// Lines inside fenced code blocks are not headings — a `# comment` in a
	// bash snippet must not become a section boundary for plan_edit.
	const fenced = fencedLineMask(lines);
	for (let i = 0; i < lines.length; i++) {
		if (fenced[i]) continue;
		const match = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
		if (match) {
			const level = match[1]!.length;
			const heading = match[2]!.trim();
			sections.push({
				heading,
				level,
				startLine: i,
				bodyStartLine: i + 1,
				bodyEndLine: lines.length, // will be adjusted below
			});
		}
	}

	// Adjust end lines: each section ends where the next same-or-higher-level heading starts
	for (let i = 0; i < sections.length - 1; i++) {
		const current = sections[i]!;
		for (let j = i + 1; j < sections.length; j++) {
			if (sections[j]!.level <= current.level) {
				current.bodyEndLine = sections[j]!.startLine;
				break;
			}
		}
	}

	return sections;
}

// ============================================================================
// Tool executors
// ============================================================================

// ============================================================================
// write/edit gate for plan mode — replaces the old plan_write/plan_edit tools
// ============================================================================
//
// The model authors the plan file with the SAME write/edit tools it uses for
// real code; these three functions are the gate tools.ts's createToolExecutor
// applies around execWrite/execEdit whenever planState.enabled is true. See
// the file-level doc comment for why this replaced a dedicated tool pair.

/** True for a real .md file directly inside `plansDir` — no subdirectories,
 * no `..` traversal. The only paths write/edit may touch while plan mode is
 * active. dirname()/extname() on the resolved absolute path reject both
 * cheaply without needing a realpath syscall. */
export function isPlanFilePath(absolutePath: string, plansDir: string): boolean {
	return dirname(absolutePath) === plansDir && extname(absolutePath).toLowerCase() === ".md";
}

/**
 * Checked before every write/edit call while plan mode is active. Anything
 * outside the session's plans directory — real source files, configs, the
 * repo in general — is refused, same net effect as the old blanket
 * write/edit disablement, but scoped per-path instead of per-tool.
 */
export function checkPlanFileGate(
	absolutePath: string,
	planState: PlanState,
): { ok: true } | { ok: false; error: string } {
	if (isPlanFilePath(absolutePath, planState.plansDir)) return { ok: true };
	return {
		ok: false,
		error:
			`write/edit only reach the plan file while plan mode is active — "${absolutePath}" is outside ${planState.plansDir}. ` +
			`Use a path directly inside that directory ending in .md, e.g. ${join(planState.plansDir, "short-name.md")}.`,
	};
}

/**
 * Called after a successful write/edit to a plan-mode path: normalizes any
 * bare "###" step headings into "- [ ]" checkboxes so plan steps have one
 * consistent shape, and makes this the active plan for plan_done, same as maybeActivatePlanOnRead
 * does for a plain read of the file.
 */
export function finalizePlanFileWrite(absolutePath: string, planState: PlanState): void {
	let raw: string;
	try {
		raw = readFileSync(absolutePath, "utf-8");
	} catch {
		return; // Shouldn't happen right after a successful write/edit; nothing to normalize.
	}
	const normalized = normalizeStepChecklist(raw);
	if (normalized !== raw) {
		writeFileAtomic(absolutePath, normalized);
		invalidateCachedFile(absolutePath);
	}
	planState.activePlanPath = absolutePath;
}

/** Hard cap on a plan file's size. The plan rides in the system prompt of
 * every build-mode request — an unbounded plan inflates every request for the
 * rest of the session. ~32k chars ≈ 8k tokens is already a very large spec. */
export const MAX_PLAN_CHARS = 32_000;

/**
 * Enforces MAX_PLAN_CHARS after an edit to a plan file. `write` gets the hard
 * cap checked up front (the full new content is known before anything is
 * written); `edit` applies anchored deltas, so there's no way to reject an
 * over-budget change before it lands — instead, roll back to the pre-edit
 * snapshot and report the size, same net effect (the file never ends up over
 * cap) with the same message shape plan_edit used to give.
 */
export function enforcePlanCapAfterEdit(
	absolutePath: string,
	beforeContent: string,
): { ok: true } | { ok: false; error: string } {
	const after = readFileSync(absolutePath, "utf-8");
	if (after.length <= MAX_PLAN_CHARS) return { ok: true };
	writeFileAtomic(absolutePath, beforeContent);
	invalidateCachedFile(absolutePath);
	return {
		ok: false,
		error: `Error: this edit would grow the plan to ${after.length} chars — the limit is ${MAX_PLAN_CHARS}. Reverted — tighten the section instead of expanding it.`,
	};
}

/**
 * Called after a successful `read` of a path inside plansDir while plan mode
 * is active: makes it the active plan, the same way a write/edit to it would
 * (finalizePlanFileWrite). This is how the model switches between several
 * named plans without a dedicated plan_read tool — it can `ls`/`glob` the
 * plans directory (whose path is in the plan-mode system prompt block) to
 * discover other plans by name, then `read` one to make it active.
 *
 * Build-mode reads are NOT wired to this (see tools.ts's dispatcher): the
 * approved plan must keep steering implementation via the mirror block
 * regardless of what the model reads for reference — swapping it mid-build
 * would bypass the /build approval.
 */
export function maybeActivatePlanOnRead(absolutePath: string, planState: PlanState): void {
	if (planState.enabled && isPlanFilePath(absolutePath, planState.plansDir)) {
		planState.activePlanPath = absolutePath;
	}
}

export function execQuestion(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const rawQuestions = Array.isArray(args.questions) ? args.questions : [];
	const questions = rawQuestions.flatMap((raw): QuestionItem[] => {
		if (!raw || typeof raw !== "object") return [];
		const item = raw as Record<string, unknown>;
		const question = typeof item.question === "string" ? item.question.trim() : "";
		const rawOptions = Array.isArray(item.options) ? item.options : [];
		const options = rawOptions.flatMap((option): QuestionOption[] => {
			if (!option || typeof option !== "object") return [];
			const record = option as Record<string, unknown>;
			const value = typeof record.value === "string" ? record.value.trim() : "";
			const label = typeof record.label === "string" ? record.label.trim() : "";
			const description = typeof record.description === "string" ? record.description.trim() : "";
			if (!value || !label) return [];
			return [{ value, label, ...(description ? { description } : {}) }];
		});
		const recommended = typeof item.recommended === "string" ? item.recommended.trim() : undefined;
		if (
			!question ||
			options.length < 2 ||
			options.length > 4 ||
			new Set(options.map((option) => option.value)).size !== options.length ||
			(recommended && !options.some((option) => option.value === recommended))
		)
			return [];
		return [{ question, options, ...(recommended ? { recommended } : {}) }];
	});

	if (questions.length < 1 || questions.length > 4 || questions.length !== rawQuestions.length) {
		return { content: "Error: questions must contain 1–4 questions, each with 2–4 unique options.", isError: true };
	}

	const pending = readPlanQuestion(planState);
	if (pending) {
		return {
			content:
				"Error: A question is already awaiting the user's choices. Wait for their answer before asking another.",
			isError: true,
		};
	}

	planState.planQuestion = { questions };
	persistPendingState(planState);
	return {
		content: JSON.stringify({
			question: true,
			questions,
			note: "The user will choose in the picker. Your turn ends now; wait for their answer.",
		}),
	};
}

export function execPlanDone(args: Record<string, unknown>, planState: PlanState): ToolResult {
	const summary = typeof args.summary === "string" ? args.summary.trim() : "";
	const { exists, error, path } = readActivePlan(planState);

	if (error) {
		return { content: `Error reading plan file: ${error}`, isError: true };
	}
	if (!exists || !path) {
		return {
			content: "Error: No plan exists. Write a plan file first (write inside the plans directory).",
			isError: true,
		};
	}
	planState.planTransition = { kind: "done" };
	persistPendingState(planState);

	// Signal that the plan is ready for review. The plan file is already on
	// disk and the UI reads it itself (readActivePlan) to open the approval
	// dialog — so we deliberately do NOT echo `content` back into the model's
	// context: returning the full plan invited the model to keep "refining" it
	// instead of stopping. The turn ends here regardless (see loop.ts's
	// terminal-tool handling); the note states the contract for the model too.
	return {
		content: JSON.stringify({
			planReady: true,
			name: basename(path, ".md"),
			summary: summary || "Plan complete",
			path,
			note: "Plan is ready for review. Your turn ends now; the user will decide whether to approve or keep planning.",
		}),
	};
}
