import { colorToHex, mixColors, rgbColor, type TerminalColors } from "@earendil-works/pi-tui";

// A band behind the person's turns and a highlight for the chosen row have to work
// on the terminal that is actually there: a theme's own surface colours assume its
// background, and on a light terminal they made a dark stripe under dark text. So
// they are the terminal's own background nudged toward its own foreground, and
// absent (plain text, a marker instead) when the terminal will not say what they are.

let band: string | undefined;
let hover: string | undefined;
let terminalBackground: string | undefined;

const BAND_MIX = 0.07;
const HOVER_MIX = 0.16;

/** What the terminal reported for its default foreground and background (OSC 10 / 11). */
export function setSurfaces(colors: TerminalColors): void {
	const { foreground, background } = colors;
	terminalBackground = background ? colorToHex(rgbColor(background.r, background.g, background.b)) : undefined;
	if (!foreground || !background) {
		band = undefined;
		hover = undefined;
		return;
	}
	const bg = rgbColor(background.r, background.g, background.b);
	const fg = rgbColor(foreground.r, foreground.g, foreground.b);
	band = colorToHex(mixColors(bg, fg, BAND_MIX));
	hover = colorToHex(mixColors(bg, fg, HOVER_MIX));
}

/** The colour behind the person's turns, or undefined when the terminal's is unknown. */
export function surfaceBand(): string | undefined {
	return band;
}

/** The colour behind the chosen row of a list, or undefined when the terminal's is unknown. */
export function surfaceHover(): string | undefined {
	return hover;
}

/** The terminal's own background, or undefined when it did not say. */
export function surfaceBackground(): string | undefined {
	return terminalBackground;
}
