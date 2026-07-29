import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// 10s used to be enough, but genuinely-fast tests (plain file writes,
		// no real I/O beyond a temp dir) started timing out under nothing more
		// than ordinary CPU contention from another process on the same
		// machine — the work itself takes milliseconds; the failure was purely
		// event-loop starvation, not a slow test. 20s gives real headroom
		// without masking an actual hang (the two deliberately CPU-heavy real
		// jpeg-encode tests already carry their own higher per-test timeout).
		testTimeout: 20_000,
		// openai -> node-fetch -> whatwg-url pulls in Node's deprecated builtin
		// punycode module; nothing in this repo requires it directly, so the
		// warning is just noise on every test run.
		env: { NODE_OPTIONS: "--no-deprecation" },
	},
});
