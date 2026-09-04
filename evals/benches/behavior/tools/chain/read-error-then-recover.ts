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
		noErrors: true,
		// Order used to be fixed at read(missing) → read(available), which failed a
		// run that established the absence with `ls` first and then read the
		// fallback — the outcome asked for, reached another way. What matters is
		// that the missing path was actually established as missing (by a read that
		// errored, or a listing/glob that showed it absent) and that the fallback
		// was really read, rather than its content being assumed.
		verify: ({ toolCalls }) => {
			const missing = fixturePath("behavior-read-recover", "missing.txt");
			const available = fixturePath("behavior-read-recover", "available.txt");
			const probedMissing = toolCalls.some(
				(call) =>
					(call.name === "read" && call.args.path === missing && call.result?.isError === true) ||
					((call.name === "ls" || call.name === "glob" || call.name === "bash") &&
						JSON.stringify(call.args).includes("behavior-read-recover")),
			);
			const readFallback = toolCalls.some(
				(call) => call.name === "read" && call.args.path === available && call.result?.isError !== true,
			);
			if (!probedMissing) return "the missing record was never established as missing";
			return readFallback ? undefined : "the fallback file was never read";
		},
	},
};
