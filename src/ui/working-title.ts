import { useEffect } from "react";
import { reduceMotion } from "./animation-clock.ts";

/** The window title while a turn runs. A title is not screen content, so updating it
 *  does not make a terminal jump to the bottom the way a repaint does. */
export function workingTitle(elapsedMs: number): string {
	return `\x1b]0;cast · working ${Math.floor(elapsedMs / 1000)}s\x07`;
}

const IDLE_TITLE = "\x1b]0;cast\x07";

/** With `reduceMotion` the screen carries no animation, so this is the sign that a request is still going. */
export function useWorkingTitle(turnStartedAt: number | null): void {
	useEffect(() => {
		if (turnStartedAt === null || !reduceMotion()) return;
		const write = () => process.stdout.write(workingTitle(Date.now() - turnStartedAt));
		write();
		const timer = setInterval(write, 1000);
		return () => {
			clearInterval(timer);
			process.stdout.write(IDLE_TITLE);
		};
	}, [turnStartedAt]);
}
