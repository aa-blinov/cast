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
vi.mock("../src/web/public/file-preview.js", () => ({ FilePreviewModal: () => null }));

import { FileExplorer } from "../src/web/public/file-explorer.js";

describe("FileExplorer", () => {
	it("is exported as the filesystem explorer component", () => {
		expect(typeof FileExplorer).toBe("function");
	});
});
