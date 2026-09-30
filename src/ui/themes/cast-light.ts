import type { Theme } from "./types.ts";

/** The cast palette for a light terminal: the same hues, dark enough to read on white. */
export const castLight: Theme = {
	id: "cast-light",
	label: "Cast light",
	description: "For light terminals: the cast hues, every text colour at 4.5:1 or better on white",
	terminalOnly: true,
	colors: {
		gradient: { from: "#0891b2", to: "#7e22ce" },
		user: "#0f766e",
		agent: "#6d28d9",
		tool: "#0369a1",
		persona: "#7e22ce",
		accent: "#0e7490",
		success: "#15803d",
		warning: "#b45309",
		error: "#be123c",
		muted: "#475569",
		bg: "#ffffff",
		bgSurface: "#f1f5f9",
		bgRaised: "#e2e8f0",
		bgHover: "#e2e8f0",
		border: "#cbd5e1",
		borderActive: "#94a3b8",
		rail: "#64748b",
	},
};
