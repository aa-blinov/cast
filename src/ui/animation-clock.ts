/**
 * One clock for everything that animates while a turn runs (the spinners,
 * the status bar's elapsed time). Each tick is a full Ink frame: the whole
 * live region laid out and measured again, which is what costs CPU, not the
 * few characters that change. Separate timers at 100ms and 120ms (and one per
 * spinner) fell on different instants, ~18 frames a second, 20% of a core
 * spent waiting for the model; on one clock React commits them together.
 */

import { useEffect, useState } from "react";
import { loadSettings } from "../core/settings.ts";

/** 2fps. Every tick writes to the terminal, and a terminal jumps back to the bottom
 *  on output: at 8fps (125ms) scrolling up during a turn was undone within a frame.
 *  Slow enough to scroll and read, still visibly alive for a braille spinner. */
export const ANIMATION_TICK_MS = 500;

/** Read when a spinner or the status bar starts ticking, so a settings edit applies on the next turn. */
export function reduceMotion(): boolean {
	const env = process.env.CAST_REDUCE_MOTION;
	if (env !== undefined && env !== "") return env !== "0";
	return loadSettings().reduceMotion === true;
}

const subscribers = new Set<() => void>();
let timer: NodeJS.Timeout | undefined;

/** Re-renders the caller on every shared tick while `active`; returns the tick count. */
export function useAnimationTick(active = true): number {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (!active || reduceMotion()) return;
		const onTick = () => setTick((n) => n + 1);
		subscribers.add(onTick);
		timer ??= setInterval(() => {
			for (const fn of subscribers) fn();
		}, ANIMATION_TICK_MS);
		return () => {
			subscribers.delete(onTick);
			if (subscribers.size === 0 && timer) {
				clearInterval(timer);
				timer = undefined;
			}
		};
	}, [active]);
	return tick;
}
