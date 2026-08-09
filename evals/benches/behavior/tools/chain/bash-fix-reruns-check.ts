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
		toolsCalled: ["bash", "read"],
		toolsCalled: ["read"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			if (readFileSync(fixturePath("behavior-bash-fix", "calc.js"), "utf-8") !== "exports.sum = (a, b) => a + b;\n") {
				return "calculation bug was not corrected exactly";
			}
			const mutation = toolCalls.findIndex((call) => call.name === "edit" || call.name === "write");
			const failedCheck = toolCalls.findIndex((call) => call.name === "bash" && call.result?.isError === true);
			const verifiedCheck = toolCalls.findIndex(
				(call, index) => index > mutation && call.name === "bash" && call.result?.isError !== true,
			);
			return failedCheck >= 0 && failedCheck < mutation && verifiedCheck >= 0
				? undefined
				: "the failing check was not rerun successfully after the implementation changed";
		},
	},
};
