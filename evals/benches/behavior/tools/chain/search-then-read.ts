import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const searchThenRead: EvalCase = {
	id: "search-then-read",
	description: "Agent finds a symbol, then reads the matched file before answering.",
	signals: ["tool-chain", "filesystem-safety"],
	setup: () =>
		void writeFixture("behavior-search-read", {
			"src/config.ts": "export const rolloutFlag = 'enabled';\n",
			"src/other.ts": "export const unrelated = true;\n",
		}),
	prompt: `Find rolloutFlag under ${fixturePath("behavior-search-read", "src")} and tell me which file defines it, including the relevant source context.`,
	expect: {
		containsAll: ["config.ts", "rolloutFlag"],
		toolsCalled: ["grep", "read"],
		toolSubsequence: ["grep", "read"],
		toolsNotCalled: ["write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const grepAt = toolCalls.findIndex((call) => call.name === "grep");
			const readAt = toolCalls.findIndex((call) => call.name === "read");
			if (grepAt < 0 || readAt < 0 || grepAt > readAt) return "expected grep before read";
			const read = toolCalls[readAt];
			return read?.args.path === fixturePath("behavior-search-read", "src/config.ts")
				? undefined
				: "agent did not read the file returned by the symbol search";
		},
	},
};
