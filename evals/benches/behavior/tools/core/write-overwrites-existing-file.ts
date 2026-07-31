import { readFileSync } from "node:fs";
import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const writeOverwritesExistingFile: EvalCase = {
	id: "write-overwrites-existing-file",
	description: "A full-content replacement request uses write on an existing file instead of a surgical edit.",
	signals: ["required-tool", "argument-grounding"],
	setup: () => void writeFixture("behavior-write-overwrite", { "notes.txt": "old: draft notes\nline2: keep nothing\n" }),
	// write's own tool description explicitly covers this: "Create a new file
	// or overwrite an entire file" — a full-content replacement is its
	// intended use, distinct from edit's surgical oldString/newString.
	prompt: `Replace the entire contents of ${fixturePath("behavior-write-overwrite", "notes.txt")} with exactly "final release notes".`,
	expect: {
		toolsCalled: ["write"],
		toolsNotCalled: ["edit"],
		noErrors: true,
		verify: () =>
			readFileSync(fixturePath("behavior-write-overwrite", "notes.txt"), "utf-8") === "final release notes"
				? undefined
				: "the file was not fully replaced with the exact requested content",
	},
};
