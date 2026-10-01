import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { bannerLine, fitParts } from "../src/ui-pi/run.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("fitParts", () => {
	it("drops the last parts whole until the line fits, and always keeps the first", () => {
		const parts = ["/ commands", "/settings", "Esc Esc stops a turn"];
		expect(fitParts(parts, " * ", 80)).toBe("/ commands * /settings * Esc Esc stops a turn");
		expect(fitParts(parts, " * ", 25)).toBe("/ commands * /settings");
		expect(fitParts(parts, " * ", 3)).toBe("/ commands");
	});
});

describe("bannerLine", () => {
	const parts = ["Senior Developer", "mimo-v2.6-flash", "~/pet/cast"];

	it("sets a man page's header: name left, persona and model between, version right", () => {
		const row = plain(bannerLine("1.2.3", parts, 100, {}));
		expect(visibleWidth(row)).toBe(100);
		expect(row.startsWith("CAST(1)")).toBe(true);
		expect(row.endsWith("v1.2.3")).toBe(true);
		expect(row).toContain("Senior Developer * mimo-v2.6-flash * ~/pet/cast");
	});

	it("gives up the folder, then the model, before it cuts a word", () => {
		const narrow = plain(bannerLine("1.2.3", parts, 52, {}));
		expect(narrow).toContain("Senior Developer");
		expect(narrow).not.toContain("~/pet/cast");
		expect(plain(bannerLine("1.2.3", parts, 24, {}))).toBe(`CAST(1)${" ".repeat(11)}v1.2.3`);
		for (const width of [10, 16, 30, 52, 120]) {
			expect(visibleWidth(bannerLine("1.2.3", parts, width, {}))).toBeLessThanOrEqual(width);
		}
	});
});
