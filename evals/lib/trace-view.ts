/**
 * Post-hoc trace viewer — reads a recorded run/compare file from
 * evals/results/runs/ (written by recordRun/recordCompare/recordCompareRepeated
 * in results.ts, which now include each case's full `trace: TraceTurn[]`) and
 * prints one case's turn-by-turn record: what the model was thinking, what it
 * said, what tools it called with what args, and what each tool actually
 * returned. This is the troubleshooting counterpart to the pass/fail table —
 * a failing case's summary tells you THAT it failed, this tells you WHY.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");
const RUNS_DIR = join(RESULTS_DIR, "runs");
const INDEX_PATH = join(RESULTS_DIR, "index.json");

interface RawTraceToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result: { content: string; isError?: boolean };
}

interface RawTraceTurn {
	turn: number;
	thinking: string;
	commentary: string;
	toolCalls: RawTraceToolCall[];
}

interface RawCase {
	id: string;
	passed: boolean;
	duration: number;
	turns: number;
	failedChecks: string[];
	trace?: RawTraceTurn[];
	attempts?: Array<{
		passed: boolean;
		duration: number;
		turns: number;
		failedChecks: string[];
		trace?: RawTraceTurn[];
	}>;
}

interface CaseAttempt {
	model: string;
	attemptIndex: number;
	attemptTotal: number;
	passed: boolean;
	duration: number;
	turns: number;
	failedChecks: string[];
	trace: RawTraceTurn[];
}

/** Resolves "latest", a bare filename under runs/, or an absolute/relative path to an actual file path. */
export function resolveRunFile(arg: string): string {
	if (arg === "latest") {
		if (!existsSync(INDEX_PATH)) {
			throw new Error("No recorded runs yet — evals/results/index.json is empty or missing.");
		}
		const entries = JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as Array<{ file: string }>;
		const last = entries.at(-1);
		if (!last) throw new Error("evals/results/index.json has no entries.");
		return join(RESULTS_DIR, last.file);
	}
	if (isAbsolute(arg) && existsSync(arg)) return arg;
	if (existsSync(arg)) return arg;
	const underRuns = join(RUNS_DIR, arg);
	if (existsSync(underRuns)) return underRuns;
	throw new Error(`Can't find a run file for "${arg}" (tried as-is and under evals/results/runs/).`);
}

/** Every case id present in a run/compare file, for listing when --case is missing or wrong. */
export function listCaseIds(filePath: string): string[] {
	const data = JSON.parse(readFileSync(filePath, "utf-8"));
	const ids = new Set<string>();
	if (data.kind === "run") {
		for (const c of data.cases as RawCase[]) ids.add(c.id);
	} else if (data.kind === "compare") {
		for (const suite of Object.values(data.perModel) as Array<{ cases: RawCase[] }>) {
			for (const c of suite.cases) ids.add(c.id);
		}
	}
	return [...ids];
}

function extractAttempts(filePath: string, caseId: string, modelFilter?: string): CaseAttempt[] {
	const data = JSON.parse(readFileSync(filePath, "utf-8"));
	const attempts: CaseAttempt[] = [];

	if (data.kind === "run") {
		const c = (data.cases as RawCase[]).find((c) => c.id === caseId);
		if (c) {
			attempts.push({
				model: data.model,
				attemptIndex: 1,
				attemptTotal: 1,
				passed: c.passed,
				duration: c.duration,
				turns: c.turns,
				failedChecks: c.failedChecks,
				trace: c.trace ?? [],
			});
		}
		return attempts;
	}

	if (data.kind === "compare") {
		for (const [model, suite] of Object.entries(data.perModel) as Array<[string, { cases: RawCase[] }]>) {
			if (modelFilter && model !== modelFilter) continue;
			const c = suite.cases.find((c) => c.id === caseId);
			if (!c) continue;
			if (c.attempts) {
				c.attempts.forEach((a, i) => {
					attempts.push({
						model,
						attemptIndex: i + 1,
						attemptTotal: c.attempts!.length,
						passed: a.passed,
						duration: a.duration,
						turns: a.turns,
						failedChecks: a.failedChecks,
						trace: a.trace ?? [],
					});
				});
			} else {
				attempts.push({
					model,
					attemptIndex: 1,
					attemptTotal: 1,
					passed: c.passed,
					duration: c.duration,
					turns: c.turns,
					failedChecks: c.failedChecks,
					trace: c.trace ?? [],
				});
			}
		}
	}

	return attempts;
}

/** Truncates for terminal display only — the underlying JSON file keeps the full text. */
function forDisplay(text: string, limit = 2000): string {
	if (!text) return "(none)";
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n        … [${text.length - limit} more chars — see the JSON file for the full text]`;
}

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

export function printTrace(filePath: string, caseId: string, modelFilter?: string): void {
	const attempts = extractAttempts(filePath, caseId, modelFilter);
	if (attempts.length === 0) {
		const available = listCaseIds(filePath);
		console.error(`No case "${caseId}" found in ${filePath}${modelFilter ? ` for model ${modelFilter}` : ""}.`);
		console.error(`Cases in this file: ${available.join(", ")}`);
		process.exit(1);
	}

	for (const attempt of attempts) {
		const status = attempt.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
		const attemptLabel = attempt.attemptTotal > 1 ? ` (attempt ${attempt.attemptIndex}/${attempt.attemptTotal})` : "";
		console.log(`\n${"=".repeat(70)}`);
		console.log(
			`${caseId} — ${attempt.model}${attemptLabel} — ${status} (${attempt.duration}ms, ${attempt.turns} turns)`,
		);
		console.log("=".repeat(70));

		if (attempt.failedChecks.length > 0) {
			console.log("\nFailed checks:");
			for (const check of attempt.failedChecks) console.log(`  \x1b[31m✗ ${check}\x1b[0m`);
		}

		if (attempt.trace.length === 0) {
			console.log("\n(no trace recorded for this attempt — likely from a run before trace capture was added)");
			continue;
		}

		for (const turn of attempt.trace) {
			console.log(`\n--- Turn ${turn.turn} ---`);
			if (turn.thinking) {
				console.log("  [thinking]");
				console.log(indent(forDisplay(turn.thinking), "    "));
			}
			if (turn.commentary) {
				console.log("  [commentary]");
				console.log(indent(forDisplay(turn.commentary), "    "));
			}
			for (const tc of turn.toolCalls) {
				const errFlag = tc.result.isError ? " \x1b[31m[ERROR]\x1b[0m" : "";
				console.log(`  [tool: ${tc.name}]${errFlag} args: ${JSON.stringify(tc.args)}`);
				console.log(indent(forDisplay(tc.result.content), "    -> "));
			}
		}
		console.log();
	}
}
