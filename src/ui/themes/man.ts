import type { Theme } from "./types.ts";

/**
 * The default on both screens: colour is held back for what needs it. One ochre accent
 * marks the chosen row, a command or a path; red is failure and nothing else. In the
 * terminal the page is the terminal's own and text colours are lifted to 4.5:1 on
 * whatever its background turns out to be; the browser draws `bg` itself.
 */
export const man: Theme = {
	id: "man",
	label: "Man page",
	description: "Terminal-native: bold headings, one ochre accent, no stripes or gradients",
	colors: {
		gradient: { from: "#d8a657", to: "#d8a657" },
		user: "#7daea3",
		agent: "#c8c8c8",
		tool: "#89b482",
		persona: "#d8a657",
		accent: "#d8a657",
		success: "#a9b665",
		warning: "#e78a4e",
		error: "#ea6962",
		muted: "#8a8f98",
		bg: "#0a0a0b",
		bgSurface: "#141416",
		bgRaised: "#1d1d20",
		bgHover: "#26262a",
		border: "#2a2a2e",
		borderActive: "#3a3a40",
		rail: "#5c6068",
	},
};
