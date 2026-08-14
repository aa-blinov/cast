import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useRef: (value: unknown) => ({ current: value }),
		useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));

import { MemoryExplorer, memoryImportanceLabel } from "../src/server/public/memory-explorer.js";

describe("MemoryExplorer", () => {
	it("is exported as the project memory sidebar explorer", () => {
		expect(MemoryExplorer).toBeTypeOf("function");
	});

	it("uses four readable priority badges", () => {
		expect(memoryImportanceLabel(90)).toBe("CRITICAL");
		expect(memoryImportanceLabel(70)).toBe("HIGH");
		expect(memoryImportanceLabel(40)).toBe("MEDIUM");
		expect(memoryImportanceLabel(39)).toBe("LOW");
	});
});
