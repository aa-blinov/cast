import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const requiredReadTool: EvalCase = {
	id: "required-read-tool",
	description: "Agent reads the requested file instead of answering from memory.",
	signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-required-read", { "facts.txt": "release-channel=canary\n" }),
	prompt: `What release channel is recorded in ${fixturePath("behavior-required-read", "facts.txt")}?`,
	expect: {
		toolsCalled: ["read"],
		toolsNotCalled: ["bash", "write", "edit"],
		noErrors: true,
		verify: ({ toolCalls }) =>
			toolCalls.some(
				(call) => call.name === "read" && call.args.path === fixturePath("behavior-required-read", "facts.txt"),
			)
				? undefined
				: "agent did not read the requested fixture",
	},
};
