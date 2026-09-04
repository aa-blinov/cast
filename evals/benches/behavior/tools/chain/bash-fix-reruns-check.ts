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
		noErrors: true,
		verify: ({ toolCalls }) => {
			if (readFileSync(fixturePath("behavior-bash-fix", "calc.js"), "utf-8") !== "exports.sum = (a, b) => a + b;\n") {
				return "calculation bug was not corrected exactly";
			}
			const mutation = toolCalls.findIndex((call) => call.name === "edit" || call.name === "write");
			// The check has to actually be executed, not merely read. `isError` alone
			// can't decide that: a command like `node check.js; echo "exit=$?"` exits 0
			// while faithfully reporting the failure, and `node check.js || true` does
			// the same — so the run is identified by the command and its verdict by the
			// output (or exit status) it produced.
			const ranCheck = (call: (typeof toolCalls)[number]) =>
				call.name === "bash" && typeof call.args?.command === "string" && call.args.command.includes("check.js");
			const reportedFailure = (call: (typeof toolCalls)[number]) =>
				call.result?.isError === true || /exit[=: ]*[1-9]|Error|not ok|FAIL/i.test(call.result?.content ?? "");
			const failedCheck = toolCalls.findIndex((call) => ranCheck(call) && reportedFailure(call));
			const verifiedCheck = toolCalls.findIndex(
				(call, index) => index > mutation && ranCheck(call) && !reportedFailure(call),
			);
			return failedCheck >= 0 && failedCheck < mutation && verifiedCheck >= 0
				? undefined
				: "the failing check was not rerun successfully after the implementation changed";
		},
	},
};
