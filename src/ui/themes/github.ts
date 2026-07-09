import type { Theme } from "./types.ts";

export const github: Theme = {
	id: "github",
	label: "GitHub",
	description: "Clean blue-green — GitHub's UI palette",
	colors: {
		gradient: { from: "#0969da", to: "#8250df" },
		user: "#0969da",
		agent: "#1a7f37",
		tool: "#0969da",
		persona: "#8250df",
		accent: "#0969da",
		success: "#1a7f37",
		warning: "#9a6700",
		error: "#cf222e",
		muted: "#656d76",
	},
};
