import {
	backgroundAnsi,
	foregroundAnsi,
	getTerminalColorMode,
	parseColor,
	styleTextWithAnsi,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { gradientHex } from "../ui/gradient.ts";

export interface Paint {
	/** A theme colour (`#rrggbb`). */
	color?: string;
	/** A theme colour behind the text. */
	bg?: string;
	bold?: boolean;
	italic?: boolean;
	dim?: boolean;
	underline?: boolean;
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
	const { color, bg, ...attributes } = style;
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

/** One character at a time along the brand gradient: the composer's edge. */
export function gradientLine(text: string, style: Paint = {}): string {
	const chars = [...text];
	const last = Math.max(1, chars.length - 1);
	return chars.map((char, i) => paint(char, { ...style, color: gradientHex(i / last) })).join("");
}
