import type { Theme } from "./types.ts";

/** Everforest — warm, low-contrast greens inspired by forest mornings. */
export const everforest: Theme = {
	id: "everforest",
	label: "Everforest",
	description: "Green forest palette, easy on the eyes — Sainnhe Park, 2020",
	colors: {
		gradient: { from: "#a7c080", to: "#7fbbb3" },
		user: "#83c092",
		agent: "#d699b6",
		tool: "#7fbbb3",
		persona: "#d699b6",
		accent: "#a7c080",
		success: "#a7c080",
		warning: "#dbbc7f",
		error: "#e67e80",
		muted: "#859289",
		bg: "#08080a",
		bgSurface: "#151614",
		bgRaised: "#232522",
		bgHover: "#2b2d2a",
		border: "#2b2d2a",
		borderActive: "#2b2d2a",
	},
};
