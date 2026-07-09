import type { Theme } from "./types.ts";

export const nightOwl: Theme = {
	id: "night-owl",
	label: "Night Owl",
	description: "Colorful dark with blue focus — Sarah Drasner, VS Code",
	colors: {
		gradient: { from: "#82aaff", to: "#c792ea" },
		user: "#7fdbca",
		agent: "#addb67",
		tool: "#82aaff",
		persona: "#c792ea",
		accent: "#82aaff",
		success: "#addb67",
		warning: "#ffcb6b",
		error: "#ff5874",
		muted: "#637777",
	},
};
