import { describe, expect, it } from "vitest";
import { accentForeground, contrast, readableText, readableTextLevels } from "../src/server/public/theme-contrast.js";
import { ALL_THEMES } from "../src/ui/themes/registry.ts";

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

	for (const theme of ALL_THEMES) {
		const c = theme.colors;
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
