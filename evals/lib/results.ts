/**
 * Meaningful, non-overwriting result storage for eval runs.
 *
 * Before this, every run overwrote the same `evals/results/latest.json` —
 * fine for "did the suite pass right now", useless for "how has this eval
 * trended" or "what did the mimo-v2.5 vs mimo-v2.5-pro compare on
 * <date> actually show". Every run now gets its own timestamped file under
 * `evals/results/runs/`, and `evals/results/index.json` is a flat,
 * append-only log of one-line-summary entries pointing at each — so you can
 * scan history without opening every run file, and diff two entries to see
 * what changed (model, case set, pass rate) between them.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompareResult, RepeatedCompareResult, SuiteResult } from "./runner.ts";

const RESULTS_DIR = join(import.meta.dirname, "..", "results");
const RUNS_DIR = join(RESULTS_DIR, "runs");
const INDEX_PATH = join(RESULTS_DIR, "index.json");

export interface IndexEntry {
	timestamp: string;
	kind: "run" | "compare";
	/** Single model for a "run", every model compared for a "compare". */
	models: string[];
	/** Case ids included, or a case-filter prefix if one was used. */
	caseFilter?: string;
	total: number;
	passed: number;
	failed: number;
	/** Short commit hash at record time, if this is a git checkout — lets a
	 * regression get traced back to what the harness looked like. */
	commit?: string;
	/** Path to the full result file, relative to evals/results/. */
	file: string;
	/** Attempts per case — omitted/1 for a plain single-attempt run. */
	repeat?: number;
	/** Cases where attempts disagreed (some passed, some didn't) — a repeat>1 signal only. */
	inconsistentCases?: number;
}

function currentCommit(): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
			encoding: "utf-8",
			cwd: import.meta.dirname,
		}).trim();
	} catch {
		return undefined; // not a git checkout, or git unavailable — fine, just omit it
	}
}

function slugify(parts: string[]): string {
	return parts
		.join("_")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.slice(0, 80);
}

function readIndex(): IndexEntry[] {
	if (!existsSync(INDEX_PATH)) return [];
	try {
		return JSON.parse(readFileSync(INDEX_PATH, "utf-8")) as IndexEntry[];
	} catch {
		return []; // corrupt/empty — start fresh rather than crash a run over stale bookkeeping
	}
}

function appendIndex(entry: IndexEntry): void {
	const entries = readIndex();
	entries.push(entry);
	writeFileSync(INDEX_PATH, JSON.stringify(entries, null, 2), "utf-8");
}

function ensureDirs(): void {
	if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Record a single-model suite run. Returns the path the full result was written to. */
export function recordRun(suite: SuiteResult, caseFilter?: string): string {
	ensureDirs();
	const timestamp = new Date().toISOString();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_run_${slugify([suite.model])}.json`;
	const filePath = join(RUNS_DIR, fileName);

	writeFileSync(
		filePath,
		JSON.stringify(
			{
				timestamp,
				kind: "run",
				model: suite.model,
				caseFilter,
				commit: currentCommit(),
				total: suite.total,
				passed: suite.passed,
				failed: suite.failed,
				duration: suite.duration,
				cases: suite.results.map((r) => ({
					id: r.caseId,
					description: r.description,
					passed: r.passed,
					duration: r.duration,
					turns: r.turns,
					toolsCalled: r.toolsCalled,
					failedChecks: r.failedChecks,
					errors: r.errors,
					responsePreview: r.response.slice(0, 500),
					trace: r.trace,
				})),
			},
			null,
			2,
		),
		"utf-8",
	);

	appendIndex({
		timestamp,
		kind: "run",
		models: [suite.model],
		caseFilter,
		total: suite.total,
		passed: suite.passed,
		failed: suite.failed,
		commit: currentCommit(),
		file: join("runs", fileName),
	});

	return filePath;
}

/** Record a multi-model compare run. Returns the path the full result was written to. */
export function recordCompare(compare: CompareResult, caseFilter?: string): string {
	ensureDirs();
	const timestamp = new Date().toISOString();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_compare_${slugify(compare.models)}.json`;
	const filePath = join(RUNS_DIR, fileName);

	const totals = Object.values(compare.suites).reduce(
		(acc, s) => ({ total: acc.total + s.total, passed: acc.passed + s.passed, failed: acc.failed + s.failed }),
		{ total: 0, passed: 0, failed: 0 },
	);

	writeFileSync(
		filePath,
		JSON.stringify(
			{
				timestamp,
				kind: "compare",
				models: compare.models,
				caseFilter,
				commit: currentCommit(),
				perModel: Object.fromEntries(
					Object.entries(compare.suites).map(([model, s]) => [
						model,
						{
							total: s.total,
							passed: s.passed,
							failed: s.failed,
							duration: s.duration,
							cases: s.results.map((r) => ({
								id: r.caseId,
								passed: r.passed,
								duration: r.duration,
								turns: r.turns,
								toolsCalled: r.toolsCalled,
								failedChecks: r.failedChecks,
								trace: r.trace,
							})),
						},
					]),
				),
			},
			null,
			2,
		),
		"utf-8",
	);

	appendIndex({
		timestamp,
		kind: "compare",
		models: compare.models,
		caseFilter,
		total: totals.total,
		passed: totals.passed,
		failed: totals.failed,
		commit: currentCommit(),
		file: join("runs", fileName),
	});

	return filePath;
}

/** Record a multi-model, multi-attempt (`repeat > 1`) compare run. */
export function recordCompareRepeated(compare: RepeatedCompareResult, caseFilter?: string): string {
	ensureDirs();
	const timestamp = new Date().toISOString();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_compare-x${compare.repeat}_${slugify(compare.models)}.json`;
	const filePath = join(RUNS_DIR, fileName);

	const totals = Object.values(compare.suites).reduce(
		(acc, s) => ({
			total: acc.total + s.casesTotal,
			passed: acc.passed + s.casesPassed,
			failed: acc.failed + (s.casesTotal - s.casesPassed),
		}),
		{ total: 0, passed: 0, failed: 0 },
	);
	const inconsistentCases = compare.cases.filter((c) =>
		compare.models.some((m) => compare.byCase[c.id]?.[m]?.consistent === false),
	).length;

	writeFileSync(
		filePath,
		JSON.stringify(
			{
				timestamp,
				kind: "compare",
				repeat: compare.repeat,
				models: compare.models,
				caseFilter,
				commit: currentCommit(),
				perModel: Object.fromEntries(
					Object.entries(compare.suites).map(([model, s]) => [
						model,
						{
							casesTotal: s.casesTotal,
							casesPassed: s.casesPassed,
							duration: s.duration,
							cases: s.results.map((r) => ({
								id: r.caseId,
								passed: r.passed,
								total: r.total,
								consistent: r.consistent,
								avgDuration: r.avgDuration,
								avgTurns: r.avgTurns,
								attempts: r.attempts.map((a) => ({
									passed: a.passed,
									duration: a.duration,
									turns: a.turns,
									failedChecks: a.failedChecks,
									trace: a.trace,
								})),
							})),
						},
					]),
				),
			},
			null,
			2,
		),
		"utf-8",
	);

	appendIndex({
		timestamp,
		kind: "compare",
		models: compare.models,
		caseFilter,
		total: totals.total,
		passed: totals.passed,
		failed: totals.failed,
		commit: currentCommit(),
		file: join("runs", fileName),
		repeat: compare.repeat,
		inconsistentCases,
	});

	return filePath;
}

/** Print a compact table of past runs — newest last, like `git log --oneline` in spirit. */
export function printHistory(limit = 20): void {
	const entries = readIndex().slice(-limit);
	if (entries.length === 0) {
		console.log("No recorded runs yet — evals/results/index.json is empty or missing.");
		return;
	}
	console.log(`\nLast ${entries.length} recorded run(s):\n`);
	for (const e of entries) {
		const rate = e.total > 0 ? `${e.passed}/${e.total}` : "0/0";
		const models = e.models.join(", ");
		const commit = e.commit ? ` @${e.commit}` : "";
		const filter = e.caseFilter ? ` [${e.caseFilter}]` : "";
		const repeat = e.repeat && e.repeat > 1 ? ` x${e.repeat}` : "";
		const inconsistent =
			e.inconsistentCases && e.inconsistentCases > 0 ? ` ⚠${e.inconsistentCases} inconsistent` : "";
		console.log(
			`  ${e.timestamp}  ${e.kind.padEnd(7)} ${rate.padEnd(7)}${repeat} ${models}${filter}${commit}${inconsistent}`,
		);
	}
	console.log();
}
