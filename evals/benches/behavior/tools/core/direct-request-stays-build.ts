import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const directRequestStaysBuild: EvalCase = {
	id: "direct-request-stays-build",
	description: "A small, local request does not open the planning picker.",
	signals: ["mode-selection", "no-unneeded-tools"],
	mode: "build",
	setup: () => void writeFixture("behavior-direct-build", { "version.txt": "0.12.5\n" }),
	prompt: `What version is recorded in ${fixturePath("behavior-direct-build", "version.txt")}?`,
	expect: {
		toolsCalled: ["read"],
		toolsNotCalled: ["plan_enter", "bash", "write", "edit"],
		noErrors: true,
	},
};
