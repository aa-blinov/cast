import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({
		useCallback: (fn: unknown) => fn,
		useEffect: () => {},
		useRef: (value: unknown) => ({ current: value }),
		useState: (value: unknown) => [value, vi.fn()],
	}),
	{ virtual: true },
);
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));
vi.mock("../src/server/public/icons.js", () => ({ icons: {} }));
vi.mock("../src/server/public/sidebar-session-item.js", () => ({ SidebarSessionItem: () => null }));

import { Sidebar } from "../src/server/public/sidebar.js";

describe("web sidebar", () => {
	it("exports the isolated session sidebar", () => {
		expect(Sidebar).toBeTypeOf("function");
	});
});
