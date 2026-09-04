import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const bashFixRerunsCheck: EvalCase = {
	id: "bash-fix-reruns-check",
	description: "An execution failure is diagnosed from the source, fixed, and verified by rerunning the same check.",
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
			if (
				readFileSync(fixturePath("behavior-bash-fix", "calc.js"), "utf-8") !== "exports.sum = (a, b) => a + b;\n"
			) {
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
			const verifiedCheck = toolCalls.findIndex(
				(call, index) => index > mutation && ranCheck(call) && !reportedFailure(call),
			);
			if (verifiedCheck < 0) {
				return "the check was not rerun successfully after the implementation changed";
			}
			// Reproducing the failure first is no longer required here. The bug is a
			// single-line operator inversion that calc.js and check.js settle between
			// them, and verification-discipline.md exempts exactly that: one possible
			// cause, nameable from what was read. What stays mandatory is grounding
			// the diagnosis in the source rather than guessing, and rerunning the
			// check afterwards — a run before the fix is accepted, not demanded.
			const readBothFiles = ["calc.js", "check.js"].every((name) =>
				toolCalls.some((call) => call.name === "read" && String(call.args?.path ?? "").endsWith(name)),
			);
			return readBothFiles ? undefined : "the fix was not grounded in reading the implementation and its check";
		},
	},
};
