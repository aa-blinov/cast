import type { Theme } from "./types.ts";

export const tomorrowNight: Theme = {
	id: "tomorrow-night",
	label: "Tomorrow Night",
	description: "Muted pastel dark — Chris Kempson, foundation for many forks",
	colors: {
		gradient: { from: "#81a2be", to: "#b294bb" },
		user: "#8abeb7",
		agent: "#b294bb",
		tool: "#81a2be",
		persona: "#b294bb",
		accent: "#81a2be",
		success: "#b5bd68",
		warning: "#f0c674",
		error: "#cc6666",
		muted: "#969896",
		bg: "#08080a",
		bgSurface: "#14161a",
		bgRaised: "#222529",
		bgHover: "#282b2f",
		border: "#282b2f",
		borderActive: "#282b2f",
	},
};
