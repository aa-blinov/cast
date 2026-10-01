import {
	backgroundAnsi,
	foregroundAnsi,
	getTerminalColorMode,
	parseColor,
	styleTextWithAnsi,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../ui/themes/index.ts";
import { legible } from "./contrast.ts";
import { surfaceBackground } from "./surface.ts";

/** NO_COLOR set to anything but an empty string. */
export function noColor(): boolean {
	return (process.env.NO_COLOR ?? "") !== "";
}

export interface Paint {
	/** A theme colour (`#rrggbb`). */
	color?: string;
	/** A theme colour behind the text. */
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	dim?: boolean;
	underline?: boolean;
	/** Decoration (the brand gradient) that is not text: painted as given, without the legibility floor. */
	exact?: boolean;
}

const fgCache = new Map<string, string>();
const bgCache = new Map<string, string>();

function ansiFor(cache: Map<string, string>, color: string, make: typeof foregroundAnsi): string {
	let ansi = cache.get(color);
	if (ansi === undefined) {
		ansi = make(parseColor(color), getTerminalColorMode());
		cache.set(color, ansi);
	}
	return ansi;
}

/** Text in a theme colour and attributes, as the escape sequences the terminal's colour depth allows. */
export function paint(text: string, style: Paint = {}): string {
	if (text === "") return text;
	const { color: wanted, bg: wantedBg, exact, ...attributes } = style;
	// https://no-color.org: emphasis stays (bold, underline), colour goes; shape and words carry the meaning.
	const plain = noColor();
	const bg = plain ? undefined : wantedBg;
	// A theme's muted grey was under 4.5:1 on most of them, and dim takes away more.
	const color =
		wanted === undefined || plain
			? undefined
			: exact
				? wanted
				: legible(wanted, bg ?? surfaceBackground() ?? theme().bg);
	if (
		color === undefined &&
		bg === undefined &&
		!attributes.bold &&
		!attributes.italic &&
		!attributes.dim &&
		!attributes.underline
	)
		return text;
	return styleTextWithAnsi(
		text,
		color === undefined ? undefined : ansiFor(fgCache, color, foregroundAnsi),
		bg === undefined ? undefined : ansiFor(bgCache, bg, backgroundAnsi),
		attributes,
	);
}

/** `text` followed by enough spaces (in `bg`) to fill `width`; a row that has to look like a band. */
export function band(text: string, width: number, bg: string): string {
	return text + paint(" ".repeat(Math.max(0, width - visibleWidth(text))), { bg });
}
