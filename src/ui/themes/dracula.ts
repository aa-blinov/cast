import type { Theme } from "./types.ts";

export const dracula: Theme = {
	id: "dracula",
	label: "Dracula",
	description: "Purple-green on dark background — Zeno Rocha, 2013",
	colors: {
		gradient: { from: "#bd93f9", to: "#ff79c6" },
		user: "#8be9fd",
		agent: "#ff79c6",
		tool: "#bd93f9",
		persona: "#ff79c6",
		accent: "#bd93f9",
		success: "#50fa7b",
		warning: "#f1fa8c",
		error: "#ff5555",
		muted: "#6272a4",
		bg: "#21222c",
		bgSurface: "#282a36",
		bgRaised: "#343746",
		bgHover: "#44475a",
		border: "#44475a",
		borderActive: "#6272a4",
	},
};
