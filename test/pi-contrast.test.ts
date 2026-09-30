import { afterEach, describe, expect, it } from "vitest";
import { gradientAnsi } from "../src/ui/gradient.ts";
import { ALL_THEMES, WEB_THEMES } from "../src/ui/themes/index.ts";
import { contrastRatio, legible } from "../src/ui-pi/contrast.ts";
import { paint } from "../src/ui-pi/paint.ts";

describe("legible", () => {
	it("leaves a colour that already clears the floor alone", () => {
		expect(legible("#ffffff", "#08080a")).toBe("#ffffff");
	});

	it("lifts a grey that is too close to a dark background, by as little as it takes", () => {
		const lifted = legible("#4c566a", "#2e3440");
		expect(lifted).not.toBe("#4c566a");
		expect(contrastRatio(lifted, "#2e3440")).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(lifted, "#2e3440")).toBeLessThan(5.2);
	});

	it("darkens text on a light background instead", () => {
		const darker = legible("#aaaaaa", "#ffffff");
		expect(contrastRatio(darker, "#ffffff")).toBeGreaterThanOrEqual(4.5);
		expect(darker < "#aaaaaa").toBe(true);
	});

	it("passes through anything that is not a #rrggbb hex", () => {
		expect(legible("red", "#000000")).toBe("red");
	});
});

describe("paint legibility floor", () => {
	it("makes every theme's muted and accent text readable on the theme's own background", () => {
		for (const theme of ALL_THEMES) {
			for (const key of ["muted", "accent", "error", "warning", "success"] as const) {
				const lifted = legible(theme.colors[key], theme.colors.bg);
				expect(contrastRatio(lifted, theme.colors.bg), `${theme.id} ${key}`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it("does not touch decoration painted as given", () => {
		expect(paint("x", { color: "#101012", bg: "#08080a", exact: true })).toBe(
			paint("x", { color: "#101012", bg: "#08080a", exact: true }),
		);
		expect(paint("x", { color: "#101012", bg: "#08080a", exact: true })).not.toBe(
			paint("x", { color: "#101012", bg: "#08080a" }),
		);
	});
});

describe("cast-light", () => {
	const light = ALL_THEMES.find((t) => t.id === "cast-light");

	it("is a terminal theme, and the browser UI does not list it", () => {
		expect(light?.terminalOnly).toBe(true);
		expect(WEB_THEMES.some((t) => t.id === "cast-light")).toBe(false);
		expect(WEB_THEMES.length).toBe(ALL_THEMES.length - 1);
	});

	it("needs no lifting: its text colours clear 4.5:1 on white and on a highlighted row", () => {
		const { colors } = light!;
		const hover = "#d9d9d9";
		for (const key of ["user", "agent", "tool", "persona", "accent", "success", "warning", "error"] as const) {
			expect(contrastRatio(colors[key], colors.bg), key).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrastRatio(colors.muted, colors.bg)).toBeGreaterThanOrEqual(4.5);
		expect(contrastRatio(colors.muted, hover)).toBeGreaterThanOrEqual(4.5);
	});
});

describe("NO_COLOR", () => {
	const saved = process.env.NO_COLOR;
	afterEach(() => {
		if (saved === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = saved;
	});

	it("drops colour but keeps emphasis", () => {
		process.env.NO_COLOR = "1";
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR codes
		const colourCodes = /\x1b\[(3[0-7]|38|4[0-7]|48|9[0-7])[;m]/;
		const out = paint("hi", { color: "#ff0000", bg: "#00ff00", bold: true });
		expect(out).not.toMatch(colourCodes);
		expect(out).toContain("\x1b[1m");
		expect(gradientAnsi("cast")).not.toMatch(colourCodes);
	});

	it("an empty NO_COLOR does not switch colour off", () => {
		process.env.NO_COLOR = "";
		expect(paint("hi", { color: "#ff0000" }).includes("\x1b[38")).toBe(true);
	});
});
