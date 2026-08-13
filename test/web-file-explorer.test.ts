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
vi.mock("../src/server/public/file-preview.js", () => ({ FilePreviewModal: () => null }));

import {
	FileExplorer,
	isCurrentDirectoryRequest,
	nextDirectoryRequestVersion,
} from "../src/server/public/file-explorer.js";

describe("FileExplorer", () => {
	it("is exported as the filesystem explorer component", () => {
		expect(typeof FileExplorer).toBe("function");
	});

	it("keeps the newest directory refresh when responses resolve out of order", () => {
		const requests = new Map();
		const first = nextDirectoryRequestVersion(requests, "");
		const second = nextDirectoryRequestVersion(requests, "");

		expect(isCurrentDirectoryRequest(requests, "", first)).toBe(false);
		expect(isCurrentDirectoryRequest(requests, "", second)).toBe(true);
	});

	it("tracks refreshes independently for each directory", () => {
		const requests = new Map();
		const root = nextDirectoryRequestVersion(requests, "");
		const nested = nextDirectoryRequestVersion(requests, "src");

		expect(isCurrentDirectoryRequest(requests, "", root)).toBe(true);
		expect(isCurrentDirectoryRequest(requests, "src", nested)).toBe(true);
	});
});
