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
vi.mock("../src/server/public/modal-focus.js", () => ({
	useModalFocusTrap: () => null,
	pressable: () => ({}),
	rovingRows: () => ({}),
}));

import { DirectoryBrowser, filterFolders } from "../src/server/public/directory-browser.js";

describe("DirectoryBrowser", () => {
	it("is exported as an isolated directory picker", () => {
		expect(typeof DirectoryBrowser).toBe("function");
	});
});

describe("filterFolders", () => {
	const entries = [
		{ name: "alpha", path: "/p/alpha" },
		{ name: "Beta-Service", path: "/p/Beta-Service" },
		{ name: "gamma", path: "/p/gamma" },
	];

	it("keeps the folders whose name holds the text, ignoring case and the order they came in", () => {
		expect(filterFolders(entries, "a").map((e) => e.name)).toEqual(["alpha", "Beta-Service", "gamma"]);
		expect(filterFolders(entries, "SERV").map((e) => e.name)).toEqual(["Beta-Service"]);
		expect(filterFolders(entries, "zzz")).toEqual([]);
	});

	it("shows everything for an empty or blank filter", () => {
		expect(filterFolders(entries, "")).toBe(entries);
		expect(filterFolders(entries, "   ")).toBe(entries);
	});
});
