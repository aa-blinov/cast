import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });

import { CommandPalette, ValueSuggest } from "../src/web/public/composer-pickers.js";

describe("web composer pickers", () => {
	it("exports both render-only picker components", () => {
		expect(typeof CommandPalette).toBe("function");
		expect(typeof ValueSuggest).toBe("function");
	});
});
