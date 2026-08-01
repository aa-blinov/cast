import htm from "htm";
import { h } from "preact";

const html = htm.bind(h);
const CAST_BANNER_LINES = await fetch("/cast-banner-grid.json").then((response) => response.json());
const CAST_LOGO_OPACITY = { "░": 0.35, "▒": 0.6, "▓": 0.85, "█": 1 };
const CAST_LOGO_CELL = 10;

export function CastLogo({ class: className }) {
	const rects = [];
	CAST_BANNER_LINES.forEach((line, y) => {
		for (let x = 0; x < line.length; x++) {
			const opacity = CAST_LOGO_OPACITY[line[x]];
			if (!opacity) continue;
			rects.push(
				html`<rect key=${`${x}-${y}`} x=${x * CAST_LOGO_CELL} y=${y * CAST_LOGO_CELL} width=${CAST_LOGO_CELL} height=${CAST_LOGO_CELL} fill="url(#cast-logo-grad)" opacity=${opacity} />`,
			);
		}
	});
	const width = Math.max(...CAST_BANNER_LINES.map((line) => line.length)) * CAST_LOGO_CELL;
	const height = CAST_BANNER_LINES.length * CAST_LOGO_CELL;
	return html`
		<svg class=${className} viewBox="0 0 ${width} ${height}" role="img" aria-label="cast">
			<defs><linearGradient id="cast-logo-grad" x1="0%" y1="0%" x2="100%" y2="0%"><stop class="cast-logo-grad-from" offset="0%" /><stop class="cast-logo-grad-to" offset="100%" /></linearGradient></defs>
			${rects}
		</svg>
	`;
}
