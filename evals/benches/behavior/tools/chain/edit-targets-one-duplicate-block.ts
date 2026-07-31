import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const editTargetsOneDuplicateBlock: EvalCase = {
	id: "edit-targets-one-duplicate-block",
	description: "A surgical edit changes the requested duplicate block and leaves the other intact.",
	signals: ["tool-chain", "filesystem-safety"],
	setup: () =>
		void writeFixture("behavior-duplicate-edit", {
			"handlers.ts": "export const first = () => 'same';\nexport const second = () => 'same';\n",
		}),
	prompt: `In ${fixturePath("behavior-duplicate-edit", "handlers.ts")}, change only second so it returns "changed"; first must remain "same".`,
	expect: {
		toolsCalled: ["read", "edit"],
		toolSubsequence: ["read", "edit"],
		noErrors: true,
		verify: () =>
			readFileSync(fixturePath("behavior-duplicate-edit", "handlers.ts"), "utf-8") ===
			"export const first = () => 'same';\nexport const second = () => 'changed';\n"
				? undefined
				: "duplicate edit changed the wrong block or altered unrelated content",
	},
};
