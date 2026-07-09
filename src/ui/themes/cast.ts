import type { Theme } from "./types.ts";

/** The default cast theme — cyan→violet gradient, unchanged from the original palette. */
export const cast: Theme = {
	id: "cast",
	label: "Cast (default)",
	colors: {
		gradient: { from: "#38e0ff", to: "#a855f7" },
		user: "#4dc9f6",
		agent: "#4ade80",
		tool: "#38e0ff",
		persona: "#7c3aed",
		accent: "#38e0ff",
		success: "#4ade80",
		warning: "#facc15",
		error: "#f87171",
		muted: "#6b7280",
	},
};
