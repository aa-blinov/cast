import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const readErrorThenRecover: EvalCase = {
	id: "read-error-then-recover",
	description: "A failed read is followed by the requested valid alternative.",
	signals: ["tool-error-recovery", "tool-chain"],
	setup: () => void writeFixture("behavior-read-recover", { "available.txt": "available\n" }),
	prompt: `The expected record may be missing at ${fixturePath("behavior-read-recover", "missing.txt")}. Investigate and, if needed, use ${fixturePath("behavior-read-recover", "available.txt")} as the fallback.`,
	expect: {
		toolCallCounts: { read: 2 },
		noErrors: true,
		verify: ({ toolCalls }) => {
			const paths = toolCalls.filter((call) => call.name === "read").map((call) => call.args.path);
			return paths[0] === fixturePath("behavior-read-recover", "missing.txt") &&
				paths[1] === fixturePath("behavior-read-recover", "available.txt")
				? undefined
				: "read recovery did not follow the requested failing-then-valid path sequence";
		},
	},
};
