/**
 * Theme registry. Holds all built-in themes, the active theme, and
 * get/set/load functions. The active theme is a module-level singleton — every
 * component that needs a color calls `theme()` which reads from it.
 */

import { cast } from "./cast.ts";
import { catppuccin } from "./catppuccin.ts";
import { dracula } from "./dracula.ts";
import { github } from "./github.ts";
import { gruvbox } from "./gruvbox.ts";
import { monokai } from "./monokai.ts";
import type { Theme, ThemeColors } from "./types.ts";

export const ALL_THEMES: Theme[] = [cast, dracula, gruvbox, monokai, catppuccin, github];

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
