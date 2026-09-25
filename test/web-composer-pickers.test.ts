import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { CommandPalette, PICKER_LIST_ID, pickerOptionId, ValueSuggest } from "../src/server/public/composer-pickers.js";

describe("web composer pickers", () => {
	it("exports both render-only picker components", () => {
		expect(typeof CommandPalette).toBe("function");
		expect(typeof ValueSuggest).toBe("function");
	});

	it("gives each option a stable id the textarea can point at", () => {
		expect(PICKER_LIST_ID).toBe("composer-suggestions");
		expect(pickerOptionId(2)).toBe("composer-suggestion-2");
		expect(pickerOptionId(0)).not.toBe(pickerOptionId(1));
	});
});
