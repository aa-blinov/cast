import { ProcessTerminal } from "@earendil-works/pi-tui";

// A terminal that is not in UTF-8 (LANG=C over ssh, a bare console) shows the box and
// arrow glyphs as garbage. One map, applied where bytes leave for the terminal, swaps
// each glyph the screen draws for a one-cell ASCII look-alike. A message's own text is
// left alone except for those same glyphs, which are harmless to swap.

const GLYPHS: Record<string, string> = {
	"─": "-",
	"━": "-",
	"│": "|",
	"┃": "|",
	"┆": "|",
	"╭": "+",
	"╮": "+",
	"╰": "+",
	"╯": "+",
	"┌": "+",
	"┐": "+",
	"└": "+",
	"┘": "+",
	"├": "+",
	"┤": "+",
	"┬": "+",
	"┴": "+",
	"┼": "+",
	"▸": ">",
	"→": ">",
	"←": "<",
	"↑": "^",
	"↓": "v",
	"↳": ">",
	"‹": "<",
	"›": ">",
	"…": "~",
	"—": "-",
	"–": "-",
	"✗": "x",
	"●": "*",
	"○": "o",
	"•": "*",
	"◦": "-",
	"▪": "+",
	"⠋": "|",
	"⠙": "/",
	"⠹": "-",
	"⠸": "\\",
	"⠼": "|",
	"⠴": "/",
	"⠦": "-",
	"⠧": "\\",
	"⠇": "|",
	"⠏": "/",
};

const UTF8_LOCALE_RE = /utf-?8/i;
const GLYPH_RE = new RegExp(`[${Object.keys(GLYPHS).join("")}]`, "g");

/** Whether to draw ASCII only: `CAST_ASCII=1` forces it, `=0` forbids it, otherwise a locale that is set and is not UTF-8. */
export function asciiOnly(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.CAST_ASCII !== undefined && env.CAST_ASCII !== "") return env.CAST_ASCII !== "0";
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
	return locale !== "" && !UTF8_LOCALE_RE.test(locale);
}

export function toAscii(text: string): string {
	return text.replace(GLYPH_RE, (glyph) => GLYPHS[glyph] ?? glyph);
}

/** The process terminal, swapping glyphs on the way out when the terminal needs ASCII. Widths do not change: each swap is one cell for one cell. */
class AsciiTerminal extends ProcessTerminal {
	override write(data: string): void {
		super.write(toAscii(data));
	}
}

export function makeTerminal(ascii = asciiOnly()): ProcessTerminal {
	return ascii ? new AsciiTerminal() : new ProcessTerminal();
}
