import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useRef: () => ({ current: null }),
		useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));
vi.mock("../src/server/public/modal-focus.js", () => ({ useModalFocusTrap: () => null }));

import { StatusPopover } from "../src/server/public/status-popover.js";

describe("StatusPopover", () => {
	it("is exported as an isolated status component", () => {
		expect(typeof StatusPopover).toBe("function");
	});
});
