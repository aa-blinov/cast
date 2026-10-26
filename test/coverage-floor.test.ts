import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("coverage floor check", () => {
	it("matches Windows-style report separators to the portable baseline paths", () => {
		const repo = mkdtempSync(join(tmpdir(), "cast-coverage-floor-"));
		try {
			const scripts = join(repo, "scripts");
			const coverage = join(repo, "coverage");
			mkdirSync(scripts);
			mkdirSync(coverage);
			const canonicalRepo = realpathSync(repo);
			writeFileSync(
				join(scripts, "check-coverage-floor.mjs"),
				readFileSync(new URL("../scripts/check-coverage-floor.mjs", import.meta.url)),
			);
			writeFileSync(
				join(coverage, "coverage-summary.json"),
				JSON.stringify({
					total: {},
					[`${canonicalRepo}\\src\\core\\example.ts`]: { lines: { pct: 100 } },
				}),
			);
			writeFileSync(
				join(repo, "coverage-baseline.json"),
				JSON.stringify({ files: { "src/core/example.ts": { lines: 90 } } }),
			);

			const result = spawnSync(process.execPath, [join(scripts, "check-coverage-floor.mjs")], {
				encoding: "utf-8",
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toContain("1 files at or above their committed baseline");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});
