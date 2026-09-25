// Themes are shared with the TUI, where a dim `muted` and a bright accent read
// fine against a terminal. The web draws small text on raised panels and
// labels on accent-filled buttons, so derive the pairs that have to stay
// legible (WCAG AA, 4.5:1) instead of trusting every palette to get them right.

const AA = 4.5;

function channels(hex) {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb) {
	return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(hex) {
	const [r, g, b] = channels(hex).map((v) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// The theme's own background reads as "dark text" without going pure black;
// fall back to whichever extreme reads better when it doesn't pass.
export function accentForeground(accent, bg) {
	if (contrast(bg, accent) >= AA) return bg;
	return contrast("#ffffff", accent) >= contrast("#000000", accent) ? "#ffffff" : "#000000";
}

// Walk `color` toward `text` only as far as `surface` needs, so a theme that
// already passes keeps its exact color.
export function readableText(color, text, surface, floor = AA) {
	const from = channels(color);
	const to = channels(text);
	for (let step = 0; step <= 20; step++) {
		const t = step / 20;
		const mixed = toHex(from.map((v, i) => v + (to[i] - v) * t));
		if (contrast(mixed, surface) >= floor) return mixed;
	}
	return text;
}

// Muted has to read on raised panels, dim on hovered rows, and dim must stay
// visibly brighter than muted or the two text levels swap places.
export function readableTextLevels({ muted, dim, text, surface, raised, hover }) {
	const mutedText = readableText(muted, text, raised);
	const dimOnHover = readableText(dim, text, hover);
	const dimText = readableText(dimOnHover, text, surface, contrast(mutedText, surface) + 1);
	return { mutedText, dimText };
}
