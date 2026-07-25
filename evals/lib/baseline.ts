/**
 * Baseline management and regression detection for eval runs.
 *
 * A baseline is a saved snapshot of a suite result keyed by bench+model —
 * the "known-good" state a future run is compared against. Comparing a run
 * to its baseline produces a `BaselineDelta` with:
 *   - pass-rate delta (% of cases passing)
 *   - per-case regressions (cases that passed in baseline but failed now)
 *   - per-case improvements (symmetric)
 *   - cost/token/duration deltas
 *
 * The point is to catch harness and prompt regressions in CI: a PR that
 * drops pass-rate by more than `--regression-threshold` exits non-zero,
 * the same way it would if a case outright failed. Stops "this is fine"
 * reviews from normalizing gradual drift the way single-run snapshots can.
 *
 * Baselines live in `evals/baselines/<bench>-<model>.json` — one per
 * (bench, model) pair. Save with `--save-baseline`, compare against with
 * `--baseline <name>`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SuiteResult } from "./runner.ts";

const BASELINES_DIR = join(import.meta.dirname, "..", "baselines");

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

function ensureBaselinesDir(): void {
	if (!existsSync(BASELINES_DIR)) mkdirSync(BASELINES_DIR, { recursive: true });
}

/** A saved suite result used as the reference point for regression detection. */
export interface Baseline {
	/** Display name in `<bench>-<model>` form — unique within the baselines dir. */
	name: string;
	/** Bench the baseline was saved against — `basic`, `hashline`, `mutation`, etc. */
	bench: string;
	/** Model the baseline was captured on. */
	model: string;
	/** Short commit hash at baseline time, if this is a git checkout. */
	commit?: string;
	/** ISO timestamp when the baseline was saved. */
	timestamp: string;
	total: number;
	passed: number;
	failed: number;
	/** Convenience: passed/total as a float in [0, 1]. */
	passRate: number;
	duration: number;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		uncachedTokens: number;
	};
	/** Per-case detail keyed by case id — what was checked at baseline time. */
	results: Array<{
		caseId: string;
		passed: boolean;
		duration: number;
		turns: number;
		usage: {
			promptTokens: number;
			completionTokens: number;
			totalTokens: number;
			cost: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			uncachedTokens: number;
		};
	}>;
}

function baselinePath(name: string): string {
	return join(BASELINES_DIR, `${name}.json`);
}

function defaultBaselineName(bench: string, model: string): string {
	return `${bench}-${model}`;
}

/** Save a baseline from a suite result. Returns the saved baseline. */
export function saveBaseline(suite: SuiteResult, bench: string, name?: string): Baseline {
	ensureBaselinesDir();
	const baselineName = name ?? defaultBaselineName(bench, suite.model);
	const baseline: Baseline = {
		name: baselineName,
		bench,
		model: suite.model,
		commit: currentCommit(),
		timestamp: new Date().toISOString(),
		total: suite.total,
		passed: suite.passed,
		failed: suite.failed,
		passRate: suite.total === 0 ? 0 : suite.passed / suite.total,
		duration: suite.duration,
		usage: { ...suite.usage },
		results: suite.results.map((r) => ({
			caseId: r.caseId,
			passed: r.passed,
			duration: r.duration,
			turns: r.turns,
			usage: { ...r.usage },
		})),
	};

	writeFileSync(baselinePath(baselineName), JSON.stringify(baseline, null, 2), "utf-8");
	return baseline;
}

/**
 * Load a baseline by name. The second optional `model` is used to construct
 * the default `<bench>-<model>` name when the caller passes a bench name
 * instead of an explicit baseline name.
 *
 * Returns `null` if the baseline doesn't exist — callers decide whether
 * that's a warning ("you're comparing against an unrecorded slot") or
 * a usage error.
 */
export function loadBaseline(nameOrBench: string, model?: string): Baseline | null {
	const name = model ? defaultBaselineName(nameOrBench, model) : nameOrBench;
	const path = baselinePath(name);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Baseline;
	} catch {
		return null; // corrupt baseline — treat as missing rather than crash a run
	}
}

/**
 * Resolve a baseline name (or bench/model) to a full baseline. Tries:
 *   1. the literal name as a file in the baselines dir
 *   2. the default `<bench>-<model>` name
 * Prefers exact-name matches so callers can hand-pick a specific saved
 * baseline even if multiple exist for the same bench.
 */
export function resolveBaseline(nameOrBench: string, model?: string): Baseline | null {
	const exact = loadBaseline(nameOrBench);
	if (exact) return exact;
	if (model) return loadBaseline(nameOrBench, model);
	return null;
}

/** List every saved baseline, newest first. */
export function listBaselines(): Baseline[] {
	if (!existsSync(BASELINES_DIR)) return [];
	const results: Baseline[] = [];
	for (const entry of readdirSync(BASELINES_DIR)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const b = JSON.parse(readFileSync(join(BASELINES_DIR, entry), "utf-8")) as Baseline;
			results.push(b);
		} catch {
			// skip corrupt baselines
		}
	}
	return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Per-case outcome change between baseline and current run. */
export interface CaseOutcomeChange {
	caseId: string;
	baselinePassed: boolean;
	currentPassed: boolean;
}

/**
 * Result of comparing a new run to a saved baseline — carries both
 * aggregate deltas (pass rate, cost, duration) and the per-case
 * regressions/improvements that explain them.
 */
export interface BaselineDelta {
	baseline: Baseline;
	current: SuiteResult;
	/** Pass-rate delta in absolute terms: `current - baseline`. Positive = improved. */
	passRateDelta: number;
	/** Raw passed-count delta (positive = more cases passing now). */
	passedDelta: number;
	/** Token delta (positive = consumed more tokens). */
	totalTokensDelta: number;
	/** Cost delta (positive = costlier). */
	costDelta: number;
	/** Duration delta in ms (positive = slower). */
	durationDelta: number;
	/** Cases that passed in the baseline but failed in the current run. */
	regressions: CaseOutcomeChange[];
	/** Cases that failed in the baseline but passed now. */
	improvements: CaseOutcomeChange[];
	/**
	 * True if the pass-rate drop exceeds the configured threshold — i.e.
	 * this is a real regression worth failing the run for.
	 */
	hasRegression: boolean;
}

/**
 * Compare a fresh run against a saved baseline.
 *
 * `threshold` is the pass-rate drop that counts as a regression —
 * default 5 percentage points (5%). 5 pp on a 20-case suite = 1 case;
 * on a 2-case suite, 5pp = nothing (`passedDelta` only flips at the
 * next case boundary), so this naturally under-reports regressions on
 * tiny suites without false-alarming on noise. Bigger suites give finer
 * resolution.
 */
export function compareToBaseline(
	suite: SuiteResult,
	bench: string,
	baselineName: string,
	threshold = 0.05,
): BaselineDelta | null {
	const baseline = loadBaseline(baselineName);
	if (!baseline) return null;

	const baselineByCase = new Map(baseline.results.map((r) => [r.caseId, r]));

	const regressions: CaseOutcomeChange[] = [];
	const improvements: CaseOutcomeChange[] = [];

	// Cases in the current run — compare to baseline by case id.
	for (const r of suite.results) {
		const base = baselineByCase.get(r.caseId);
		if (!base) continue; // new case added since baseline — ignored, not a regression
		if (base.passed && !r.passed) {
			regressions.push({ caseId: r.caseId, baselinePassed: true, currentPassed: false });
		} else if (!base.passed && r.passed) {
			improvements.push({ caseId: r.caseId, baselinePassed: false, currentPassed: true });
		}
	}

	const passRateDelta = suite.total === 0 ? 0 : suite.passed / suite.total - baseline.passRate;
	return {
		baseline,
		current: suite,
		passRateDelta,
		passedDelta: suite.passed - baseline.passed,
		totalTokensDelta: suite.usage.totalTokens - baseline.usage.totalTokens,
		costDelta: suite.usage.cost - baseline.usage.cost,
		durationDelta: suite.duration - baseline.duration,
		regressions,
		improvements,
		hasRegression: passRateDelta <= -threshold,
	};
}

/**
 * Format a `BaselineDelta` for human display — used by `printRegressionReport`
 * and by `evals/run.ts` after a comparison-mode run.
 */
export function formatDelta(delta: BaselineDelta, threshold = 0.05): string {
	const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
	const fmtSigned = (x: number) => `${x >= 0 ? "+" : ""}${x.toLocaleString()}`;
	const lines: string[] = [];
	const linescore = (label: string, current: number, baseline: number, delta: number, unit = "") => {
		lines.push(
			`  ${label}: ${current.toLocaleString()}${unit} (baseline: ${baseline.toLocaleString()}${unit}, ${fmtSigned(delta)}${unit})`,
		);
	};
	lines.push(
		`Comparing against baseline "${delta.baseline.name}" (${delta.baseline.timestamp}, ${delta.baseline.commit ? `@${delta.baseline.commit} ` : ""}${delta.baseline.passed}/${delta.baseline.total} passing, ${(delta.baseline.passRate * 100).toFixed(1)}%):`,
	);
	linescore(
		"Pass rate",
		delta.current.passed,
		delta.baseline.passed,
		delta.passedDelta,
		`/${delta.current.total} (${fmtPct(delta.passRateDelta)})`,
	);
	linescore("Total tokens", delta.current.usage.totalTokens, delta.baseline.usage.totalTokens, delta.totalTokensDelta);
	if (delta.costDelta !== 0 || delta.baseline.usage.cost > 0 || delta.current.usage.cost > 0) {
		const currentCostStr = delta.current.usage.cost > 0 ? `$${delta.current.usage.cost.toFixed(4)}` : "n/a";
		const baselineCostStr = delta.baseline.usage.cost > 0 ? `$${delta.baseline.usage.cost.toFixed(4)}` : "n/a";
		lines.push(`  Cost: ${currentCostStr} (baseline: ${baselineCostStr}, ${fmtSigned(delta.costDelta)})`);
	}
	linescore("Duration", delta.current.duration, delta.baseline.duration, delta.durationDelta, "ms");
	if (delta.regressions.length > 0) {
		lines.push("");
		lines.push("  ⚠ Regressions (passed in baseline, failed now):");
		for (const r of delta.regressions) {
			lines.push(`    - ${r.caseId}`);
		}
	}
	if (delta.improvements.length > 0) {
		lines.push("");
		lines.push("  ✓ Improvements (failed in baseline, passed now):");
		for (const r of delta.improvements) {
			lines.push(`    - ${r.caseId}`);
		}
	}
	if (delta.hasRegression) {
		lines.push("");
		lines.push(
			`  ✗ REGRESSION (pass rate dropped by ${Math.abs(delta.passRateDelta * 100).toFixed(1)}pp, threshold: ${threshold * 100}pp)`,
		);
	} else if (delta.passRateDelta < 0) {
		lines.push("");
		lines.push(
			`  ⚠ Pass rate dropped by ${Math.abs(delta.passRateDelta * 100).toFixed(1)}pp (below ${threshold * 100}pp threshold)`,
		);
	} else if (delta.passRateDelta > 0) {
		lines.push("");
		lines.push(`  ✓ Pass rate improved by ${(delta.passRateDelta * 100).toFixed(1)}pp`);
	}
	return lines.join("\n");
}

/** Find a baseline by name with the optional bench prefix; used for CLI auto-resolution. */
export function findBaseline(name: string): Baseline | null {
	// Try exact match first.
	const exact = loadBaseline(name);
	if (exact) return exact;
	// Try matching by `<bench>-<model>` form when given an ambiguous name.
	for (const b of listBaselines()) {
		if (b.bench === name || b.model === name) return b;
	}
	return null;
}
