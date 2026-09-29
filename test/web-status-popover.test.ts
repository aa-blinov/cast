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

import { lspSummary, StatusPopover } from "../src/server/public/status-popover.js";

describe("StatusPopover", () => {
	it("is exported as an isolated status component", () => {
		expect(typeof StatusPopover).toBe("function");
	});
});

describe("lspSummary", () => {
	it("names the running servers once each, and what could not start", () => {
		expect(
			lspSummary({
				enabled: true,
				running: [
					{ id: "typescript", root: "/a" },
					{ id: "typescript", root: "/b" },
					{ id: "pyright", root: "/a" },
				],
				unavailable: [{ id: "clangd", root: "/a", reason: "not installed" }],
			}),
		).toBe("typescript, pyright · unavailable: clangd");
		expect(lspSummary({ enabled: true, running: [], unavailable: [] })).toBe("none running yet");
		expect(lspSummary({ enabled: false })).toBe("off");
	});
});
