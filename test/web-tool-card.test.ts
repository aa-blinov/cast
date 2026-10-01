import { describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useState: (value: unknown) => [value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("../src/server/public/file-preview.js", () => ({ FilePreviewModal: () => null }));
vi.mock("../src/server/public/icons.js", () => ({ icons: { chevronUp: "up", chevronDown: "down" } }));

import { ToolCard, toolSummary } from "../src/server/public/tool-card.js";

describe("web tool card", () => {
	it("exports the isolated tool renderer", () => {
		expect(ToolCard).toBeTypeOf("function");
	});

	it("summarises a call by what it acts on, not its settings", () => {
		expect(toolSummary(JSON.stringify({ command: "git push", timeout: 600000 }))).toBe("git push");
		expect(toolSummary(JSON.stringify({ file_path: "/a/b.ts", offset: 3 }))).toBe("/a/b.ts");
		expect(toolSummary(JSON.stringify({ timeout: 5, note: "first line\nsecond" }))).toBe("first line");
	});

	it("gives an empty summary when there is nothing readable", () => {
		expect(toolSummary("")).toBe("");
		expect(toolSummary("not json")).toBe("");
		expect(toolSummary(JSON.stringify({ n: 1 }))).toBe("");
	});
});
