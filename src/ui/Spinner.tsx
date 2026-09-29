import { Text } from "ink";
import type { JSX } from "react";
import { useAnimationTick } from "./animation-clock.ts";
import { gradientHex } from "./gradient.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated frame only, no label — shimmers through the active theme's gradient. */
export function Spinner(): JSX.Element {
	// The shared clock, so every spinner and the status bar tick in one frame.
	const frame = useAnimationTick() % FRAMES.length;
	const color = gradientHex(frame / (FRAMES.length - 1));
	return <Text color={color}>{FRAMES[frame]}</Text>;
}
