import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock(
	"preact",
	() => ({
		h: () => null,
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

import { isForkableAnswer, Message, parseSkillInvocation } from "../src/server/public/message.js";

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
