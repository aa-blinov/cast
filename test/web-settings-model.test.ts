import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({ useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()] }),
	{ virtual: true },
);
vi.mock("../src/server/public/slot-model-picker.js", () => ({ SlotModelPicker: () => null }));

import { SettingsModel } from "../src/server/public/settings-model.js";

describe("SettingsModel", () => {
	it("is exported as the model settings panel", () => {
		expect(typeof SettingsModel).toBe("function");
	});
});
