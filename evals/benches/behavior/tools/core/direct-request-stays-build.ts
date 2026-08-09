import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const directRequestStaysBuild: EvalCase = {
	id: "direct-request-stays-build",
	description: "A small, local request is answered directly in build mode without unnecessary mutation.",
	signals: ["no-unneeded-tools", "tool-result-integrity"],
	mode: "build",
	setup: () => void writeFixture("behavior-direct-build", { "version.txt": "0.12.5\n" }),
	prompt: `What version is recorded in ${fixturePath("behavior-direct-build", "version.txt")}?`,
	expect: {
		containsAll: ["0.12.5"],
		toolsCalled: ["read"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
	},
};
