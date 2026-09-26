import { fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const TASK_ID_RE = /^<task id="([^"]+)"/;

export const taskFollowUpWithTaskId: EvalCase = {
	id: "task-follow-up-with-task-id",
	description: "A follow-up for a subagent continues it by task_id instead of starting a fresh one.",
	signals: ["delegation"],
	persona: "coder-with-subagents",
	setup: () =>
		void writeFixture("behavior-task-follow-up", {
			"notes/plan.txt": "release-marker: amber-falcon\nowner: platform team\nstatus: draft\n",
		}),
	prompt:
		`Have an explore subagent read ${fixturePath("behavior-task-follow-up", "notes/plan.txt")} and report the release marker. ` +
		"Once it has answered, ask that same subagent a follow-up — who owns the file — continuing it rather than starting a new one. " +
		"Do not modify any files.",
	expect: {
		toolsCalled: ["task"],
		toolsNotCalled: ["write", "edit"],
		containsAll: ["amber-falcon", "platform"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const tasks = toolCalls.filter((call) => call.name === "task");
			const firstId = TASK_ID_RE.exec(tasks[0]?.result?.content ?? "")?.[1];
			if (!firstId) return "the first task call returned no task id";
			return tasks.slice(1).some((call) => call.args.task_id === firstId)
				? undefined
				: "the follow-up started a new subagent instead of passing the first one's task_id";
		},
	},
};
