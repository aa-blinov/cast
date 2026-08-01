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
vi.mock("../src/web/public/api.js", () => ({ api: vi.fn() }));

import { Composer } from "../src/web/public/composer.js";

describe("Composer", () => {
	it("is exported as the isolated composer component", () => {
		expect(typeof Composer).toBe("function");
	});
});
