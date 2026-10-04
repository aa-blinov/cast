import { fixtureDir, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const PROJECT = "behavior-bg-server";

export const backgroundServerLifecycle: EvalCase = {
	id: "background-server-lifecycle",
	description:
		"A dev server is started in the background, queried, and stopped by id; nothing is announced after it was stopped, and the port is free again.",
	signals: ["background-lifecycle", "tool-selection"],
	cwd: fixtureDir(PROJECT),
	timeout: 150_000,
	setup: () => void writeFixture(PROJECT, { "marker-4419.txt": "hello" }),
	prompt:
		"Start `python3 -m http.server 18765` in the background (run_in_background), fetch http://127.0.0.1:18765/ with curl and tell me which file it lists, then stop the server.",
	expect: {
		toolsCalled: ["bash", "bash_kill"],
		containsAll: ["marker-4419"],
		noErrors: true,
		verify: ({ toolCalls, messages }) => {
			const start = toolCalls.find((c) => c.name === "bash" && c.args.run_in_background === true);
			const id = start?.result?.content.match(/\bbg-\d+\b/)?.[0];
			if (!id) return "the server was not started in the background";
			if (!toolCalls.some((c) => c.name === "bash_kill" && c.args.task_id === id))
				return "the server was not stopped by its id";
			const told = messages.some(
				(m) => m.role === "user" && typeof m.content === "string" && m.content.includes(`Background task ${id} (`),
			);
			return told ? "the model was told the server ended after it stopped it itself" : undefined;
		},
	},
};
