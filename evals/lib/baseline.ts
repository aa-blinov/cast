/**
 * Baseline management and regression detection for eval runs.
 *
 * A baseline is a saved snapshot of a suite result keyed by bench+model —
 * the "known-good" state a future run is compared against. Comparing a run
 * to its baseline produces a `BaselineDelta` with:
 *   - pass-rate delta (% of cases passing)
 *   - statistical significance: one-sided binomial p-value + Wilson 95% CIs
 *   - per-case regressions (cases that passed in baseline but failed now)
 *   - per-case improvements (symmetric)
 *   - cost/token/duration deltas
 *
 * Regression flag (`hasRegression`) is driven by **statistical significance**
 * rather than a fixed percentage-point threshold, so a 1-case regression on
 * a 100-case suite (where the normal-approx p-value is tiny) flags but a
 * 1-case regression on a 2-case suite (where the same p-value is ~0.4) does
 * not. Configurable via `--significance-alpha` (default 0.05 = 95% confidence).
 *
 * Baselines live under `evals/baselines/` in two layers:
 *
 *   evals/baselines/
 *     <bench>-<model>.json          <-- latest snapshot (what `--baseline` reads)
 *     history/
 *       2026-07-25T14-30-00Z_<bench>-<model>.json    <-- every save is timed-stamped
 *       2026-07-26T09-12-33Z_<bench>-<model>.json
 *
 * Every `--save-baseline` writes a new dated copy to `history/` *and*
 * refreshes the top-level "latest" file in one shot. The dated history is
 * what makes "how was the eval doing two weeks ago" cheap to answer — diff
 * two snapshots, no extra tooling. Both layers are tracked in git so
 * baselines move with the codebase they correspond to (a baseline pinned
 * to a commit is what `--history` correlates via `commit`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepeatedSuiteResult, SuiteResult } from "./runner.ts";

/**
 * Structural subset of `SuiteResult` that `compareToBaseline` actually reads
 * — lets a `RepeatedSuiteResult` be compared without faking a full
 * `RunResult` (13+ fields, mostly unused here) per case. `SuiteResult`
 * already satisfies this shape, so every existing single-run caller keeps
 * working unchanged; `toComparableSuiteResult` below adapts the repeated
 * shape to it.
 */
export interface ComparableSuiteResult {
	total: number;
	passed: number;
	duration: number;
	usage: SuiteResult["usage"];
	results: Array<{ caseId: string; passed: boolean }>;
}

/**
 * Adapts a repeated run's suite result for `compareToBaseline`, using the
 * same strict per-case pass rule as `recordRepeatedBaseline` (results.ts):
 * every attempt must agree AND pass (`consistent && passed > 0`) — a case
 * that only passed 2/3 times doesn't count as "passing" for either baseline
 * or regression-check purposes, so the two stay consistent with each other.
 */
export function toComparableSuiteResult(suite: RepeatedSuiteResult): ComparableSuiteResult {
	const results = suite.results.map((r) => ({ caseId: r.caseId, passed: r.consistent && r.passed > 0 }));
	return {
		total: suite.casesTotal,
		passed: results.filter((r) => r.passed).length,
		duration: suite.duration,
		usage: suite.usage,
		results,
	};
}

/**
 * Resolve where baselines live. Reads from `EVAL_BASELINES_DIR` so tests
 * can point at an isolated tempdir via `process.env` before each case
 * (the module-level `const BASELINES_DIR` made it impossible to per-test
 * isolate without re-importing the entire module — env is the simplest
 * scope the test framework already sets up).
 *
 * History always lives in `<baselinesDir>/history`, mirroring the latest
 * pointer in `<baselinesDir>/<name>.json`.
 */
function baselinesDir(): string {
	return process.env.EVAL_BASELINES_DIR ?? join(import.meta.dirname, "..", "baselines");
}

function historyDir(): string {
	return join(baselinesDir(), "history");
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

function ensureDirs(): void {
	const bDir = baselinesDir();
	const hDir = historyDir();
	if (!existsSync(bDir)) mkdirSync(bDir, { recursive: true });
	if (!existsSync(hDir)) mkdirSync(hDir, { recursive: true });
}

/**
 * Filename used for the timed-stamped history copy. The full ISO timestamp
 * (with the `:` → `-` swap that the rest of the evals directory uses) keeps
 * `ls` ordering chronological without any extra indexing.
 */
/**
 * Filename used for the timed-stamped history copy. The full ISO timestamp
 * (with the `:` → `-` swap that the rest of the evals directory uses) keeps
 * `ls` ordering chronological without any extra indexing.
 */
export function historyFileName(timestamp: string, baselineName: string): string {
	return `${timestamp.replace(/[:.]/g, "-")}_${baselineName}.json`;
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

function latestPath(name: string): string {
	return join(baselinesDir(), `${name}.json`);
}

function defaultBaselineName(bench: string, model: string): string {
	return `${bench}-${model}`;
}

/** Save a baseline from a suite result. Returns the saved baseline. */
export function saveBaseline(suite: SuiteResult, bench: string, name?: string): Baseline {
	ensureDirs();
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

	const serialized = JSON.stringify(baseline, null, 2);

	// Write the history file first, then refresh the latest pointer. If the
	// second write fails for any reason, we still have a recoverable record
	// in history/ for the run that just landed.
	const historyPath = join(historyDir(), historyFileName(baseline.timestamp, baselineName));
	writeFileSync(historyPath, serialized, "utf-8");
	writeFileSync(latestPath(baselineName), serialized, "utf-8");
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
	const path = latestPath(name);
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

/**
 * List every saved "latest" baseline (one per bench+model), newest first.
 * Skips the `history/` subdir — see `listBaselineHistory` for the full
 * timeline of a specific baseline.
 */
export function listBaselines(): Baseline[] {
	const bDir = baselinesDir();
	if (!existsSync(bDir)) return [];
	const results: Baseline[] = [];
	for (const entry of readdirSync(bDir)) {
		const fullPath = join(bDir, entry);
		if (!entry.endsWith(".json")) continue;
		if (entry.startsWith(".")) continue;
		try {
			const b = JSON.parse(readFileSync(fullPath, "utf-8")) as Baseline;
			results.push(b);
		} catch {
			// skip corrupt baselines
		}
	}
	return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Read every historical snapshot of a single baseline (across all saves),
 * newest first. Returns `[]` if there's no history — also returns `[]` if
 * only the latest "pointer" exists without any history yet.
 */
export function listBaselineHistory(name: string): Baseline[] {
	const hDir = historyDir();
	if (!existsSync(hDir)) return [];
	const results: Baseline[] = [];
	for (const entry of readdirSync(hDir)) {
		if (!entry.endsWith(".json")) continue;
		// Files are `<dateStamp>_<name>.json`; the date prefix sorts first
		// chronologically under string compare because it's ISO8601 with
		// `:` and `.` replaced.
		const trailingUnderscore = entry.lastIndexOf("_");
		if (trailingUnderscore < 0) continue;
		const fileName = entry.slice(trailingUnderscore + 1, -".json".length);
		if (fileName !== name) continue;
		try {
			const b = JSON.parse(readFileSync(join(hDir, entry), "utf-8")) as Baseline;
			results.push(b);
		} catch {
			// skip corrupt entries
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

// ============================================================================
// Statistical significance
// ============================================================================

/** Wilson score 95% confidence interval for a binomial proportion. */
export interface ConfidenceInterval {
	lower: number;
	upper: number;
	/** The confidence level as a probability (e.g. 0.95). */
	level: number;
}

/**
 * Statistical assessment of the difference between two binomial proportions
 * (the baseline's pass rate and the current run's pass rate).
 *
 * The two-proportion z-test uses a pooled proportion under H0: p1 == p2.
 * For small samples (n < ~30 in either group) the normal approximation is
 * unreliable — see `sampleSizeSufficient` to know when to lean on it.
 *
 * H0: pass rates are the same. H1: current pass rate is *lower* than
 * baseline (one-sided — we only care about regressions here, not
 * improvements, because improvements would never block CI). `pValue` is
 * the one-sided probability of observing this diff (or larger) under H0.
 */
export interface SignificanceTest {
	/** One-sided p-value: P(observed diff or larger | H0 true and current ≤ baseline). */
	pValue: number;
	/** Significance level `compareToBaseline` was run at — by default 0.05. */
	alpha: number;
	/** True if `pValue < alpha` — the observed drop is unlikely under H0. */
	isSignificant: boolean;
	/**
	 * Effect size (Cohen's h) — `2*asin(sqrt(p1)) - 2*asin(sqrt(p2))`. Always
	 * non-negative here since we test the one-sided drop. Convention:
	 * 0.2 small, 0.5 medium, 0.8 large.
	 */
	effectSize: number;
	/** 95% CI (Wilson score) for the baseline pass rate. */
	baselineCI: ConfidenceInterval;
	/** 95% CI (Wilson score) for the current pass rate. */
	currentCI: ConfidenceInterval;
	/**
	 * False when either side has too few cases for the normal-approx
	 * z-test to be reliable (< 10). Tests below this threshold are
	 * statistically uninformative — treat the result as "need more data".
	 */
	sampleSizeSufficient: boolean;
}

/**
 * Wilson score interval for a binomial proportion — better than the
 * textbook normal-approx interval at extremes (p near 0 or 1) and for
 * small n. From Wilson 1927; see also Newcombe 1998 for the
 * "score" variants that respect [0, 1].
 */
export function wilsonScoreInterval(passed: number, total: number, level = 0.95): ConfidenceInterval {
	if (total <= 0) return { lower: 0, upper: 1, level };
	const z = normalQuantile(1 - (1 - level) / 2);
	const p = passed / total;
	const denom = 1 + (z * z) / total;
	const center = (p + (z * z) / (2 * total)) / denom;
	const halfWidth = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
	return {
		lower: Math.max(0, center - halfWidth),
		upper: Math.min(1, center + halfWidth),
		level,
	};
}

/**
 * One-sided two-proportion z-test (normal approximation):
 *   H0: p_baseline == p_current,  H1: p_current < p_baseline
 * Uses a pooled proportion under H0 for the standard error.
 *
 * Returns p-value in [0, 1]. p > 0.05 means "can't reject H0 at 95%"
 * — i.e., the observed drop is plausibly just noise. p < 0.05 means
 * the drop is unlikely if the true pass rates were equal.
 *
 * Tiny samples break the normal approximation; call sites should gate
 * on `total1 >= 10 && total2 >= 10` before trusting the number.
 */
export function binomialTestOneSided(
	baselinePassed: number,
	baselineTotal: number,
	currentPassed: number,
	currentTotal: number,
): number {
	if (baselineTotal <= 0 || currentTotal <= 0) return 1; // can't test — give the safest p-value
	if (baselinePassed < 0 || currentPassed < 0) return 1;
	if (baselinePassed > baselineTotal || currentPassed > currentTotal) return 1;
	const p1 = baselinePassed / baselineTotal;
	const p2 = currentPassed / currentTotal;
	// If current is already >= baseline, no regression possible — p-value
	// for the one-sided test is 1.0 (every sample at least as extreme).
	if (p2 >= p1) return 1;

	const pooled = (baselinePassed + currentPassed) / (baselineTotal + currentTotal);
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / baselineTotal + 1 / currentTotal));
	if (se === 0) return 1; // both samples entirely of the same outcome
	const z = (p2 - p1) / se;
	// One-sided p-value for H1 "current is worse": P(Z ≤ observed z under H0).
	// standardNormalCDF(z) gives exactly that. z is negative when current < baseline.
	return standardNormalCDF(z);
}

/**
 * Higher-level wrapper around the binomial test: returns the p-value,
 * whether it clears the configured alpha, the effect size, and the
 * Wilson confidence intervals for both runs' pass rates. Also flags
 * whether the sample is large enough to trust the normal approximation.
 */
export function testSignificance(
	baselinePassed: number,
	baselineTotal: number,
	currentPassed: number,
	currentTotal: number,
	alpha = 0.05,
): SignificanceTest {
	const pValue = binomialTestOneSided(baselinePassed, baselineTotal, currentPassed, currentTotal);
	const p1 = baselineTotal > 0 ? baselinePassed / baselineTotal : 0;
	const p2 = currentTotal > 0 ? currentPassed / currentTotal : 0;
	// Cohen's h — always measured as `current worse than baseline` magnitude here,
	// so it's non-negative.
	const effectSize = Math.abs(
		2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p1)))) - 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p2)))),
	);
	return {
		pValue,
		alpha,
		isSignificant: pValue < alpha,
		effectSize,
		baselineCI: wilsonScoreInterval(baselinePassed, baselineTotal, 0.95),
		currentCI: wilsonScoreInterval(currentPassed, currentTotal, 0.95),
		sampleSizeSufficient: baselineTotal >= 10 && currentTotal >= 10,
	};
}

// ---------------------------------------------------------------------------
// Normal-distribution helpers — kept private to this module. Adequate for the
// range we need (p-values near 0…1 and quantiles near 95%); not designed for
// pathological tails. If you need more accuracy: import jstat or similar.
// ---------------------------------------------------------------------------

/** Φ(x) — the standard normal CDF. Abramowitz & Stegun 7.1.26, max error ~1.5e-7. */
function standardNormalCDF(x: number): number {
	// For very small/large x, return exactly 0 or 1 to avoid log(0).
	if (x <= -8) return 0;
	if (x >= 8) return 1;
	const a1 = 0.31938153;
	const a2 = -0.356563782;
	const a3 = 1.781477937;
	const a4 = -1.821255978;
	const a5 = 1.330274429;
	const sign = x < 0 ? -1 : 1;
	const absX = Math.abs(x);
	const k = 1 / (1 + 0.2316419 * absX);
	const w =
		1 -
		(1 / Math.sqrt(2 * Math.PI)) *
			Math.exp(-0.5 * absX * absX) *
			(a1 * k + a2 * k ** 2 + a3 * k ** 3 + a4 * k ** 4 + a5 * k ** 5);
	// φ is in (0,1] for positive x; mirror for negative.
	return sign < 0 ? 1 - w : w;
}

/** Inverse of the standard normal CDF (quantile function) — Beasley–Springer–Moro. */
function normalQuantile(p: number): number {
	if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity;
	const a = [
		-3.969683028665376e1, 2.209460984245677e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
		2.506628277459239,
	];
	const b = [-5.447609879822406e1, 1.615858368580409e2, -1.515324256834396e2, 5.319108671475771e1, -6.648916970787573];
	const c = [
		-7.784894002430293e-3, -3.223964705411182e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
		2.938163982698783,
	];
	const d = [7.784695709041462e-3, 3.775142563343413e-1, 2.764150932843715e-1, 4.986126289736191];
	const pLow = 0.02425;
	const pHigh = 1 - pLow;
	let q: number;
	let r: number;
	let x: number;
	if (p < pLow) {
		q = Math.sqrt(-2 * Math.log(p));
		const num = (((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!;
		const den = (((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1;
		x = num / den;
	} else if (p <= pHigh) {
		q = p - 0.5;
		r = q * q;
		const num = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q;
		const den = ((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1;
		x = num / den;
	} else {
		q = Math.sqrt(-2 * Math.log(1 - p));
		const num = (((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!;
		const den = (((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1;
		x = -(num / den);
	}
	return x;
}

/**
 * Result of comparing a new run to a saved baseline — carries aggregate
 * deltas (pass rate, cost, duration), **statistical significance** of the
 * pass-rate drop, and the per-case regressions/improvements that explain
 * them.
 */
export interface BaselineDelta {
	baseline: Baseline;
	current: ComparableSuiteResult;
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
	/** Statistical assessment of the pass-rate drop. */
	significance: SignificanceTest;
	/**
	 * True if the run should fail for a regression: a statistically
	 * significant drop (`significance.isSignificant`) when the sample is
	 * large enough to trust the test, falling back to the
	 * `--regression-threshold` percentage-point rule when sample size is
	 * too small for significance testing to be informative (< ~10 each).
	 */
	hasRegression: boolean;
}
/**
 * Compare a fresh run against a saved baseline.
 *
 * Decision rule for `hasRegression`:
 *   - If both runs cover >= 10 common cases (large enough for the z-test
 *     to be reliable), use the binomial significance test at
 *     `--significance-alpha` (default 0.05), computed on the *common*
 *     case subset — the only apples-to-apples comparison possible when
 *     the current run's case set may have grown or shrunk.
 *   - For smaller samples, fall back to the simpler `--regression-threshold`
 *     percentage-point rule (default 5 pp) so the eval still flags a
 *     meaningful drop on tiny suites even though the normal approximation
 *     would be statistically uninformative.
 *
 * In both cases `significance.isSignificant` is still populated on the
 * returned delta — the threshold is just the *fallback* when significance
 * can't be trusted.
 */
export function compareToBaseline(
	suite: ComparableSuiteResult,
	bench: string,
	baselineName: string,
	options: { threshold?: number; alpha?: number } = {},
): BaselineDelta | null {
	const baseline = loadBaseline(baselineName);
	if (!baseline) return null;

	const threshold = options.threshold ?? 0.05;
	const alpha = options.alpha ?? 0.05;

	const baselineByCase = new Map(baseline.results.map((r) => [r.caseId, r]));

	const regressions: CaseOutcomeChange[] = [];
	const improvements: CaseOutcomeChange[] = [];

	// Cases in the current run — compare to baseline by case id.
	let commonBaselinePassed = 0;
	let commonTotal = 0;
	for (const r of suite.results) {
		const base = baselineByCase.get(r.caseId);
		if (!base) continue; // new case added since baseline — ignored, not a regression
		commonTotal++;
		if (base.passed) commonBaselinePassed++;
		if (base.passed && !r.passed) {
			regressions.push({ caseId: r.caseId, baselinePassed: true, currentPassed: false });
		} else if (!base.passed && r.passed) {
			improvements.push({ caseId: r.caseId, baselinePassed: false, currentPassed: true });
		}
	}

	let commonCurrentPassed = 0;
	for (const r of suite.results) {
		const base = baselineByCase.get(r.caseId);
		if (!base) continue;
		if (r.passed) commonCurrentPassed++;
	}
	const commonPassedDelta = commonCurrentPassed - commonBaselinePassed;
	const passRateDelta =
		suite.total === 0 || commonTotal === 0
			? 0
			: commonCurrentPassed / commonTotal - baseline.passRate;
	// Significance is computed on the common-case subset so a new or removed
	// case can't tilt the test (cases only present in one run are silently
	// ignored — see regressions/improvements for the per-case diffs).
	const significance = testSignificance(commonBaselinePassed, commonTotal, commonCurrentPassed, commonTotal, alpha);
	const hasRegression = significance.sampleSizeSufficient
		? significance.isSignificant
		: passRateDelta <= -threshold;
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
		significance,
		hasRegression,
	};
}
/**
 * Format a `BaselineDelta` for human display — used by `printRegressionReport`
 * and by `evals/run.ts` after a comparison-mode run.
 */
export function formatDelta(delta: BaselineDelta, threshold = 0.05): string {
	const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}pp`;
	const fmtSigned = (x: number) => `${x >= 0 ? "+" : ""}${x.toLocaleString()}`;
	const fmtPctRaw = (x: number) => `${(x * 100).toFixed(1)}%`;
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
	// Statistical significance block — the heart of the detection.
	const sig = delta.significance;
	lines.push(
		`  Significance: p=${sig.pValue.toFixed(4)}${sig.isSignificant ? " *" : ""} (α=${sig.alpha}), effect size h=${sig.effectSize.toFixed(3)}, ${sig.sampleSizeSufficient ? "n sufficient" : "LOW N — see threshold fallback"}`,
	);
	// Wilson 95% CI for both runs — shows the uncertainty around each measurement.
	lines.push(
		`  Confidence intervals (95%): baseline ${fmtPctRaw(sig.baselineCI.lower)}–${fmtPctRaw(sig.baselineCI.upper)}, current ${fmtPctRaw(sig.currentCI.lower)}–${fmtPctRaw(sig.currentCI.upper)}`,
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
		if (sig.sampleSizeSufficient && sig.isSignificant) {
			lines.push(
				`  ✗ STATISTICALLY SIGNIFICANT REGRESSION (p=${sig.pValue.toFixed(4)} < α=${sig.alpha}; Cohen's h=${sig.effectSize.toFixed(3)})`,
			);
		} else {
			// Either small-sample fallback or threshold was tripped
			lines.push(
				`  ✗ REGRESSION (pass rate dropped by ${Math.abs(delta.passRateDelta * 100).toFixed(1)}pp, threshold: ${threshold * 100}pp)`,
			);
		}
	} else if (delta.passRateDelta < 0) {
		if (sig.sampleSizeSufficient) {
			lines.push(
				`  ⚠ Pass rate dropped by ${Math.abs(delta.passRateDelta * 100).toFixed(1)}pp but NOT statistically significant (p=${sig.pValue.toFixed(4)}) — needs more data to confirm`,
			);
		} else {
			lines.push(
				`  ⚠ Pass rate dropped by ${Math.abs(delta.passRateDelta * 100).toFixed(1)}pp (small sample — threshold fallback; current ${delta.current.total} cases)`,
			);
		}
	} else if (delta.passRateDelta > 0) {
		lines.push("");
		if (sig.isSignificant) {
			lines.push(
				`  ✓ STATISTICALLY SIGNIFICANT IMPROVEMENT (p=${sig.pValue.toFixed(4)} < α=${sig.alpha}; Cohen's h=${sig.effectSize.toFixed(3)})`,
			);
		} else {
			lines.push(
				`  ✓ Pass rate improved by ${(delta.passRateDelta * 100).toFixed(1)}pp (not statistically significant, p=${sig.pValue.toFixed(4)})`,
			);
		}
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
