import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-goal-continues";

/**
 * The durable goal's whole point: where a turn would end, an open goal pushes
 * the run forward instead of handing control back. Three files each need the
 * same one-word fix, and the prompt only asks for the first — a run without the
 * goal stops after that file, a run under the goal keeps going to the other
 * two and then closes the goal itself.
 */
export const goalContinuesPastFirstStop: EvalCase = {
	id: "goal-continues-past-first-stop",
	description: "An open goal continues the run past the point the prompt alone would have ended it.",
	signals: ["state-persistence", "tool-chain"],
	timeout: 180_000,
	setup: () =>
		void writeFixture(FIXTURE_ID, {
			"alpha.txt": "status: PENDING\n",
			"beta.txt": "status: PENDING\n",
			"gamma.txt": "status: PENDING\n",
		}),
	cwd: fixtureDir(FIXTURE_ID),
	goal: { objective: `Every .txt file in ${fixtureDir(FIXTURE_ID)} must read "status: READY".`, maxContinuations: 4 },
	prompt: `Set the status in ${fixturePath(FIXTURE_ID, "alpha.txt")} to READY.`,
	expect: {
		noErrors: true,
		verify: ({ goal }) => {
			const stillPending = ["alpha.txt", "beta.txt", "gamma.txt"].filter(
				(name) => !readFileSync(fixturePath(FIXTURE_ID, name), "utf-8").includes("READY"),
			);
			if (stillPending.length > 0) return `still PENDING after the goal ran: ${stillPending.join(", ")}`;
			// Finishing the work is half of it; the goal must also be closed
			// deliberately rather than left open for the next turn to inherit.
			if (goal?.status !== "complete") return `goal was left ${goal?.status ?? "missing"} instead of complete`;
			return undefined;
		},
	},
};
