/**
 * The live region's row budget is computed from these numbers while Ink
 * measures the same text with `string-width` — so the two have to agree.
 * Overcounting drops text that would have fitted; undercounting lets the live
 * region overrun the viewport, which is the failure this module exists to
 * prevent. The old hand-rolled table did both: `👨‍👩‍👧‍👦` measured 11 cells
 * instead of 2, `🀄` measured 1 instead of 2.
 */
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { displayWidth, displayWidthAtMost, displayWidthCacheFlush } from "../src/ui/display-width.ts";

const SAMPLES = [
	"hello world",
	"",
	"日本語テキスト",
	"한국어",
	"（全角）",
	"ｱｲｳ",
	"école", // combining acute
	"\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}", // family
	"\u{1f468}‍\u{1f4bb}", // technologist
	"\u{1f469}\u{1f3fb}‍\u{1f680}", // skin tone + ZWJ
	"\u{1f3f3}️‍\u{1f308}", // flag + VS16 + ZWJ
	"\u{1f1fa}\u{1f1f8}", // regional indicators
	"❤",
	"❤️",
	"⚠️ warn",
	"1️⃣",
	"\u{1f004}", // mahjong
	"\u{1f201}", // enclosed CJK
	"⌚",
	"x✅y",
	"a​b", // zero-width space
	"→ ok",
	"░▒▓",
	"Ωμ",
	"α β γ",
	"\u{1f4a9}\u{1f4a9}\u{1f4a9}",
];

describe("displayWidth", () => {
	it("agrees with string-width, which is what Ink measures with", () => {
		const disagreements = SAMPLES.filter((sample) => displayWidth(sample) !== stringWidth(sample)).map((sample) => ({
			sample: JSON.stringify(sample),
			ours: displayWidth(sample),
			stringWidth: stringWidth(sample),
		}));
		expect(disagreements).toEqual([]);
	});

	it("caches without changing the answer", () => {
		displayWidthCacheFlush();
		const line = "日本語 and \u{1f468}‍\u{1f4bb}";
		const first = displayWidth(line);
		expect(displayWidth(line)).toBe(first);
		expect(first).toBe(stringWidth(line));
	});
});

describe("displayWidthAtMost", () => {
	it("returns the true width when it fits and gives up past the budget", () => {
		displayWidthCacheFlush();
		expect(displayWidthAtMost("hello", 10)).toBe(5);
		// Only "greater than the budget" is promised once abandoned.
		expect(displayWidthAtMost("x".repeat(100), 10)).toBeGreaterThan(10);
	});

	it("does not cache a width it abandoned early", () => {
		displayWidthCacheFlush();
		const line = "y".repeat(50);
		expect(displayWidthAtMost(line, 5)).toBeGreaterThan(5);
		// The full measurement must still be correct afterwards.
		expect(displayWidth(line)).toBe(50);
	});
});
