import { describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useRef: (value: unknown) => ({ current: value }),
		useState: (value: unknown) => [value, vi.fn()],
	}),
	{ virtual: true },
);

import { useSessionState } from "../src/server/public/use-session-state.js";

describe("web session state", () => {
	it("exports the session state hook", () => {
		expect(useSessionState).toBeTypeOf("function");
	});
});
