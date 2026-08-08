import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock("preact/hooks", () => ({ useEffect: () => {}, useState: (value: unknown) => [value, vi.fn()] }), {
	virtual: true,
});

import { ElapsedTimer } from "../src/server/public/elapsed-timer.js";

describe("ElapsedTimer", () => {
	it("is exported as an isolated component", () => {
		expect(typeof ElapsedTimer).toBe("function");
	});
});
