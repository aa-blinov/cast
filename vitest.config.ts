import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/setup.ts"],
		testTimeout: 30_000,
		// openai -> node-fetch -> whatwg-url pulls in Node's deprecated builtin
		// punycode module; nothing in this repo requires it directly, so the
		// warning is just noise on every test run.
		env: { NODE_OPTIONS: "--no-deprecation" },
		coverage: {
			provider: "v8",
			reporter: ["text", "text-summary", "html", "lcov", "json-summary"],
			// Reports show every TS/TSX under src/. Excluded: type-only files,
			// the bundled web assets under src/server/public/ (they ship as the
			// built web bundle, tested by Playwright separately), and any
			// throwaway directories test fixtures create.
			include: ["src/**/*.ts", "src/**/*.tsx"],
			exclude: ["src/**/*.d.ts", "src/server/public/**", "src/**/__test_tmp__/**"],
			// Project-wide floors. The current baseline (2026-09-11) is
			// 73.99% lines / 78.65% branches / 88.25% functions; these
			// thresholds sit ~4pp below that to give normal churn some
			// slack while still failing any meaningful regression. The
			// per-file floor that catches "one module lost 20 points"
			// is a separate check (scripts/check-coverage-floor.mjs) —
			// vitest's perFile gate would only be sensible if every
			// source file had the same target, and the UI layer (tested
			// via Playwright) and the CLI entry (tested via e2e) can't
			// reasonably share a floor with the core/.
			thresholds: {
				perFile: false,
				lines: 70,
				branches: 75,
				functions: 85,
				statements: 70,
			},
		},
	},
});
