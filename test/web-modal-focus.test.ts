import { describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useEffect: () => {},
		useRef: () => ({ current: null }),
	}),
	{ virtual: true },
);

import { FOCUSABLE_SELECTOR } from "../src/server/public/modal-focus.js";

describe("web modal focus module", () => {
	it("keeps disabled controls out of the focus cycle", () => {
		expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
		expect(FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
	});
});
