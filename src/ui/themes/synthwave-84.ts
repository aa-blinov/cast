import type { Theme } from "./types.ts";

/** Synthwave '84 — neon retro-futuristic palette on a deep purple background. */
export const synthwave84: Theme = {
	id: "synthwave-84",
	label: "Synthwave '84",
	description: "Neon retro-futurism — Robb Owen, 2018",
	colors: {
		gradient: { from: "#f92aad", to: "#03edf9" },
		user: "#36f9f6",
		agent: "#ff7edb",
		tool: "#b893ce",
		persona: "#ff7edb",
		accent: "#f92aad",
		success: "#72f1b8",
		warning: "#fede5d",
		error: "#fe4450",
		muted: "#848bbd",
	},
};
