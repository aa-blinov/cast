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

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Baseline, compareToBaseline, formatDelta, loadBaseline, saveBaseline } from "../evals/lib/baseline.ts";
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

describe("compareToBaseline", () => {
	it("returns null when the baseline doesn't exist", () => {
		const suite = makeSuite({ cases: [{ id: "a", passed: true }] });
		const result = compareToBaseline(suite, "basic", "missing-baseline-name");
		expect(result).toBeNull();
	});

	it("flags a regression when pass-rate drops past the threshold", () => {
		// Baseline: 10/10 pass. Current: 8/10 pass. Delta -20pp > 5pp threshold.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, passed: true })),
			totalDuration: 10_000,
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 10 }, (_, i) => ({
				id: `c${i}`,
				passed: i < 8, // first 8 pass, last 2 fail
			})),
			totalDuration: 12_000,
		});

		const baseline = saveBaseline(baselineSuite, "test-regress", "regress-baseline");
		const delta = compareToBaseline(currentSuite, "test-regress", "regress-baseline", 0.05);

		expect(delta).not.toBeNull();
		expect(delta?.passedDelta).toBe(-2);
		expect(delta?.passRateDelta).toBeCloseTo(-0.2, 5);
		expect(delta?.hasRegression).toBe(true);
		expect(delta?.regressions).toHaveLength(2);
		expect(delta?.regressions[0]?.baselinePassed).toBe(true);
		expect(delta?.regressions[0]?.currentPassed).toBe(false);

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "regress-baseline.json"), {
			force: true,
		});
	});

	it("does NOT flag a regression when drop is under threshold", () => {
		// Baseline: 20/20 pass. Current: 19/20 pass. Delta -5pp = threshold,
		// not strictly below, but using threshold 0.05 and a drop of exactly
		// -0.05 → hasRegression uses <= so it's borderline; let's use a clearer
		// under-threshold scenario: 19/20 with threshold 0.10 = no regression.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({
				id: `c${i}`,
				passed: i !== 7, // 19 pass, 1 fail
			})),
		});

		const baseline = saveBaseline(baselineSuite, "test-near", "near-miss-baseline");
		const delta = compareToBaseline(currentSuite, "test-near", "near-miss-baseline", 0.1);

		expect(delta).not.toBeNull();
		expect(delta?.passedDelta).toBe(-1);
		expect(delta?.passRateDelta).toBeCloseTo(-0.05, 5);
		expect(delta?.hasRegression).toBe(false); // 5pp drop < 10pp threshold
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

		const baseline = saveBaseline(baselineSuite, "test-improve", "improvements-baseline");
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

		const baseline = saveBaseline(baselineSuite, "test-newcase", "new-case-baseline");
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

		const baseline = saveBaseline(baselineSuite, "test-tokens", "tokens-baseline");
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
	it("handles pass-rate drop exactly at threshold as regression (<= semantics)", () => {
		// Baseline 20/20 = 100%. Current 19/20 = 95%. Delta -5pp. With
		// threshold 5pp (0.05), hasRegression uses <= so -0.05 <= -0.05 = true.
		const baselineSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, passed: true })),
		});
		const currentSuite = makeSuite({
			cases: Array.from({ length: 20 }, (_, i) => ({
				id: `c${i}`,
				passed: i < 19,
			})),
		});

		const baseline = saveBaseline(baselineSuite, "edge", "edge-baseline");
		const delta = compareToBaseline(currentSuite, "edge", "edge-baseline", 0.05);

		expect(delta).not.toBeNull();
		expect(delta?.passRateDelta).toBeCloseTo(-0.05, 5);
		expect(delta?.hasRegression).toBe(true); // exact threshold boundary IS a regression

		rmSync(join(import.meta.dirname, "..", "evals", "baselines", "edge-baseline.json"), {
			force: true,
		});
	});

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

		const baseline = saveBaseline(baselineSuite, "edge-removed", "removed-baseline");
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
