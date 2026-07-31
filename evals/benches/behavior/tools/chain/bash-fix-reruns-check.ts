import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const bashFixRerunsCheck: EvalCase = {
	id: "bash-fix-reruns-check",
	description: "An execution failure is investigated, fixed, and verified by rerunning the same check.",
	signals: ["tool-chain", "tool-error-recovery", "filesystem-safety"],
	setup: () =>
		void writeFixture("behavior-bash-fix", {
			"calc.js": "exports.sum = (a, b) => a - b;\n",
			"check.js": "const { sum } = require('./calc.js');\nif (sum(2, 3) !== 5) process.exit(1);\n",
		}),
	prompt: `The check in ${fixtureDir("behavior-bash-fix")} is failing. Diagnose the cause, correct the implementation, and verify that the check passes afterward.`,
	expect: {
		toolCallCounts: { bash: 2, edit: 1 },
		toolsCalled: ["read"],
		noErrors: true,
		verify: () =>
			readFileSync(fixturePath("behavior-bash-fix", "calc.js"), "utf-8") === "exports.sum = (a, b) => a + b;\n"
				? undefined
				: "calculation bug was not corrected exactly",
	},
};
