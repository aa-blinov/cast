import type { Theme } from "./types.ts";

/** Ayu Dark. */
export const ayu: Theme = {
	id: "ayu",
	label: "Ayu",
	description: "Simple modern dark — clean lines, Sublime/VS Code favorite",
	colors: {
		gradient: { from: "#59c2ff", to: "#d2a6ff" },
		user: "#59c2ff",
		agent: "#aad94c",
		tool: "#59c2ff",
		persona: "#d2a6ff",
		accent: "#59c2ff",
		success: "#aad94c",
		warning: "#e6b450",
		error: "#ff7383",
		muted: "#636a72",
	},
};
