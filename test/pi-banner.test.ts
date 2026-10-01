import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { bannerRows, fitParts } from "../src/ui-pi/banner.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("fitParts", () => {
	it("drops the last parts whole until the line fits, and always keeps the first", () => {
		const parts = ["/ commands", "/settings", "Esc Esc stops a turn"];
		expect(fitParts(parts, " * ", 80)).toEqual(parts);
		expect(fitParts(parts, " * ", 25)).toEqual(["/ commands", "/settings"]);
		expect(fitParts(parts, " * ", 3)).toEqual(["/ commands"]);
	});
});

describe("bannerRows", () => {
	const parts = ["Senior Developer", "mimo-v2.6-flash", "v1.2.3", "~/pet/cast"];

	it("joins everything with one ` * ` instead of padding to the edges", () => {
		const [header] = bannerRows(parts, 100);
		expect(plain(header!)).toBe("CAST(1) * Senior Developer * mimo-v2.6-flash * v1.2.3 * ~/pet/cast");
	});

	it("gives up the last parts, whole, before it cuts a word", () => {
		expect(plain(bannerRows(parts, 50)[0]!)).toBe("CAST(1) * Senior Developer * mimo-v2.6-flash");
		expect(plain(bannerRows(parts, 30)[0]!)).toBe("CAST(1) * Senior Developer");
		expect(plain(bannerRows(parts, 12)[0]!)).toBe("CAST(1)");
	});

	it("never draws a row wider than the screen, from a phone to a wide terminal", () => {
		for (const width of [10, 20, 32, 40, 60, 120, 200]) {
			for (const row of bannerRows(parts, width)) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
		}
	});

	it("sets the name in bold and follows with a hint row that drops hints from the end", () => {
		const rows = bannerRows(parts, 40);
		expect(rows[0]).toContain("\x1b[1m");
		expect(plain(rows[1]!)).toBe("/ commands * /settings");
	});
});
