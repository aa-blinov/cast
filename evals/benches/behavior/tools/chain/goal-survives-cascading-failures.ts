import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-goal-cascade";

/**
 * The hard case for a durable goal: the work cannot be seen from the start.
 *
 * A first attempt at this case failed for a good reason — the model read
 * `check.sh`, saw all of its conditions at once, and satisfied them in a
 * single write, which is the better strategy and not something to grade
 * against. So the later stages are no longer readable ahead of time: the
 * script mints a random token on its first successful stage and only then
 * demands that the config carry it. Nothing but running the script, reacting,
 * and running it again gets there.
 *
 * The grade comes from the script's own success marker, not from anything the
 * model says about it.
 */
const CHECK_SCRIPT = `#!/bin/sh
dir=$(dirname "$0")
if [ ! -f "$dir/config.env" ]; then
  echo "FAIL: config.env is missing. Create it."
  exit 1
fi
if [ ! -f "$dir/.token" ]; then
  head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \\n' > "$dir/.token"
fi
token=$(cat "$dir/.token")
if ! grep -q "^TOKEN=$token\\$" "$dir/config.env"; then
  echo "FAIL: config.env must contain the line TOKEN=$token"
  exit 1
fi
if [ ! -f "$dir/stage2.done" ]; then
  echo "FAIL: the second stage has not run. Run: sh $dir/stage2.sh"
  exit 1
fi
echo ok > "$dir/passed"
echo "OK: all checks pass"
`;

const STAGE2_SCRIPT = `#!/bin/sh
dir=$(dirname "$0")
if ! grep -q '^ENV=production$' "$dir/config.env"; then
  echo "FAIL: stage 2 needs config.env to set ENV=production"
  exit 1
fi
echo done > "$dir/stage2.done"
echo "stage 2 complete"
`;

export const goalSurvivesCascadingFailures: EvalCase = {
	id: "goal-survives-cascading-failures",
	description: "A goal keeps a run going through failures that only appear one at a time.",
	signals: ["state-persistence", "tool-error-recovery", "tool-chain"],
	timeout: 300_000,
	setup: () =>
		void writeFixture(FIXTURE_ID, {
			"check.sh": CHECK_SCRIPT,
			"stage2.sh": STAGE2_SCRIPT,
			"README.md": "Run check.sh. It must print OK.\n",
		}),
	cwd: fixtureDir(FIXTURE_ID),
	goal: {
		objective: `\`sh ${fixturePath(FIXTURE_ID, "check.sh")}\` must exit 0 and print "OK: all checks pass".`,
		maxContinuations: 6,
	},
	prompt: `Run \`sh ${fixturePath(FIXTURE_ID, "check.sh")}\` and fix the first failure it reports.`,
	expect: {
		noErrors: true,
		verify: ({ goal }) => {
			// The marker is written by check.sh itself, so it can only exist if
			// the real script actually reached its success path.
			let passed = "";
			try {
				passed = readFileSync(fixturePath(FIXTURE_ID, "passed"), "utf-8");
			} catch {
				return "check.sh never reached its success path — the marker file it writes is missing";
			}
			if (!passed.includes("ok")) return "the marker file exists but check.sh did not write its success line";
			const config = readFileSync(fixturePath(FIXTURE_ID, "config.env"), "utf-8");
			const token = readFileSync(fixturePath(FIXTURE_ID, ".token"), "utf-8").trim();
			if (!config.includes(`TOKEN=${token}`)) return "config.env does not carry the token the script minted";
			if (!config.includes("ENV=production")) return "config.env is missing ENV=production";
			if (goal?.status !== "complete") return `goal was left ${goal?.status ?? "missing"} instead of complete`;
			return undefined;
		},
	},
};
