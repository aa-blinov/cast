import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { SettingsAppearance } from "../src/server/public/settings-appearance.js";

describe("SettingsAppearance", () => {
	it("is exported as the theme and font settings panel", () => {
		expect(typeof SettingsAppearance).toBe("function");
	});
});
