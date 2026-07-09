/**
 * Brand gradient + theme-aware color helpers. The active theme's gradient
 * endpoints drive the banner, spinner, and composer border; semantic colors
 * (user, agent, tool, etc.) are read directly from the theme registry.
 */
import { theme } from "./themes/index.ts";

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb: [number, number, number]): string {
	return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function lerpColor(t: number): [number, number, number] {
	const clamped = Math.max(0, Math.min(1, t));
	const [r1, g1, b1] = parseHex(theme().gradient.from);
	const [r2, g2, b2] = parseHex(theme().gradient.to);
	return [
		Math.round(r1 + (r2 - r1) * clamped),
		Math.round(g1 + (g2 - g1) * clamped),
		Math.round(b1 + (b2 - b1) * clamped),
	];
}

/** Hex color at position `t` (0 = gradient start, 1 = gradient end). */
export function gradientHex(t: number): string {
	return toHex(lerpColor(t));
}

/**
 * Per-character truecolor gradient, bold, as raw ANSI codes — for text
 * printed outside the Ink tree (plain console.log), where there's no <Text>
 * to hand a color prop to.
 */
export function gradientAnsi(text: string): string {
	const chars = [...text];
	const steps = Math.max(1, chars.length - 1);
	const painted = chars
		.map((ch, i) => {
			const [r, g, b] = lerpColor(i / steps);
			return `\x1b[38;2;${r};${g};${b}m${ch}`;
		})
		.join("");
	return `\x1b[1m${painted}\x1b[0m`;
}

/**
 * Multi-line banner with continuous per-character gradient across all lines
 * (gradient flows top-left → bottom-right, not restarting per line).
 * Returns pre-formatted ANSI string ready for console.log.
 */
export function gradientBanner(banner: string, version: string): string {
	const lines = banner.split("\n");
	// Flatten all characters across lines to compute a single gradient pass
	const allChars: string[] = [];
	for (const line of lines) allChars.push(...[...line], "\n");
	// Drop the trailing newline from the split
	if (allChars[allChars.length - 1] === "\n") allChars.pop();
	const total = Math.max(1, allChars.length - 1);
	let charIdx = 0;
	const result: string[] = [];
	for (const line of lines) {
		const chars = [...line];
		const painted = chars
			.map((ch) => {
				const [r, g, b] = lerpColor(charIdx / total);
				charIdx++;
				return `\x1b[38;2;${r};${g};${b}m${ch}`;
			})
			.join("");
		result.push(`\x1b[1m${painted}\x1b[0m`);
	}
	// Version line: dim, left-aligned under the banner
	result.push("");
	result.push(`\x1b[2mv${version}\x1b[0m`);
	return result.join("\n");
}
