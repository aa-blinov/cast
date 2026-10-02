import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("preact/hooks", () => ({ useEffect: () => {}, useRef: () => ({ current: null }) }), { virtual: true });
vi.mock("../src/server/public/file-explorer.js", () => ({ FileExplorer: () => null }));

import { DiffPanel, numberHunkLines } from "../src/server/public/diff-panel.js";

describe("DiffPanel", () => {
	it("is exported as the changes/files/inputs container", () => {
		expect(typeof DiffPanel).toBe("function");
	});
});

describe("numberHunkLines", () => {
	it("numbers context lines and keeps the numbers after them right", () => {
		const hunk = {
			oldStart: 1,
			newStart: 1,
			lines: [
				{ type: " ", content: "hello" },
				{ type: "+", content: "there" },
				{ type: " ", content: "world" },
				{ type: "-", content: "gone" },
			],
		};
		expect(numberHunkLines(hunk).map((l) => l.num)).toEqual([1, 2, 3, 3]);
	});
});
