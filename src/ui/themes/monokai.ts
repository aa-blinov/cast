import type { Theme } from "./types.ts";

export const monokai: Theme = {
	id: "monokai",
	label: "Monokai",
	description: "High contrast warm palette — Wimer Hazenberg, 2006",
	colors: {
		gradient: { from: "#f92672", to: "#ae81ff" },
		user: "#66d9ef",
		agent: "#f92672",
		tool: "#f92672",
		persona: "#ae81ff",
		accent: "#f92672",
		success: "#a6e22e",
		warning: "#e6db74",
		error: "#f92672",
		muted: "#75715e",
		bg: "#08080a",
		bgSurface: "#201219",
		bgRaised: "#2f2027",
		bgHover: "#312229",
		border: "#312229",
		borderActive: "#312229",
	},
};
