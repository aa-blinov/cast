import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const knownPathSkipsSearch: EvalCase = {
	id: "known-path-skips-search",
	description: "A fully specified path is read directly without preliminary discovery calls.",
	signals: ["required-tool", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-known-path", { "known.txt": "direct\n" }),
	prompt: `What does ${fixturePath("behavior-known-path", "known.txt")} contain?`,
	expect: {
		toolsCalled: ["read"],
		toolsNotCalled: ["glob", "grep", "ls", "bash", "write", "edit"],
		noErrors: true,
	},
};
