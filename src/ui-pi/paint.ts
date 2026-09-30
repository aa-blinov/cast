import { foregroundAnsi, getTerminalColorMode, parseColor, styleTextWithAnsi } from "@earendil-works/pi-tui";

export interface Paint {
	/** A theme colour (`#rrggbb`). */
	color?: string;
	bold?: boolean;
	italic?: boolean;
	dim?: boolean;
	underline?: boolean;
}

const fgCache = new Map<string, string>();

function fgAnsi(color: string): string {
	let ansi = fgCache.get(color);
	if (ansi === undefined) {
		ansi = foregroundAnsi(parseColor(color), getTerminalColorMode());
		fgCache.set(color, ansi);
	}
	return ansi;
}

/** Text in a theme colour and attributes, as the escape sequences the terminal's colour depth allows. */
export function paint(text: string, style: Paint = {}): string {
	if (text === "") return text;
	const { color, ...attributes } = style;
	if (color === undefined && !attributes.bold && !attributes.italic && !attributes.dim && !attributes.underline)
		return text;
	return styleTextWithAnsi(text, color === undefined ? undefined : fgAnsi(color), undefined, attributes);
}
