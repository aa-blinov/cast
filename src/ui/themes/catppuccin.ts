import type { Theme } from "./types.ts";

/** Catppuccin Mocha — the dark variant, matching the TUI's black terminal bg. */
export const catppuccin: Theme = {
	id: "catppuccin",
	label: "Catppuccin",
	description: "Pastel dark — soothing pastel colors for the cozy night owl",
	colors: {
		gradient: { from: "#89b4fa", to: "#cba6f7" },
		user: "#89b4fa",
		agent: "#cba6f7",
		tool: "#89b4fa",
		persona: "#cba6f7",
		accent: "#89b4fa",
		success: "#a6e3a1",
		warning: "#f9e2af",
		error: "#f38ba8",
		muted: "#6c7086",
		bg: "#11111b",
		bgSurface: "#181825",
		bgRaised: "#1e1e2e",
		bgHover: "#313244",
		border: "#45475a",
		borderActive: "#585b70",
	},
};
