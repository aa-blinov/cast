#!/usr/bin/env node
/**
 * Per-file coverage floor check.
 *
 * Reads coverage/coverage-summary.json (written by @vitest/coverage-v8 with
 * the json-summary reporter) and compares each tracked file's current
 * line coverage against the floor stored in coverage-baseline.json.
 *
 * Fails the build with a clear "file X dropped from Y% to Z%" message if
 * any file's coverage fell below its committed baseline — the ratchet is
 * one-directional: floors only go up, never down, and they're raised in
 * the same PR that adds the new tests.
 *
 * Files not listed in the baseline are not checked (UI components tested
 * via Playwright, CLI entry points tested via e2e, brand-new files). To
 * add a new tracked file, run `scripts/sync-coverage-baseline.mjs`.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const summaryPath = resolve(repoRoot, "coverage/coverage-summary.json");
const baselinePath = resolve(repoRoot, "coverage-baseline.json");

if (!existsSync(summaryPath)) {
	console.error(`[coverage-floor] ${summaryPath} not found. Run \`npm run coverage\` first.`);
	process.exit(2);
}
if (!existsSync(baselinePath)) {
	console.error(`[coverage-floor] ${baselinePath} not found. Create it with \`node scripts/sync-coverage-baseline.mjs\`.`);
	process.exit(2);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));

// The summary is keyed by absolute paths from the current runner; the
// baseline is keyed by repo-relative paths so it doesn't change between
// machines. Build a lookup of relative→current once.
const currentByRelative = new Map();
for (const [absPath, entry] of Object.entries(summary)) {
	if (absPath === "total") continue;
	const rel = absPath.startsWith(repoRoot) ? absPath.slice(repoRoot.length + 1) : absPath;
	currentByRelative.set(rel, entry);
}

const drops = [];
for (const [filePath, baselineEntry] of Object.entries(baseline.files ?? {})) {
	const current = currentByRelative.get(filePath);
	if (!current) {
		drops.push({ filePath, baselineLines: baselineEntry.lines, currentLines: null, reason: "missing from current report" });
		continue;
	}
	const baselineLines = baselineEntry.lines ?? 0;
	const currentLines = current.lines?.pct ?? 0;
	if (currentLines + 1e-9 < baselineLines) {
		drops.push({
			filePath,
			baselineLines: baselineLines.toFixed(2),
			currentLines: currentLines.toFixed(2),
			reason: `lines dropped ${(baselineLines - currentLines).toFixed(2)}pp`,
		});
	}
}

if (drops.length === 0) {
	console.log(`[coverage-floor] ${Object.keys(baseline.files ?? {}).length} files at or above their committed baseline.`);
	process.exit(0);
}

console.error(`[coverage-floor] ${drops.length} file(s) regressed below their committed baseline:`);
for (const drop of drops) {
	console.error(`  - ${drop.filePath}: baseline ${drop.baselineLines}% → current ${drop.currentLines ?? drop.reason}`);
}
console.error("[coverage-floor] Raise coverage back to baseline in this PR, or update baseline with `node scripts/sync-coverage-baseline.mjs` if a tracked file is being deleted or restructured.");
process.exit(1);
