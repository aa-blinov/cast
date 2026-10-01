import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { asciiOnly, toAscii } from "../src/ui-pi/ascii.ts";

describe("asciiOnly", () => {
	it("is on for a locale that is set and is not UTF-8, off for UTF-8 and for no locale at all", () => {
		expect(asciiOnly({ LANG: "C" })).toBe(true);
		expect(asciiOnly({ LANG: "POSIX" })).toBe(true);
		expect(asciiOnly({ LANG: "en_US.ISO-8859-1" })).toBe(true);
		expect(asciiOnly({ LANG: "en_US.UTF-8" })).toBe(false);
		expect(asciiOnly({ LC_ALL: "C.utf8" })).toBe(false);
		expect(asciiOnly({})).toBe(false);
	});

	it("takes LC_ALL over LANG, and CAST_ASCII over both", () => {
		expect(asciiOnly({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(true);
		expect(asciiOnly({ LC_ALL: "en_US.UTF-8", LANG: "C" })).toBe(false);
		expect(asciiOnly({ CAST_ASCII: "1", LANG: "en_US.UTF-8" })).toBe(true);
		expect(asciiOnly({ CAST_ASCII: "0", LANG: "C" })).toBe(false);
	});
});

describe("toAscii", () => {
	it("swaps the box, arrow and marker glyphs for ASCII, one cell for one cell", () => {
		const row = "╭─ Title ─╮│ ▸ item ‹ on › │ ↓ newest ✗ …╰──╯";
		const out = toAscii(row);
		expect(out).toBe("+- Title -+| > item < on > | v newest x ~+--+");
		expect(visibleWidth(out)).toBe(visibleWidth(row));
	});

	it("leaves text that is not a screen glyph alone, accents and Cyrillic included", () => {
		const text = "Привет, café — 你好";
		expect(toAscii(text)).toBe("Привет, café - 你好");
	});

	it("keeps ANSI escape sequences intact", () => {
		expect(toAscii("\x1b[38;2;1;2;3m│\x1b[0m")).toBe("\x1b[38;2;1;2;3m|\x1b[0m");
	});
});
