import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { bannerLine, fitParts } from "../src/ui-pi/run.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping the SGR codes
const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

describe("fitParts", () => {
	it("drops the last parts whole until the line fits, and always keeps the first", () => {
		const parts = ["/ commands", "/settings", "Esc Esc stops a turn"];
		expect(fitParts(parts, " · ", 80)).toBe("/ commands · /settings · Esc Esc stops a turn");
		expect(fitParts(parts, " · ", 25)).toBe("/ commands · /settings");
		expect(fitParts(parts, " · ", 3)).toBe("/ commands");
	});
});

describe("bannerLine", () => {
	const parts = ["Senior Developer", "mimo-v2.6-flash", "~/pet/cast"];

	it("shows everything on a wide screen", () => {
		expect(plain(bannerLine("1.2.3", parts, 120, {}))).toBe(
			"cast v1.2.3  ·  Senior Developer  ·  mimo-v2.6-flash  ·  ~/pet/cast",
		);
	});

	it("gives up the folder, then the model, before it cuts a word", () => {
		expect(plain(bannerLine("1.2.3", parts, 50, {}))).toBe("cast v1.2.3  ·  Senior Developer");
		expect(plain(bannerLine("1.2.3", parts, 20, {}))).toBe("cast v1.2.3");
		for (const width of [12, 30, 50, 120])
			expect(visibleWidth(bannerLine("1.2.3", parts, width, {}))).toBeLessThanOrEqual(width);
	});
});
