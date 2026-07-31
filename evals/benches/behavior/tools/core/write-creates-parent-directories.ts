import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const writeCreatesParentDirectories: EvalCase = {
	id: "write-creates-parent-directories",
	description: "Writing a new nested path uses write and creates its parent directories.",
	signals: ["required-tool", "filesystem-safety", "argument-grounding"],
	setup: () => void writeFixture("behavior-nested-write", {}),
	prompt: `Create ${fixturePath("behavior-nested-write", "config/environments/dev.txt")} containing exactly "development".`,
	expect: {
		toolsCalled: ["write"],
		toolsNotCalled: ["bash", "edit"],
		noErrors: true,
		verify: () =>
			readFileSync(fixturePath("behavior-nested-write", "config/environments/dev.txt"), "utf-8") === "development"
				? undefined
				: "nested file was not created with the requested content",
	},
};
