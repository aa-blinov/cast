import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({ useEffect: () => {}, useRef: () => ({ current: null }), useState: (value: unknown) => [value, () => {}] }),
	{ virtual: true },
);
vi.mock("../src/server/public/api.js", () => ({ api: vi.fn() }));
vi.mock("../src/server/public/icons.js", () => ({ icons: {} }));
vi.mock("../src/server/public/modal-focus.js", () => ({ useModalFocusTrap: () => null }));
vi.mock("../src/server/public/sidebar-utils.js", () => ({ shortPath: (value: string) => value }));

import { SettingsMemory } from "../src/server/public/settings-panels.js";

describe("SettingsMemory", () => {
	it("is exported as the global memory settings panel", () => {
		expect(typeof SettingsMemory).toBe("function");
	});
});
