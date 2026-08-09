/**
 * Model scoreboard — a committed, human-readable certification artifact,
 * distinct from the baseline/regression system in `baseline.ts`. A baseline
 * answers "did this model get worse than it used to be"; the scoreboard
 * answers "is this model good enough to run cast at all," meant to be read
 * by anyone visiting the docs site, not just someone running the CLI.
 *
 * Only ever built from a `--repeat` run (see `evals/run.ts`'s `--scoreboard`
 * flag) — a single stochastic run can't support a certification claim. The
 * pass rule below intentionally matches `recordRepeatedBaseline`'s
 * (`results.ts`): every attempt must agree AND pass (`consistent && passed >
 * 0`), not the looser majority-vote used for the console's aggregate report.
 * A model that only passes a case 2/3 times should not read as "passing" on
 * a certification table — that inconsistency is exactly what this exists to
 * surface. Reusing the same rule keeps "passing" meaning one thing across
 * both artifacts.
 *
 * `results` (raw per-case data) is the source of truth; every summary field
 * (score, bySignal, core/chain, timing/token stats) is derived from it by
 * `computeAggregates` and never hand-maintained — this is what makes
 * `mergeScoreboardEntry` possible: patch a handful of cases (e.g. a rerun
 * after a network-error flake) into an existing entry's `results` and
 * recompute, instead of needing a full-suite run just to update one case.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coreCases } from "../benches/behavior/tools/core/index.ts";
import { chainCases } from "../benches/behavior/tools/chain/index.ts";
import type { RepeatedCompareResult, RepeatedSuiteResult } from "./runner.ts";

/** Which of the two categories (see docs/eval-behavior.md) a case belongs to,
 *  and its signals — reused from the existing core/chain index exports
 *  rather than adding fields to every one of the 40+ case files. Keyed
 *  globally (not per-run) so a case preserved across a merge from an older
 *  run still resolves correctly. */
const ALL_CASES = [...coreCases, ...chainCases];
const CORE_CASE_IDS = new Set(coreCases.map((c) => c.id));
const CHAIN_CASE_IDS = new Set(chainCases.map((c) => c.id));
const SIGNALS_BY_CASE_ID = new Map(ALL_CASES.map((c) => [c.id, c.signals ?? []]));

export interface GroupScore {
	casesTotal: number;
	casesPassed: number;
	score: number;
}

/** Raw per-case data — everything summary fields are derived from. */
export interface ScoreboardCaseResult {
	caseId: string;
	/** Strict rule: consistent && passed > 0 (see file doc comment). */
	passed: boolean;
	/** Every attempt agreed, pass or fail — a flakiness signal independent of
	 *  whether the agreed outcome was a pass. */
	consistent: boolean;
	/** One entry per attempt — needed raw (not pre-averaged) so percentiles
	 *  survive a merge correctly. */
	durationsMs: number[];
	promptTokens: number[];
	completionTokens: number[];
	turns: number[];
}

export interface ScoreboardEntry {
	bench: string;
	model: string;
	provider?: string;
	providerUrl?: string;
	/** Reasoning effort explicitly used for this evaluation run. */
	reasoningLevel: string;
	timestamp: string;
	commit?: string;
	/** Attempts per case this entry is based on. */
	repeat: number;
	results: ScoreboardCaseResult[];
	casesTotal: number;
	casesPassed: number;
	score: number;
	consistentCases: number;
	bySignal: Record<string, { passed: number; total: number }>;
	certified: boolean;
	/** Same scoring, split by single-turn tool contracts (core) vs multi-turn
	 *  stateful workflows (chain) — see docs/eval-behavior.md. */
	core: GroupScore;
	chain: GroupScore;
	/** All computed over every individual attempt's duration (not per-case
	 *  averages) — percentiles in particular need the raw distribution, not
	 *  a mean-of-means. */
	avgDurationMs: number;
	medianDurationMs: number;
	p75DurationMs: number;
	p95DurationMs: number;
	p99DurationMs: number;
	/** Per-attempt average, not a run total — comparable across models
	 *  regardless of how many cases or repeats went into this entry. */
	avgPromptTokens: number;
	medianPromptTokens: number;
	p75PromptTokens: number;
	p95PromptTokens: number;
	p99PromptTokens: number;
	avgCompletionTokens: number;
	medianCompletionTokens: number;
	p75CompletionTokens: number;
	p95CompletionTokens: number;
	p99CompletionTokens: number;
	avgTurns: number;
	medianTurns: number;
	p75Turns: number;
	p95Turns: number;
	p99Turns: number;
}

export const CERTIFICATION_THRESHOLD = 0.8;

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

function groupScore(passes: boolean[]): GroupScore {
	const casesTotal = passes.length;
	const casesPassed = passes.filter(Boolean).length;
	return { casesTotal, casesPassed, score: casesTotal > 0 ? casesPassed / casesTotal : 0 };
}

/** Nearest-rank percentile over a value already sorted ascending. */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)]!;
}

function median(sorted: number[]): number {
	if (sorted.length === 0) return 0;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function buildCaseResults(suite: RepeatedSuiteResult): ScoreboardCaseResult[] {
	return suite.results.map((r) => ({
		caseId: r.caseId,
		passed: r.consistent && r.passed > 0,
		consistent: r.consistent,
		durationsMs: r.attempts.map((a) => a.duration),
		promptTokens: r.attempts.map((a) => a.usage.promptTokens),
		completionTokens: r.attempts.map((a) => a.usage.completionTokens),
		turns: r.attempts.map((a) => a.turns),
	}));
}

type Aggregates = Omit<
	ScoreboardEntry,
	"bench" | "model" | "provider" | "providerUrl" | "reasoningLevel" | "timestamp" | "commit" | "repeat" | "results"
>;

/** Recomputes every derived field from `results` — called after a fresh
 *  build and after every merge, so a partial rerun's aggregates are never
 *  stale relative to its raw data. */
function computeAggregates(results: ScoreboardCaseResult[]): Aggregates {
	const bySignal: Record<string, { passed: number; total: number }> = {};
	let casesPassed = 0;
	let consistentCases = 0;
	const corePasses: boolean[] = [];
	const chainPasses: boolean[] = [];
	const durations: number[] = [];
	const turns: number[] = [];
	let promptSum = 0;
	let completionSum = 0;
	let attemptCount = 0;

	for (const r of results) {
		if (r.passed) casesPassed++;
		if (r.consistent) consistentCases++;
		for (const signal of SIGNALS_BY_CASE_ID.get(r.caseId) ?? []) {
			const bucket = (bySignal[signal] ??= { passed: 0, total: 0 });
			bucket.total++;
			if (r.passed) bucket.passed++;
		}
		if (CORE_CASE_IDS.has(r.caseId)) corePasses.push(r.passed);
		else if (CHAIN_CASE_IDS.has(r.caseId)) chainPasses.push(r.passed);
		durations.push(...r.durationsMs);
		turns.push(...(r.turns ?? []));
		for (const t of r.promptTokens) {
			promptSum += t;
			attemptCount++;
		}
		for (const t of r.completionTokens) completionSum += t;
	}

	const casesTotal = results.length;
	const score = casesTotal > 0 ? casesPassed / casesTotal : 0;
	const sorted = [...durations].sort((a, b) => a - b);
	const sortedTurns = [...turns].sort((a, b) => a - b);
	const promptTokens = results.flatMap((r) => r.promptTokens).sort((a, b) => a - b);
	const completionTokens = results.flatMap((r) => r.completionTokens).sort((a, b) => a - b);

	return {
		casesTotal,
		casesPassed,
		score,
		consistentCases,
		bySignal,
		certified: score >= CERTIFICATION_THRESHOLD,
		core: groupScore(corePasses),
		chain: groupScore(chainPasses),
		avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
		medianDurationMs: median(sorted),
		p75DurationMs: percentile(sorted, 75),
		p95DurationMs: percentile(sorted, 95),
		p99DurationMs: percentile(sorted, 99),
		avgPromptTokens: attemptCount > 0 ? promptSum / attemptCount : 0,
		medianPromptTokens: median(promptTokens),
		p75PromptTokens: percentile(promptTokens, 75),
		p95PromptTokens: percentile(promptTokens, 95),
		p99PromptTokens: percentile(promptTokens, 99),
		avgCompletionTokens: attemptCount > 0 ? completionSum / attemptCount : 0,
		medianCompletionTokens: median(completionTokens),
		p75CompletionTokens: percentile(completionTokens, 75),
		p95CompletionTokens: percentile(completionTokens, 95),
		p99CompletionTokens: percentile(completionTokens, 99),
		avgTurns: turns.length > 0 ? turns.reduce((a, b) => a + b, 0) / turns.length : 0,
		medianTurns: median(sortedTurns),
		p75Turns: percentile(sortedTurns, 75),
		p95Turns: percentile(sortedTurns, 95),
		p99Turns: percentile(sortedTurns, 99),
	};
}

/** Builds one model's scoreboard entry from a repeated compare result. */
export function buildScoreboardEntry(
	compare: RepeatedCompareResult,
	model: string,
	benchIds: string[],
	providerUrl?: string,
	reasoningLevel = "off",
): ScoreboardEntry {
	const suite = compare.suites[model];
	if (!suite) throw new Error(`No repeated suite result for model "${model}" in this compare.`);

	const results = buildCaseResults(suite);
	return {
		bench: benchIds.join(","),
		model,
		timestamp: new Date().toISOString(),
		commit: currentCommit(),
		...(providerUrl ? { providerUrl } : {}),
		reasoningLevel,
		repeat: compare.repeat,
		results,
		...computeAggregates(results),
	};
}

export function recomputeScoreboardEntry(entry: ScoreboardEntry): ScoreboardEntry {
	return { ...entry, ...computeAggregates(entry.results) };
}

/**
 * Merges a partial rerun's fresh per-case results into an existing entry —
 * cases not covered by `fresh` (e.g. everything except the couple of cases
 * that flaked on a network error last time) keep their previous data
 * untouched. Removed cases are always pruned: a partial rerun must not leave
 * an obsolete contract contributing to a current score. Pass `isFullRun: true`
 * (no `--cases` filter) to fully replace `existing` outright.
 */
export function mergeScoreboardEntry(existing: ScoreboardEntry | undefined, fresh: ScoreboardEntry, isFullRun: boolean): ScoreboardEntry {
	if (!existing || isFullRun) return fresh;
	const activeCaseIds = new Set(ALL_CASES.map((evalCase) => evalCase.id));
	const byId = new Map(existing.results.filter((r) => activeCaseIds.has(r.caseId)).map((r) => [r.caseId, r]));
	for (const r of fresh.results) byId.set(r.caseId, r);
	const results = [...byId.values()];
	return { ...fresh, results, ...computeAggregates(results) };
}

function defaultScoreboardPath(): string {
	return join(import.meta.dirname, "..", "..", "docs", "eval-scoreboard.json");
}

/** Reads the committed scoreboard JSON — `{}` if it doesn't exist yet. */
export function readScoreboard(path: string = defaultScoreboardPath()): Record<string, ScoreboardEntry> {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
}

/** Upserts one model's entry into the committed scoreboard JSON, keyed by
 *  model name — one row per model, no history (unlike baselines): this
 *  artifact only needs to show current state. Returns the path written. */
export function upsertScoreboard(entry: ScoreboardEntry, path: string = defaultScoreboardPath()): string {
	const existing = readScoreboard(path);
	existing[entry.model] = entry;
	const sorted = Object.fromEntries(Object.keys(existing).sort().map((key) => [key, existing[key]!]));
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
	return path;
}
