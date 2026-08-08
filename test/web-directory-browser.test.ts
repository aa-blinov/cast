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

import { DirectoryBrowser } from "../src/server/public/directory-browser.js";

describe("DirectoryBrowser", () => {
	it("is exported as an isolated directory picker", () => {
		expect(typeof DirectoryBrowser).toBe("function");
	});
});
