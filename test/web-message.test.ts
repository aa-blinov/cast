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

import { Message, parseSkillInvocation } from "../src/server/public/message.js";

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

	it("handles an invocation without arguments", () => {
		expect(parseSkillInvocation(block())?.args).toBe("");
	});

	it("leaves ordinary messages alone", () => {
		expect(parseSkillInvocation("please use <skill name=x> tags")).toBeNull();
		expect(parseSkillInvocation('<skill name="x" location="y">unterminated')).toBeNull();
		expect(parseSkillInvocation(undefined)).toBeNull();
	});
});
