import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ["█"] }));

const { CastLogo } = await import("../src/web/public/cast-logo.js");

describe("CastLogo", () => {
	it("loads the shared banner grid and exports the component", () => {
		expect(typeof CastLogo).toBe("function");
		expect(fetch).toHaveBeenCalledWith("/cast-banner-grid.json");
	});
});
