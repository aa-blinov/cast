import type { Theme } from "./types.ts";

export const molokai: Theme = {
	id: "molokai",
	label: "Molokai",
	description: "Vim classic — bold colors on dark gray, 2008",
	colors: {
		gradient: { from: "#66d9ef", to: "#ae81ff" },
		user: "#66d9ef",
		agent: "#ae81ff",
		tool: "#66d9ef",
		persona: "#f92672",
		accent: "#66d9ef",
		success: "#a6e22e",
		warning: "#e6db74",
		error: "#f92672",
		muted: "#75715e",
		bg: "#08080a",
		bgSurface: "#0f171b",
		bgRaised: "#1e2629",
		bgHover: "#272f32",
		border: "#272f32",
		borderActive: "#272f32",
	},
};
