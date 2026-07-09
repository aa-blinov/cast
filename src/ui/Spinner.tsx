import { Text } from "ink";
import { type JSX, useEffect, useState } from "react";
import { gradientHex } from "./gradient.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Animated frame only, no label — shimmers through the active theme's gradient. */
export function Spinner(): JSX.Element {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	// ponytail: gradientHex called per-render (10 calls × 80ms). Fine for a
	// spinner; would matter at 60fps.
	const color = gradientHex(frame / (FRAMES.length - 1));
	return <Text color={color}>{FRAMES[frame]}</Text>;
}
