import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

export const bashArgumentGrounding: EvalCase = {
	id: "bash-argument-grounding",
	description: "A shell task builds a command that actually targets the requested file, not a generic guess.",
	signals: ["required-tool", "argument-grounding", "no-unneeded-tools"],
	setup: () => void writeFixture("behavior-bash-args", { "data.txt": "a\nb\nc\nd\ne\n" }),
	prompt: `How many lines are in ${fixturePath("behavior-bash-args", "data.txt")}? Use a shell command to count them.`,
	expect: {
		toolsCalled: ["bash"],
		toolsNotCalled: ["read", "grep"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const call = toolCalls.find((c) => c.name === "bash");
			const command = String(call?.args.command ?? "");
			const targetsFile = command.includes(fixturePath("behavior-bash-args", "data.txt"));
			const isLineCount = /\bwc\s+-l\b/.test(command);
			return targetsFile && isLineCount
				? undefined
				: "bash command did not target the requested file with a line-counting command";
		},
	},
};
