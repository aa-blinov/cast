import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("../src/web/public/file-explorer.js", () => ({ FileExplorer: () => null }));

import { DiffPanel } from "../src/web/public/diff-panel.js";

describe("DiffPanel", () => {
	it("is exported as the changes/files/inputs container", () => {
		expect(typeof DiffPanel).toBe("function");
	});
});
