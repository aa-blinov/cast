import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock(
	"preact",
	() => ({
		h: () => null,
		Fragment: () => null,
		Component: class {
			props: Record<string, unknown> = {};
		},
	}),
	{ virtual: true },
);
vi.mock("preact/hooks", () => ({ useState: (v: unknown) => [v, vi.fn()] }), { virtual: true });
vi.mock("../src/server/public/file-preview.js", () => ({ FilePreviewModal: () => null }));
vi.mock("../src/server/public/streaming-blocks.js", () => ({ BlockView: () => null }));
vi.mock("../src/server/public/tool-card.js", () => ({ ToolCard: () => null }));
vi.mock("../src/server/public/turn-meta.js", () => ({ TurnMetaLine: () => null }));

import {
	goalPromptDisplay as coreGoalPromptDisplay,
	GOAL_BUDGET_PROMPT,
	GOAL_CONTINUATION_PROMPT,
	GOAL_NUDGE_PROMPT,
} from "../src/core/goal.ts";
import { backgroundTaskLine as coreBackgroundTaskLine } from "../src/core/system-reminder.ts";
import { parseUserShellMessage as coreParseUserShellMessage, userShellMessage } from "../src/core/user-shell.ts";
import { buildGoalPrompt, commitPrompt, initPrompt } from "../src/server/commands.ts";
import {
	backgroundTaskLine,
	goalPromptDisplay,
	isForkableAnswer,
	Message,
	parseSkillInvocation,
	parseUserShellMessage,
} from "../src/server/public/message.js";

const renderMarkdown = (s: string) => s;
const escapeHtml = (s: string) => s;

function withProps(props: Record<string, unknown>) {
	const m = new Message() as unknown as { props: Record<string, unknown>; shouldComponentUpdate(n: object): boolean };
	m.props = props;
	return m;
}

describe("Message", () => {
	const msg = { role: "assistant", content: "hi" };
	const base = { msg, renderMarkdown, escapeHtml, showReasoning: false };

	it("skips re-rendering a settled message when nothing it reads changed", () => {
		expect(withProps(base).shouldComponentUpdate({ ...base })).toBe(false);
	});

	it("re-renders for a new message object or a changed prop", () => {
		expect(withProps(base).shouldComponentUpdate({ ...base, msg: { ...msg } })).toBe(true);
		expect(withProps(base).shouldComponentUpdate({ ...base, showReasoning: true })).toBe(true);
	});

	it("re-renders when a prop is dropped", () => {
		const { showReasoning: _, ...rest } = base;
		expect(withProps(base).shouldComponentUpdate(rest)).toBe(true);
	});
});

describe("parseSkillInvocation", () => {
	const block = (extra = "") =>
		`<skill name="web&amp;app" location="/home/u/.agents/skills/webapp/SKILL.md" allowed-tools="Bash">\nReferences are relative to /x.\n\n# Body\nSteps.\n</skill>${extra}`;

	it("reads the skill a /command expanded into, with its arguments", () => {
		expect(parseSkillInvocation(block("\n\nUser: check the login page"))).toEqual({
			name: "web&app",
			location: "/home/u/.agents/skills/webapp/SKILL.md",
			args: "check the login page",
		});
	});

	it("reads the arguments off the tag when the body used them and there is no User: line", () => {
		const tagged =
			'<skill name="allargs" location="/s/SKILL.md" arguments="fix the &quot;login&quot; bug">\nBODY [fix the login bug]\n</skill>';
		expect(parseSkillInvocation(tagged)?.args).toBe('fix the "login" bug');
	});

	it("handles an invocation without arguments", () => {
		expect(parseSkillInvocation(block())?.args).toBe("");
	});

	it("leaves ordinary messages alone", () => {
		expect(parseSkillInvocation("please use <skill name=x> tags")).toBeNull();
		expect(parseSkillInvocation('<skill name="x" location="y">unterminated')).toBeNull();
		expect(parseSkillInvocation(undefined)).toBeNull();
	});
});

describe("isForkableAnswer", () => {
	it("accepts a saved answer that ends a turn", () => {
		expect(isForkableAnswer({ role: "assistant", content: "done", seq: 7 }, false)).toBe(true);
		expect(isForkableAnswer({ role: "assistant", content: "done", seq: 7, toolCalls: [] }, false)).toBe(true);
	});

	it("takes an answer without a seq only when it is the last message", () => {
		expect(isForkableAnswer({ role: "assistant", content: "done" }, true)).toBe(true);
		expect(isForkableAnswer({ role: "assistant", content: "done" }, false)).toBe(false);
	});

	it("refuses a message that calls tools, an empty one, and anything that is not an answer", () => {
		expect(isForkableAnswer({ role: "assistant", content: "", seq: 3, toolCalls: [{ id: "c" }] }, true)).toBe(false);
		expect(isForkableAnswer({ role: "assistant", content: "x", seq: 3, toolCalls: [{ id: "c" }] }, false)).toBe(
			false,
		);
		expect(isForkableAnswer({ role: "assistant", content: null, seq: 3 }, true)).toBe(false);
		expect(isForkableAnswer({ role: "user", content: "hi", seq: 1 }, true)).toBe(false);
		expect(isForkableAnswer({ role: "warning", content: "w", seq: 2 }, true)).toBe(false);
	});
});

describe("goalPromptDisplay", () => {
	it("is the web port of the core mapping: same lines for every goal prompt, and nothing for other text", () => {
		for (const text of [
			buildGoalPrompt("ship the importer, with tests", 10),
			GOAL_CONTINUATION_PROMPT,
			GOAL_NUDGE_PROMPT,
			GOAL_BUDGET_PROMPT,
			"Review the work done in this session as a careful senior engineer.\n\n1. Identify",
			"Review the changes in main..HEAD. The scope below was computed, not guessed: review every group.",
			"Review the changes in working tree vs HEAD. The scope below was computed, not guessed: x",
			initPrompt(""),
			initPrompt("monorepo, packages/*"),
			commitPrompt(""),
			commitPrompt("only the parser"),
			"fix the tests please",
		]) {
			expect(goalPromptDisplay(text) ?? undefined, text.slice(0, 40)).toEqual(coreGoalPromptDisplay(text));
		}
	});
});

describe("backgroundTaskLine", () => {
	it("is the web port of the core one: the same line for background tasks of both kinds, nothing for other reminders", () => {
		for (const body of [
			"Background task bg-7 (`du -xh --max-depth=1 /`) exited with code 0 after 117s.\n\n187G\t/",
			`Background task bg-8 (\`${"x ".repeat(60)}\`) killed.`,
			"Background task t1 (explore: find callers) finished. Relay what matters to the user.\n\nreport",
			"The date is now 2026-10-05.",
			"",
		]) {
			expect(backgroundTaskLine(body) ?? undefined, body.slice(0, 40)).toEqual(coreBackgroundTaskLine(body));
		}
	});
});

describe("parseUserShellMessage", () => {
	it("is the web port of the core parser: same command and output, odd characters included, nothing for other text", () => {
		for (const text of [
			userShellMessage("ls -la", "total 0\nfile"),
			userShellMessage('echo "hi" && echo <b> & done', "hi"),
			userShellMessage("cat x", "before </user-shell> after"),
			userShellMessage("true", ""),
			"fix the tests please",
			"The user ran a shell command themselves (you did not run it):\nnot a block",
		]) {
			expect(parseUserShellMessage(text) ?? undefined, text.slice(0, 40)).toEqual(coreParseUserShellMessage(text));
		}
	});
});
