import { describe, expect, it } from "vitest";
import { accentForeground, contrast, readableText, readableTextLevels } from "../src/server/public/theme-contrast.js";
import { WEB_THEMES } from "../src/ui/themes/registry.ts";

const TEXT = "#fafafa";
const DIM = "#a1a1aa";

describe("web theme contrast", () => {
	it("measures WCAG contrast", () => {
		expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
		expect(contrast("#777777", "#777777")).toBe(1);
	});

	it("keeps a color that already passes", () => {
		expect(readableText("#a1a1aa", TEXT, "#08080a")).toBe("#a1a1aa");
	});

	for (const theme of WEB_THEMES) {
		const c = theme.colors;
		it(`${theme.id}: role colours, lifted the way the page lifts them, read on the page, panels and cards`, () => {
			for (const key of ["user", "agent", "tool", "persona", "success", "warning", "error"] as const) {
				const lifted = [c.bg, c.bgSurface, c.bgRaised].reduce(
					(color, surface) => readableText(color, TEXT, surface),
					c[key],
				);
				for (const surface of [c.bg, c.bgSurface, c.bgRaised]) {
					expect(contrast(lifted, surface), `${key} on ${surface}`).toBeGreaterThanOrEqual(4.5);
				}
			}
		});

		it(`${theme.id}: accent labels, muted and dim text meet AA`, () => {
			expect(contrast(accentForeground(c.accent, c.bg), c.accent)).toBeGreaterThanOrEqual(4.5);

			const { mutedText, dimText } = readableTextLevels({
				muted: c.muted,
				dim: DIM,
				text: TEXT,
				surface: c.bgSurface,
				raised: c.bgRaised,
				hover: c.bgHover,
			});
			expect(contrast(mutedText, c.bgRaised)).toBeGreaterThanOrEqual(4.5);
			expect(contrast(dimText, c.bgHover)).toBeGreaterThanOrEqual(4.5);
			// Dim is the brighter of the two secondary levels; deriving must not swap them.
			expect(contrast(dimText, c.bgSurface)).toBeGreaterThan(contrast(mutedText, c.bgSurface));
		});
	}
});
