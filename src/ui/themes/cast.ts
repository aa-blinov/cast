import type { Theme } from "./types.ts";

/** The default cast theme — a cohesive cyan→violet palette. */
export const cast: Theme = {
	id: "cast",
	label: "Cast (default)",
	description: "Cyan→violet gradient — the original cast palette",
	colors: {
		gradient: { from: "#38e0ff", to: "#a855f7" },
		user: "#5eead4",
		agent: "#a78bfa",
		tool: "#38bdf8",
		persona: "#c084fc",
		accent: "#38e0ff",
		success: "#34d399",
		warning: "#fbbf24",
		error: "#fb7185",
		muted: "#64748b",
		bg: "#08080a",
		bgSurface: "#0c181c",
		bgRaised: "#1b262a",
		bgHover: "#232f33",
		border: "#232f33",
		borderActive: "#232f33",
	},
};
