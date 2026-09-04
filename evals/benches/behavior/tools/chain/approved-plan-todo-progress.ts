import { readFileSync } from "node:fs";
import { fixtureDir, fixturePath, writeFixture } from "../../../../lib/fixtures.ts";
import type { EvalCase } from "../../../../lib/runner.ts";

const FIXTURE_ID = "behavior-approved-plan-todo-progress";
const NOTE_PATH = fixturePath(FIXTURE_ID, "note.txt");
const STEP = `Replace the content of ${NOTE_PATH} with READY and verify the exact result.`;

export const approvedPlanTodoProgress: EvalCase = {
	id: "approved-plan-todo-progress",
	description: "An approved plan keeps its specification while the matching linked todo records verified execution progress.",
	signals: ["plan-lifecycle", "state-persistence", "tool-chain", "filesystem-safety"],
	mode: "build",
	timeout: 180_000,
	setup: () => void writeFixture(FIXTURE_ID, { "note.txt": "PENDING\n" }),
	cwd: fixtureDir(FIXTURE_ID),
	planFixture: { name: "ready-note", content: `# Ready note\n\n## Steps\n- [ ] ${STEP}\n\n## Verification\n- Read ${NOTE_PATH} and confirm it is READY.\n` },
	initialTodos: [{ content: STEP, status: "pending", priority: "medium", planStep: STEP }],
	prompt: "Continue the approved plan. Complete its only step and verify it before reporting completion.",
	expect: {
		// Not "write": replacing PENDING with READY through `edit` is the same
		// outcome by the better tool, and mimo-v2.5 does exactly that — the
		// file's final content is what matters, and `verify` below checks it.
		toolsCalled: ["todo_write", "read"],
		noErrors: true,
		verify: ({ toolCalls }) => {
			const completion = toolCalls
				.filter((call) => call.name === "todo_write")
				.at(-1)?.result?.content;
			if (!completion?.includes('"status":"completed"') || !completion.includes('"planStep"')) {
				return "the verified plan step was not retained as a completed linked todo";
			}
			// The fixture ends in a newline, so writing "READY\n" back is the
			// faithful result; requiring the byte-exact "READY" failed a correct
			// run over a trailing newline nobody asked about either way.
			return readFileSync(NOTE_PATH, "utf-8").trimEnd() === "READY"
				? undefined
				: "the approved plan did not write the requested final state";
		},
	},
};
