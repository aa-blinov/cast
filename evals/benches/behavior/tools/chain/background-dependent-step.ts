import { existsSync, readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-bg-dependent";

export const backgroundDependentStep: EvalCase = {
	id: "background-dependent-step",
	description:
		"The next step needs a long command's output: the model waits for the moved command and uses what it printed, instead of guessing or running it again.",
	signals: ["background-lifecycle", "tool-result-integrity"],
	cwd: fixtureDir(PROJECT),
	timeout: 200_000,
	setup: () => void writeFixture(PROJECT, { "readme.txt": "placeholder\n" }),
	prompt: "Run `sleep 64 && printf build-id-7781` and save exactly what it printed into a file named build.txt here.",
	expect: {
		toolsCalled: ["bash"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const runs = toolCalls.filter((c) => c.name === "bash" && String(c.args.command).includes("sleep 64"));
			if (runs.length !== 1) return `the command was started ${runs.length} times, not once`;
			const path = fixturePath(PROJECT, "build.txt");
			if (!existsSync(path)) return "build.txt was not written";
			return readFileSync(path, "utf-8").trim() === "build-id-7781"
				? undefined
				: "build.txt does not hold what the command printed";
		},
	},
};
