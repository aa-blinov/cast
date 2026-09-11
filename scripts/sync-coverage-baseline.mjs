#!/usr/bin/env node
/**
 * Regenerate coverage-baseline.json from coverage/coverage-summary.json.
 *
 * Use this when:
 *   - bootstrapping coverage for the first time,
 *   - adding a new tracked file to the per-file floor check (commit
 *     coverage-baseline.json after editing it manually to include the
 *     new file's path and current %),
 *   - intentionally raising floors across the project (run tests, then
 *     this script, then commit).
 *
 * Reads coverage/coverage-summary.json (produced by `npm run coverage`)
 * and writes coverage-baseline.json containing one entry per file under
 * src/. Files below the global threshold (currently 70% lines) are
 * excluded — they can't be floored honestly until coverage improves.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const summaryPath = resolve(repoRoot, "coverage/coverage-summary.json");
const baselinePath = resolve(repoRoot, "coverage-baseline.json");
const MIN_LINES_TO_TRACK = 70;

if (!existsSync(summaryPath)) {
	console.error(`[sync-baseline] ${summaryPath} not found. Run \`npm run coverage\` first.`);
	process.exit(2);
}

const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
const files = {};
let skipped = 0;
for (const [absPath, entry] of Object.entries(summary)) {
	if (absPath === "total") continue;
	// v8 coverage reports absolute paths from wherever the runner
	// happened to be; CI runs in different checkouts than local
	// machines, so store paths relative to the repo root.
	const filePath = absPath.startsWith(repoRoot) ? absPath.slice(repoRoot.length + 1) : absPath;
	const lines = entry.lines?.pct ?? 0;
	if (lines + 1e-9 < MIN_LINES_TO_TRACK) {
		skipped++;
		continue;
	}
	files[filePath] = {
		lines: Number(lines.toFixed(2)),
		branches: Number((entry.branches?.pct ?? 0).toFixed(2)),
		functions: Number((entry.functions?.pct ?? 0).toFixed(2)),
		statements: Number((entry.statements?.pct ?? 0).toFixed(2)),
	};
}

const baseline = {
	// Bump this whenever floors are intentionally raised, so a re-run
	// can show "raised on date X" in PRs that touch this file.
	generatedAt: new Date().toISOString(),
	minLinesToTrack: MIN_LINES_TO_TRACK,
	files,
};

writeFileSync(baselinePath, `${JSON.stringify(baseline, null, "\t")}\n`);
const tracked = Object.keys(files).length;
console.log(`[sync-baseline] wrote ${tracked} tracked file(s) to ${baselinePath} (${skipped} skipped below ${MIN_LINES_TO_TRACK}% lines).`);
