/** The window title while a turn runs. A title is not screen content, so updating it
 *  does not make a terminal jump to the bottom the way a repaint does. */
export function workingTitle(elapsedMs: number): string {
	return `\x1b]0;cast · working ${Math.floor(elapsedMs / 1000)}s\x07`;
}
