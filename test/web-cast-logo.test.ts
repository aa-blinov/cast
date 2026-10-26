import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
let loadedBannerGrid = false;
vi.stubGlobal(
	"fetch",
	vi.fn(async (url: string) => {
		loadedBannerGrid = url === "/cast-banner-grid.json";
		return { json: async () => ["█"] };
	}),
);

const { CastLogo } = await import("../src/server/public/cast-logo.js");

describe("CastLogo", () => {
	it("loads the shared banner grid and exports the component", () => {
		expect(typeof CastLogo).toBe("function");
		expect(loadedBannerGrid).toBe(true);
	});
});
