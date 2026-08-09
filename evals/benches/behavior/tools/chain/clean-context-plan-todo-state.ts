import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-clean-context-plan-todo";
const STATUS_PATH = fixturePath(FIXTURE_ID, "status.txt");
const STEP = `Change ${STATUS_PATH} from queued to shipped and verify the result.`;

export const cleanContextPlanTodoState: EvalCase = {
	id: "clean-context-plan-todo-state",
	description: "A fresh build context receives both the approved plan and its linked todo state, then completes the task from that externalized state.",
	signals: ["plan-lifecycle", "state-persistence", "tool-chain", "filesystem-safety"],
	mode: "build",
	setup: () => void writeFixture(FIXTURE_ID, { "status.txt": "queued\n" }),
	cwd: fixtureDir(FIXTURE_ID),
	planFixture: { name: "ship-status", content: `# Ship status\n\n## Steps\n- [ ] ${STEP}\n\n## Verification\n- Read ${STATUS_PATH} and confirm it is shipped.\n` },
	initialTodos: [{ content: STEP, status: "pending", priority: "medium", planStep: STEP }],
	prompt: "This is a fresh implementation context. Use the approved plan and task list already provided, then complete and verify the remaining work.",
	expect: {
		toolsCalled: ["todo_write", "read"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const finalTodo = toolCalls.filter((call) => call.name === "todo_write").at(-1)?.result?.content;
			return finalTodo?.includes('"status":"completed"') && finalTodo.includes('"planStep"')
				? readFileSync(STATUS_PATH, "utf-8") === "shipped\n"
					? undefined
					: "fresh-context execution did not write the planned status"
				: "fresh-context execution did not finish the linked todo";
		},
	},
};
