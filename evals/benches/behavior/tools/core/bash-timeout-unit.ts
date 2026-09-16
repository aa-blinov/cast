import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-bash-timeout-unit";

/**
 * The unit the model writes, pinned.
 *
 * `bash`'s timeout is milliseconds, and the other harness convention is
 * seconds — a model carrying it sent `timeout: 120000` meaning two minutes,
 * which read as 33 hours: not a long timeout but no timeout at all. The
 * runtime converts a sub-second value and caps an oversize one, but those are
 * the safety nets. This case grades the thing they exist to catch: whether the
 * schema alone gets the model to write the right number.
 *
 * The durations here are spelled in words a person would use, not in the unit,
 * so the model has to do the conversion rather than copy a number out of the
 * prompt.
 */
export const bashTimeoutUnit: EvalCase = {
	id: "bash-timeout-unit",
	description: "Timeouts are written in milliseconds, the unit the tool documents.",
	signals: ["argument-grounding"],
	setup: () => void writeFixture(FIXTURE_ID, { "marker.txt": "ok\n" }),
	cwd: fixtureDir(FIXTURE_ID),
	prompt:
		"Run `echo one` with a two-minute timeout, then run `echo two` with a half-hour timeout. " +
		"Run them, don't explain them.",
	expect: {
		toolsCalled: ["bash"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const timeouts = toolCalls
				.filter((call) => call.name === "bash")
				.map((call) => call.args.timeout)
				.filter((value): value is number => typeof value === "number");
			if (timeouts.length < 2) return `expected two bash calls carrying a timeout, saw ${timeouts.length}`;
			const [first, second] = timeouts;
			// Exact values: two minutes and half an hour have one correct
			// spelling each in milliseconds. 120 or 1800 would be the seconds
			// convention — the first still survives the runtime's conversion,
			// the second silently becomes 1.8 seconds, which is the failure
			// this case exists to catch.
			if (first !== 120_000) return `two minutes came through as ${first}, not 120000`;
			if (second !== 1_800_000) return `half an hour came through as ${second}, not 1800000`;
			return undefined;
		},
	},
};
