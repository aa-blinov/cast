import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 10_000,
		// openai -> node-fetch -> whatwg-url pulls in Node's deprecated builtin
		// punycode module; nothing in this repo requires it directly, so the
		// warning is just noise on every test run.
		env: { NODE_OPTIONS: "--no-deprecation" },
	},
});
