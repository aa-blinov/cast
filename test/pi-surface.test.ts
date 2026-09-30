import { afterEach, describe, expect, it } from "vitest";
import { setSurfaces, surfaceBand, surfaceHover } from "../src/ui-pi/surface.ts";

const lum = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

afterEach(() => setSurfaces({}));

describe("surfaces", () => {
	it("are the terminal's own background nudged toward its foreground, dark or light", () => {
		setSurfaces({ foreground: { r: 230, g: 230, b: 230 }, background: { r: 10, g: 10, b: 12 } });
		expect(lum(surfaceBand()!)).toBeGreaterThan(lum("#0a0a0c"));
		expect(lum(surfaceHover()!)).toBeGreaterThan(lum(surfaceBand()!));
		expect(lum(surfaceHover()!)).toBeLessThan(lum("#808080"));

		setSurfaces({ foreground: { r: 30, g: 30, b: 30 }, background: { r: 250, g: 250, b: 250 } });
		expect(lum(surfaceBand()!)).toBeLessThan(lum("#fafafa"));
		expect(lum(surfaceHover()!)).toBeLessThan(lum(surfaceBand()!));
		expect(lum(surfaceHover()!)).toBeGreaterThan(lum("#808080"));
	});

	it("are absent when the terminal did not say what its colours are", () => {
		setSurfaces({ background: { r: 0, g: 0, b: 0 } });
		expect(surfaceBand()).toBeUndefined();
		expect(surfaceHover()).toBeUndefined();
	});
});
