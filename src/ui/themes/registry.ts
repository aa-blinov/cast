/**
 * Theme registry. Holds all built-in themes, the active theme, and
 * get/set/load functions. The active theme is a module-level singleton — every
 * component that needs a color calls `theme()` which reads from it.
 */

import { ayu } from "./ayu.ts";
import { cast } from "./cast.ts";
import { catppuccin } from "./catppuccin.ts";
import { dracula } from "./dracula.ts";
import { everforest } from "./everforest.ts";
import { github } from "./github.ts";
import { gruvbox } from "./gruvbox.ts";
import { kanagawa } from "./kanagawa.ts";
import { molokai } from "./molokai.ts";
import { monokai } from "./monokai.ts";
import { nightOwl } from "./night-owl.ts";
import { nord } from "./nord.ts";
import { oneDark } from "./one-dark.ts";
import { rosePine } from "./rose-pine.ts";
import { solarized } from "./solarized.ts";
import { synthwave84 } from "./synthwave-84.ts";
import { tokyoNight } from "./tokyo-night.ts";
import { tomorrowNight } from "./tomorrow-night.ts";
import type { Theme, ThemeColors } from "./types.ts";

export const ALL_THEMES: Theme[] = [
	ayu,
	cast,
	catppuccin,
	dracula,
	everforest,
	github,
	gruvbox,
	kanagawa,
	molokai,
	monokai,
	nightOwl,
	nord,
	oneDark,
	rosePine,
	solarized,
	synthwave84,
	tokyoNight,
	tomorrowNight,
];

let active: Theme = cast;

/** Get the full active theme object. */
export function getActiveTheme(): Theme {
	return active;
}

/** Get just the colors of the active theme. */
export function theme(): ThemeColors {
	return active.colors;
}

/** Set the active theme by id. No-op if the id is unknown. */
export function setActiveTheme(id: string): void {
	const found = ALL_THEMES.find((t) => t.id === id);
	if (found) active = found;
}

/** Load theme from settings on startup. */
export function loadTheme(savedId?: string): void {
	if (savedId) setActiveTheme(savedId);
}
