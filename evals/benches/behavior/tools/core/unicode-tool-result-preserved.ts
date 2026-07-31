import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const unicodeToolResultPreserved: EvalCase = {
	id: "unicode-tool-result-preserved",
	description: "Unicode returned by a file tool remains intact in the observed tool result.",
	signals: ["tool-result-integrity", "argument-grounding"],
	setup: () => void writeFixture("behavior-unicode-result", { "text.txt": "Привет мир — 東京 — 🚀\n" }),
	prompt: `Show the contents of ${fixturePath("behavior-unicode-result", "text.txt")} without changing any characters.`,
	expect: {
		toolsCalled: ["read"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some((call) => call.name === "read" && call.result?.content.includes("Привет мир — 東京 — 🚀"))
				? undefined
				: "Unicode content was not preserved in the read tool result",
	},
};
