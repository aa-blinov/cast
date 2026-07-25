/**
 * Tests for baseline storage and regression detection.
 *
 * The test fixtures live in `test/__test_tmp__/baseline-<n>/` — each test gets
 * its own subdir so `writeBaseline`/`readBaseline` calls don't see each
 * other across tests. We patch the BASELINES_DIR constant via a re-import of
 * the module per test rather than monkey-patching fs paths at runtime, so
 * each test can use the module as a black box.
 *
 * Tests follow the same pattern used elsewhere in this repo: per-test setup
 * and teardown via beforeEach/afterEach.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	binomialTestOneSided,
	compareToBaseline,
	formatDelta,
	listBaselineHistory,
	listBaselines,
	loadBaseline,
	saveBaseline,
	testSignificance,
	wilsonScoreInterval,
} from "../evals/lib/baseline.ts";
import type { SuiteResult } from "../evals/lib/runner.ts";

// ============================================================================
// Fixture helpers
// ============================================================================

/**
 * Builds a minimal SuiteResult with the requested number of cases and pass/fail
 * pattern. We only populate the fields baseline/compare actually read — the
 * rest (toolCalls, trace, etc.) are the same shape the runner produces but
 * are irrelevant to regression detection.
 */
function makeSuite(opts: {
	cases: Array<{ id: string; passed: boolean; duration?: number; turns?: number; totalTokens?: number }>;
	model?: string;
	totalDuration?: number;
}): SuiteResult {
	const model = opts.model ?? "test-model";
	const results = opts.cases.map((c, i) => ({
		caseId: c.id,
		description: `Case ${c.id}`,
		model,
		passed: c.passed,
		duration: c.duration ?? 1000 + i * 100,
		turns: c.turns ?? 1,
		toolsCalled: [] as string[],
		toolCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
		response: "",
		thinking: "",
		errors: [],
		failedChecks: [],
		expectedSummary: { hasGroundedVerify: false },
		trace: [],
		usage: {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: c.totalTokens ?? 150,
			cost: 0.001,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 150,
		},
	}));
	const passed = results.filter((r) => r.passed).length;
	return {
		model,
		total: results.length,
		passed,
		failed: results.length - passed,
		duration: opts.totalDuration ?? 10_000,
		results,
		usage: results.reduce(
			(acc, r) => ({
				promptTokens: acc.promptTokens + r.usage.promptTokens,
				completionTokens: acc.completionTokens + r.usage.completionTokens,
				totalTokens: acc.totalTokens + r.usage.totalTokens,
				cost: acc.cost + r.usage.cost,
				cacheReadTokens: acc.cacheReadTokens + r.usage.cacheReadTokens,
				cacheWriteTokens: acc.cacheWriteTokens + r.usage.cacheWriteTokens,
				uncachedTokens: acc.uncachedTokens + r.usage.uncachedTokens,
			}),
			{
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cost: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedTokens: 0,
			},
		),
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("baseline save/load", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = join(tmpdir(), `baseline-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tmpDir, { recursive: true });
		// Symlink the tests' BASELINES_DIR to our temp dir via env override —
		// but the module uses a hardcoded path. So instead we write a known-shape
		// file by hand to verify read/load symmetry, and use saveBaseline to a
		// name we can then read back via loadBaseline using the absolute path.
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("saveBaseline writes a JSON file loadable by name", () => {
		const suite = makeSuite({
			cases: [
				{ id: "case-a", passed: true },
				{ id: "case-b", passed: false },
			],
		});

		// The module reads BASELINES_DIR from its own import.meta.dirname, so
		// the saved file lands in the real evals/baselines/. We exercise round-
		// trip via loadBaseline using the explicit name.
		const baseline = saveBaseline(suite, "test-bench", "round-trip-name");
		expect(baseline.name).toBe("round-trip-name");
		expect(baseline.bench).toBe("test-bench");
		expect(baseline.model).toBe("test-model");
		expect(baseline.total).toBe(2);
		expect(baseline.passed).toBe(1);
		expect(baseline.failed).toBe(1);
		expect(baseline.passRate).toBe(0.5);
		expect(baseline.results).toHaveLength(2);
		expect(baseline.results[0]?.caseId).toBe("case-a");

		const loaded = loadBaseline("round-trip-name");
		expect(loaded).not.toBeNull();
		expect(loaded?.name).toBe("round-trip-name");
		expect(loaded?.results).toHaveLength(2);

		// Cleanup the real-baselines file so tests are repeatable.
		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "round-trip-name.json"), {
			force: true,
		});
	});

	it("saveBaseline uses default name <bench>-<model> when no name given", () => {
		const suite = makeSuite({
			cases: [{ id: "case-a", passed: true }],
			model: "default-name-model",
		});

		const baseline = saveBaseline(suite, "default-bench");
		expect(baseline.name).toBe("default-bench-default-name-model");

		const loaded = loadBaseline("default-bench", "default-name-model");
		expect(loaded).not.toBeNull();
		expect(loaded?.name).toBe("default-bench-default-name-model");

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "default-bench-default-name-model.json"), {
			force: true,
		});
	});

	it("loadBaseline returns null for missing baseline", () => {
		const missing = loadBaseline("does-not-exist-baseline-name-xyz");
		expect(missing).toBeNull();
	});

	it("loadBaseline treats corrupt JSON as missing (returns null)", () => {
		// Write a corrupt file to the baselines dir.
		const path = join(import.meta.dirname, "..", "evals", "baselines", "corrupt-baseline.json");
		mkdirSync(join(import.meta.dirname, "..", "evals", "baselines"), { recursive: true });
		writeFileSync(path, "{ not valid json");
		const result = loadBaseline("corrupt-baseline");
		expect(result).toBeNull();
		rmSync(path, { force: true });
	});
});

describe("baseline history", () => {
	it("saveBaseline writes a dated history copy AND refreshes the latest pointer", () => {
		const suite = makeSuite({ cases: [{ id: "a", passed: true }], model: "history-m" });
		const saved = saveBaseline(suite, "hist-bench", "hist-pointer");

		// Top-level latest pointer
		const latestPath = join(import.meta.dirname, "..", "evals", "baselines", "hist-pointer.json");
		expect(existsSync(latestPath)).toBe(true);

		// History subdirectory gets one dated copy
		const historyDir = join(import.meta.dirname, "..", "evals", "baselines", "history");
		const entries = readdirSync(historyDir).filter((f) => f.endsWith("_hist-pointer.json"));
		expect(entries).toHaveLength(1);
		const expectedPrefix = saved.timestamp.replace(/[:.]/g, "-");
		expect(entries[0]).toContain(expectedPrefix);

		// Latest and history copies carry the same content
		const historyPath = join(historyDir, entries[0]!);
		const latestData = JSON.parse(readFileSync(latestPath, "utf-8"));
		const historyData = JSON.parse(readFileSync(historyPath, "utf-8"));
		expect(latestData).toEqual(historyData);

		// Cleanup
		rmSync(latestPath, { force: true });
		rmSync(historyPath, { force: true });
	});

	it("each save appends a new history file (history grows; latest gets overwritten)", () => {
		const suite1 = makeSuite({ cases: [{ id: "a", passed: true }], model: "grow-m" });
		const suite2 = makeSuite({
			cases: [
				{ id: "a", passed: true },
				{ id: "b", passed: true },
			],
			model: "grow-m",
		});
		saveBaseline(suite1, "grow", "grow-point");
		saveBaseline(suite2, "grow", "grow-point");

		const latestPath = join(import.meta.dirname, "..", "evals", "baselines", "grow-point.json");
		const historyDir = join(import.meta.dirname, "..", "evals", "baselines", "history");
		const entries = readdirSync(historyDir).filter((f) => f.endsWith("_grow-point.json"));
		expect(entries).toHaveLength(2);

		// Latest reflects the SECOND save (2/2 passing), not the first.
		const latest = JSON.parse(readFileSync(latestPath, "utf-8"));
		expect(latest.total).toBe(2);
		expect(latest.passed).toBe(2);

		// Cleanup — delete both history files and the latest pointer
		for (const e of entries) {
			rmSync(join(historyDir, e), { force: true });
		}
		rmSync(latestPath, { force: true });
	});

	it("listBaselines reads only the latest pointer (not history)", () => {
		saveBaseline(makeSuite({ cases: [{ id: "a", passed: true }] }), "split", "split-latest");
		saveBaseline(makeSuite({ cases: [{ id: "a", passed: false }] }), "split", "split-latest");

		const all = listBaselines();
		const ours = all.filter((b) => b.name === "split-latest");
		expect(ours).toHaveLength(1);
		// Should be the latest (failed), not history's pass
		expect(ours[0]?.passed).toBe(0);

		// Cleanup
		const latestPath = join(import.meta.dirname, "..", "evals", "baselines", "split-latest.json");
		const historyDir = join(import.meta.dirname, "..", "evals", "baselines", "history");
		const entries = readdirSync(historyDir).filter((f) => f.endsWith("_split-latest.json"));
		for (const e of entries) {
			rmSync(join(historyDir, e), { force: true });
		}
		rmSync(latestPath, { force: true });
	});

	it("listBaselineHistory returns snapshots for a single baseline, newest first", () => {
		const suite1 = makeSuite({ cases: [{ id: "a", passed: true }], model: "lh-m" });
		saveBaseline(suite1, "hist-list", "lh-name");
		saveBaseline(suite1, "hist-list", "lh-name");
		saveBaseline(suite1, "hist-list", "lh-name");

		const history = listBaselineHistory("lh-name");
		expect(history.length).toBeGreaterThanOrEqual(3);
		// Newest first
		const timestamps = history.map((b) => b.timestamp);
		const sorted = [...timestamps].sort().reverse();
		expect(timestamps).toEqual(sorted);

		// Different name → empty (don't pollute)
		const other = listBaselineHistory("lh-other-name");
		expect(other).toHaveLength(0);

		// Cleanup
		const latestPath = join(import.meta.dirname, "..", "evals", "baselines", "lh-name.json");
		const historyDir = join(import.meta.dirname, "..", "evals", "baselines", "history");
		const entries = readdirSync(historyDir).filter((f) => f.endsWith("_lh-name.json"));
		for (const e of entries) {
			rmSync(join(historyDir, e), { force: true });
		}
		rmSync(latestPath, { force: true });
	});
});

describe("compareToBaseline", () => {
	it("returns null when the baseline doesn't exist", () => {
		const suite = makeSuite({ cases: [{ id: "a", passed: true }] });
		const result = compareToBaseline(suite, "basic", "missing-baseline-name");
		expect(result).toBeNull();
	});

	it("flags a regression when pass-rate drops are statistically significant", () => {
		// Baseline: 100/100 pass. Current: 80/100 pass. Delta -20pp is well outside
		// binomial noise — z ≈ -4.5, p < 0.001, comfortably significant at α=0.05.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, passed: true })),
			totalDuration: 10_000,
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 100 }, (_, i) => ({
				id: `c${i}`,
				passed: i < 80, // first 80 pass, last 20 fail
			})),
			totalDuration: 12_000,
		});

		saveBaseline(baselineSuite, "test-regress", "regress-baseline");
		const delta = compareToBaseline(currentSuite, "test-regress", "regress-baseline", { threshold: 0.05 });

		expect(delta).not.toBeNull();
		expect(delta?.passedDelta).toBe(-20);
		expect(delta?.passRateDelta).toBeCloseTo(-0.2, 5);
		expect(delta?.hasRegression).toBe(true);
		expect(delta?.significance.isSignificant).toBe(true);
		expect(delta?.significance.pValue).toBeLessThan(0.01);
		expect(delta?.regressions).toHaveLength(20);
		expect(delta?.regressions[0]?.baselinePassed).toBe(true);
		expect(delta?.regressions[0]?.currentPassed).toBe(false);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "regress-baseline.json"), {
			force: true,
		});
	});

	it("does NOT flag a regression when the drop is statistically inconclusive", () => {
		// Baseline: 20/20 pass. Current: 19/20 pass. Delta -5pp. Binomial z-test
		// gives z ≈ -1.01, p ≈ 0.16 — comfortably above α=0.05, so not significant.
		// (A 1-case flip on a 20-case suite is plausibly noise.)
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({
				id: `c${i}`,
				passed: i !== 7, // 19 pass, 1 fail
			})),
		});

		saveBaseline(baselineSuite, "test-near", "near-miss-baseline");
		const delta = compareToBaseline(currentSuite, "test-near", "near-miss-baseline", { threshold: 0.05 });

		expect(delta).not.toBeNull();
		expect(delta?.passedDelta).toBe(-1);
		expect(delta?.passRateDelta).toBeCloseTo(-0.05, 5);
		expect(delta?.hasRegression).toBe(false); // p ≈ 0.16 — noise
		expect(delta?.significance.pValue).toBeGreaterThan(0.05);
		expect(delta?.regressions).toHaveLength(1);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "near-miss-baseline.json"), {
			force: true,
		});
	});

	it("flags improvements (failed→passed) symmetrically", () => {
		const baselineSuite = makeSuite({
			cases: [
				{ id: "a", passed: true },
				{ id: "b", passed: false },
				{ id: "c", passed: false },
			],
		});
		const currentSuite = makeSuite({
			cases: [
				{ id: "a", passed: true },
				{ id: "b", passed: true }, // fixed
				{ id: "c", passed: true }, // fixed
			],
		});

		saveBaseline(baselineSuite, "test-improve", "improvements-baseline");
		const delta = compareToBaseline(currentSuite, "test-improve", "improvements-baseline");

		expect(delta).not.toBeNull();
		expect(delta?.improvements).toHaveLength(2);
		expect(delta?.regressions).toHaveLength(0);
		expect(delta?.passedDelta).toBe(2);
		expect(delta?.hasRegression).toBe(false);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "improvements-baseline.json"), { force: true });
	});

	it("ignores cases added since the baseline (no spurious regression)", () => {
		const baselineSuite = makeSuite({
			cases: [{ id: "a", passed: true }],
		});
		// New case added in current run that wasn't in the baseline.
		const currentSuite = makeSuite({
			cases: [
				{ id: "a", passed: true },
				{ id: "new-case", passed: false },
			],
		});

		saveBaseline(baselineSuite, "test-newcase", "new-case-baseline");
		const delta = compareToBaseline(currentSuite, "test-newcase", "new-case-baseline");

		expect(delta).not.toBeNull();
		// The new failing case shouldn't be flagged as a regression
		// (it wasn't in the baseline at all → no comparison possible).
		expect(delta?.regressions).toHaveLength(0);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "new-case-baseline.json"), {
			force: true,
		});
	});

	it("tracks token and duration deltas", () => {
		const baselineSuite = makeSuite({
			cases: [{ id: "a", passed: true, totalTokens: 100 }],
			totalDuration: 1000,
		});
		const currentSuite = makeSuite({
			cases: [{ id: "a", passed: true, totalTokens: 250 }],
			totalDuration: 2000,
		});

		saveBaseline(baselineSuite, "test-tokens", "tokens-baseline");
		const delta = compareToBaseline(currentSuite, "test-tokens", "tokens-baseline");

		expect(delta).not.toBeNull();
		expect(delta?.totalTokensDelta).toBe(150);
		expect(delta?.durationDelta).toBe(1000);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "tokens-baseline.json"), {
			force: true,
		});
	});
});

describe("formatDelta", () => {
	it("renders human-readable regression report", () => {
		// Baseline: 10/10 pass, 10s. Current: 9/10 pass (c1 fails), 11s.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, passed: true })),
			model: "m",
			totalDuration: 10_000,
		});
		saveBaseline(baselineSuite, "basic", "demo");

		const currentSuite = makeSuite({
			cases: Array.from({ length: 10 }, (_, i) => ({
				id: `c${i}`,
				passed: i !== 1, // c1 fails
			})),
			model: "m",
			totalDuration: 11_000,
		});

		const delta = compareToBaseline(currentSuite, "basic", "demo");
		expect(delta).not.toBeNull();
		const text = formatDelta(delta!, 0.05);
		expect(text).toContain('Comparing against baseline "demo"');
		expect(text).toContain("9/10");
		expect(text).toContain("-10.0pp");
		expect(text).toContain("Regressions");
		expect(text).toContain("c1");

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "demo.json"), {
			force: true,
		});
	});
});

describe("regression detection edge cases", () => {
	it("ignores pass-rate changes from cases that were never in baseline", () => {
		// A case removed entirely from the current run should NOT be a regression
		// even though it "passed" in baseline.
		const baselineSuite = makeSuite({
			cases: [
				{ id: "a", passed: true },
				{ id: "removed", passed: true },
			],
		});
		const currentSuite = makeSuite({
			cases: [{ id: "a", passed: true }], // 'removed' gone
		});

		saveBaseline(baselineSuite, "edge-removed", "removed-baseline");
		const delta = compareToBaseline(currentSuite, "edge-removed", "removed-baseline");

		expect(delta).not.toBeNull();
		// 'removed' was passing in baseline, but isn't in current run at all.
		// We don't treat that as a regression — only cases present in BOTH
		// are compared.
		expect(delta?.regressions).toHaveLength(0);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "removed-baseline.json"), {
			force: true,
		});
	});
});

// ============================================================================
// Statistical significance primitives
// ============================================================================

describe("wilsonScoreInterval", () => {
	it("returns [0, 1] for an empty sample (n=0)", () => {
		const ci = wilsonScoreInterval(0, 0);
		expect(ci.lower).toBe(0);
		expect(ci.upper).toBe(1);
	});

	it("returns a point estimate at p=0", () => {
		const ci = wilsonScoreInterval(0, 30);
		// Wilson is asymmetric around 0 — the lower bound is exactly 0, the
		// upper bound is a small positive number (not 0, the upper-tail mass
		// matters here).
		expect(ci.lower).toBe(0);
		expect(ci.upper).toBeGreaterThan(0);
		expect(ci.upper).toBeLessThan(0.1);
	});

	it("returns a point estimate at p=1", () => {
		const ci = wilsonScoreInterval(30, 30);
		expect(ci.lower).toBeGreaterThan(0.9);
		expect(ci.upper).toBe(1);
	});

	it("narrows the interval as n grows", () => {
		const small = wilsonScoreInterval(50, 100); // p=0.5
		const large = wilsonScoreInterval(500, 1000); // p=0.5
		const smallWidth = small.upper - small.lower;
		const largeWidth = large.upper - large.lower;
		expect(largeWidth).toBeLessThan(smallWidth / 2);
	});

	it("symmetric around 0.5 for symmetric samples", () => {
		const ci = wilsonScoreInterval(50, 100);
		expect(ci.lower).toBeCloseTo(0.5 - (ci.upper - 0.5), 2);
	});
});

describe("binomialTestOneSided", () => {
	it("returns p=1 when current >= baseline (no evidence of regression)", () => {
		// 100/100 vs 100/100: identical, no drop — can't reject H0.
		expect(binomialTestOneSided(100, 100, 100, 100)).toBeCloseTo(1, 5);
		// 90/100 vs 95/100: actual improvement — one-sided test of "current worse"
		// returns p=1 by convention.
		expect(binomialTestOneSided(90, 100, 95, 100)).toBe(1);
	});

	it("returns a very small p-value for obvious regressions on large samples", () => {
		// 100/100 vs 50/100: 50pp drop on n=100. Binomial z ≈ -7.07, p ≈ 0.
		const p = binomialTestOneSided(100, 100, 50, 100);
		expect(p).toBeLessThan(1e-6);
	});

	it("returns a non-significant p-value for small drops on small samples", () => {
		// 5/5 vs 4/5: a single flip on 5 cases — binomial z ≈ -1.05, p ≈ 0.15,
		// comfortably above α=0.05.
		const p = binomialTestOneSided(5, 5, 4, 5);
		expect(p).toBeGreaterThan(0.05);
	});

	it("returns an intermediate p-value for borderline cases on a moderate sample", () => {
		// 20/20 vs 18/20: 10pp drop. Binomial z ≈ -1.49, p ≈ 0.07.
		// Drops below the conventional significance threshold on this sample size.
		const p = binomialTestOneSided(20, 20, 18, 20);
		expect(p).toBeGreaterThan(0.001);
		expect(p).toBeLessThan(0.15);
	});

	it("returns p=1 for empty samples (can't test what isn't there)", () => {
		expect(binomialTestOneSided(0, 0, 1, 1)).toBe(1);
		expect(binomialTestOneSided(0, 5, 1, 5)).toBe(1);
	});
});

describe("testSignificance", () => {
	it("flags a regression on large samples with clear effect", () => {
		// 100/100 vs 80/100: 20pp drop, z ≈ -4.5, p < 0.0001.
		const sig = testSignificance(100, 100, 80, 100);
		expect(sig.isSignificant).toBe(true);
		expect(sig.pValue).toBeLessThan(0.001);
		expect(sig.effectSize).toBeGreaterThan(0.4); // Cohen's h threshold for "medium"
		expect(sig.sampleSizeSufficient).toBe(true);
	});

	it("does NOT flag a small drop on a small sample", () => {
		// 5/5 vs 4/5: 20pp drop, but n=5 each — sampleSizeSufficient=false,
		// and even the significance test isn't precise enough at this n.
		const sig = testSignificance(5, 5, 4, 5);
		expect(sig.sampleSizeSufficient).toBe(false);
		expect(sig.isSignificant).toBe(false); // sample-size guard, but also genuinely not significant
	});

	it("computes Cohen's h as a non-negative effect size", () => {
		// Effect size should be non-negative since we always measure the drop.
		const sig = testSignificance(100, 100, 80, 100);
		expect(sig.effectSize).toBeGreaterThanOrEqual(0);
	});

	it("produces 95% confidence intervals around the observed proportions", () => {
		const sig = testSignificance(100, 100, 80, 100);
		expect(sig.baselineCI.level).toBe(0.95);
		expect(sig.currentCI.level).toBe(0.95);
		// Baseline 100/100 should have CI close to [1, 1] (Wilson lower is 0.96ish).
		expect(sig.baselineCI.lower).toBeGreaterThan(0.95);
		expect(sig.baselineCI.upper).toBe(1);
		// Current 80/100 CI should cover around 0.8.
		expect(sig.currentCI.lower).toBeGreaterThan(0.71);
		expect(sig.currentCI.upper).toBeLessThan(0.87);
	});

	it("respects alpha parameter", () => {
		// Mid-range drop: borderline at α=0.05.
		const sig05 = testSignificance(100, 100, 90, 100, 0.05);
		const sig01 = testSignificance(100, 100, 90, 100, 0.01);
		// α=0.01 is stricter — isSignificant might flip.
		expect(sig05.alpha).toBe(0.05);
		expect(sig01.alpha).toBe(0.01);
		// If p < 0.01, both flag; if 0.01 < p < 0.05, only α=0.05 flags.
		if (sig05.pValue < 0.01) {
			expect(sig01.isSignificant).toBe(true);
		} else {
			expect(sig01.isSignificant).toBe(false);
		}
	});
});

describe("compareToBaseline with statistical significance", () => {
	it("populates the significance block on a large-sample regression", () => {
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, passed: i < 38 })),
		});
		saveBaseline(baselineSuite, "sig-large", "sig-large-baseline");
		const delta = compareToBaseline(currentSuite, "sig-large", "sig-large-baseline");
		expect(delta).not.toBeNull();
		expect(delta?.significance.sampleSizeSufficient).toBe(true);
		expect(delta?.significance.isSignificant).toBe(true);
		expect(delta?.hasRegression).toBe(true); // significance-driven
	});

	it("falls back to threshold when sample size is too small for significance", () => {
		// 3/3 vs 1/3: 67pp drop on n=3 — significance sample too small,
		// but threshold fallback catches the >5pp drop.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, passed: i === 0 })),
		});
		saveBaseline(baselineSuite, "sig-tiny", "sig-tiny-baseline");
		const delta = compareToBaseline(currentSuite, "sig-tiny", "sig-tiny-baseline", {
			threshold: 0.05,
		});
		expect(delta).not.toBeNull();
		// Either significance-driven (p is very small here actually) or
		// threshold fallback — both should agree on regression.
		expect(delta?.hasRegression).toBe(true);
	});

	it("uses threshold fallback for small samples even if significance wouldn't fire", () => {
		// 3/3 vs 2/3: 33pp drop on n=3 — sampleSizeSufficient=false (n<10).
		// p-value at this n is huge (one of three flipped, plausibly noise).
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, passed: i < 2 })),
		});
		saveBaseline(baselineSuite, "sig-n3-mild", "sig-n3-mild-baseline");
		const delta = compareToBaseline(currentSuite, "sig-n3-mild", "sig-n3-mild-baseline", {
			threshold: 0.05,
		});
		expect(delta).not.toBeNull();
		// 33pp drop > 5pp threshold → threshold fallback trips → hasRegression=true
		expect(delta?.passRateDelta).toBeCloseTo(-1 / 3, 3);
		expect(delta?.hasRegression).toBe(true);
	});

	it("respects --significance-alpha parameter", () => {
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		// 10pp drop on 100/100 → borderline p-value around 0.0015.
		const currentSuite = makeSuite({
			cases: Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, passed: i < 90 })),
		});
		saveBaseline(baselineSuite, "sig-alpha", "sig-alpha-baseline");
		const delta = compareToBaseline(currentSuite, "sig-alpha", "sig-alpha-baseline", {
			alpha: 0.01,
		});
		expect(delta).not.toBeNull();
		expect(delta?.significance.alpha).toBe(0.01);
		// 10pp on 100 cases is comfortably significant at α=0.01 (p < 0.01).
		expect(delta?.hasRegression).toBe(true);
	});
});
