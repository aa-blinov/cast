import type { EvalCase } from "../../../../lib/runner.ts";

const MARKER_RE = /\/tmp\/([a-z]{6})\.marker/;

export const btwDuringToolSeesRunningWork: EvalCase = {
	id: "btw-during-tool-sees-running-work",
	description:
		"A /btw question asked while a long command runs hears what the turn is doing (a name the model chose, so the question's own conversation cannot hold it), and the conversation stays as the turn left it.",
	signals: ["btw", "in-flight"],
	timeout: 120_000,
	// The file name is the model's own choice: the saved conversation (the prompt alone) cannot tell a side question
	// what it is, only what the running turn has done can.
	prompt:
		"Invent a random six-letter lowercase word. In ONE bash call run: touch /tmp/<word>.marker && sleep 15 && rm /tmp/<word>.marker (with your word in place of <word>). Then say done.",
	sideQuestion: {
		question: "What is the exact file name you are creating right now? Answer in one short sentence.",
		when: { duringTool: "bash" },
	},
	expect: {
		noErrors: true,
		toolsCalled: ["bash"],
		verify: ({ sideAnswer, messages, toolCalls }) => {
			if (sideAnswer?.error) return `the side question failed: ${sideAnswer.error}`;
			const command = String(toolCalls.find((c) => c.name === "bash")?.args.command ?? "");
			const word = MARKER_RE.exec(command)?.[1];
			if (!word) return `the model did not run the touch command it was asked for: ${JSON.stringify(command)}`;
			if (!(sideAnswer?.text ?? "").includes(word)) {
				return `the answer did not name ${word}, the file the running command creates: ${JSON.stringify(sideAnswer?.text)}`;
			}
			return JSON.stringify(messages).includes("What is the exact file name you are creating right now?")
				? "the side question ended up in the conversation"
				: undefined;
		},
	},
};
