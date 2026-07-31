import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const writeThenReadBack: EvalCase = {
	id: "write-then-read-back",
	description: "A requested verification reads the file after writing it.",
	signals: ["tool-chain", "filesystem-safety"],
	setup: () => void writeFixture("behavior-write-read", {}),
	prompt: `Create ${fixturePath("behavior-write-read", "out.txt")} with exactly "verified-content", then verify its contents.`,
	expect: {
		toolsCalled: ["write", "read"],
		toolSubsequence: ["write", "read"],
		noErrors: true,
		verify: () =>
			readFileSync(fixturePath("behavior-write-read", "out.txt"), "utf-8") === "verified-content"
				? undefined
				: "written fixture content is not exact",
	},
};
