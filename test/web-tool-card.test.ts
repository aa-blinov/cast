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

import { ToolCard } from "../src/server/public/tool-card.js";

describe("web tool card", () => {
	it("exports the isolated tool renderer", () => {
		expect(ToolCard).toBeTypeOf("function");
	});
});
