import { describe, expect, it, vi } from "vitest";

vi.mock(
	"preact/hooks",
	() => ({
		useEffect: () => {},
		useRef: (value: unknown) => ({ current: value }),
		useState: (value: unknown) => [value, vi.fn()],
	}),
	{ virtual: true },
);

import { useWorkspaceState } from "../src/server/public/use-workspace-state.js";

describe("web workspace state", () => {
	it("exports the state hook", () => {
		expect(useWorkspaceState).toBeTypeOf("function");
	});
});
