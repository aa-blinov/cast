// WCAG contrast for the colours the screen paints text in. Themes are written
// against their own nominal background, but the text lands on whatever the
// terminal's is (or on a highlighted row), so the floor is checked where the
// text actually sits.

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function channels(hex: string): [number, number, number] | undefined {
	const match = HEX.exec(hex);
	return match
		? [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16), Number.parseInt(match[3]!, 16)]
		: undefined;
}

function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
	const first = channels(a);
	const second = channels(b);
	if (!first || !second) return 21;
	const [hi, lo] = [luminance(first), luminance(second)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const cache = new Map<string, string>();

/**
 * `color` nudged toward white (on a dark base) or black (on a light one), the
 * least that reaches `floor` against `base`. Unchanged when it already does,
 * or when either is not a `#rrggbb` hex.
 */
export function legible(color: string, base: string, floor = 4.5): string {
	const key = `${color}|${base}|${floor}`;
	const known = cache.get(key);
	if (known !== undefined) return known;
	const from = channels(color);
	const under = channels(base);
	let result = color;
	if (from && under && contrastRatio(color, base) < floor) {
		const target = luminance(under) < 0.5 ? 255 : 0;
		for (let amount = 0.04; amount <= 1.0001; amount += 0.04) {
			const mixed = from.map((c) => Math.round(c + (target - c) * amount));
			result = `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
			if (contrastRatio(result, base) >= floor) break;
		}
	}
	cache.set(key, result);
	return result;
}
