import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { TurnMetaLine } from "../src/web/public/turn-meta.js";

describe("web turn metadata", () => {
	it("exports the isolated footer component", () => {
		expect(TurnMetaLine).toBeTypeOf("function");
	});
});
