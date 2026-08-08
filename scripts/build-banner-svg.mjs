// Generates assets/cast-banner.svg from the same block-character grid as
// CAST_BANNER (src/core/help.ts) and cast server's inline logo (app.js) — a
// static vector so the banner scales cleanly wherever <img> is honored
// (README on github.com, npm, forks), unlike a plain-text code fence which
// GitHub only ever lets scroll horizontally on narrow screens, never shrink.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Single source of truth, shared with src/core/help.ts (CLI banner) and
// src/server/public/app.js (cast server's logo) — see that JSON file's own comment.
const BANNER = JSON.parse(readFileSync(join(ROOT, "src", "web", "public", "cast-banner-grid.json"), "utf-8"));

// Terminal block-drawing chars, darkest→lightest fill.
const OPACITY = { "░": 0.35, "▒": 0.6, "▓": 0.85, "█": 1 };

const CELL = 10; // px per character cell in the source grid
const cols = Math.max(...BANNER.map((line) => line.length));
const rows = BANNER.length;
const width = cols * CELL;
const height = rows * CELL;

const rects = [];
for (let y = 0; y < rows; y++) {
	const line = BANNER[y];
	for (let x = 0; x < line.length; x++) {
		const ch = line[x];
		const opacity = OPACITY[ch];
		if (!opacity) continue; // space — background, no rect
		rects.push(`<rect x="${x * CELL}" y="${y * CELL}" width="${CELL}" height="${CELL}" fill="url(#grad)" opacity="${opacity}"/>`);
	}
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="cast">
	<defs>
		<linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
			<stop offset="0%" stop-color="#38e0ff"/>
			<stop offset="35%" stop-color="#38bdf8"/>
			<stop offset="70%" stop-color="#a78bfa"/>
			<stop offset="100%" stop-color="#a855f7"/>
		</linearGradient>
	</defs>
	${rects.join("\n\t")}
</svg>
`;

const outPath = join(ROOT, "assets", "cast-banner.svg");
writeFileSync(outPath, svg, "utf-8");
console.log(`Wrote ${outPath} (${width}x${height}, ${rects.length} cells)`);
