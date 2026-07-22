import { Box, Text } from "ink";
import { type JSX, memo } from "react";
import { CAST_BANNER } from "../core/help.ts";
import { gradientHex } from "./gradient.ts";

/**
 * Startup banner, rendered as part of Ink's own tree instead of a plain
 * console.log before mount. gradientBanner() in gradient.ts builds the same
 * art as a raw ANSI string for contexts with no <Text> to hand a color prop
 * to (the pre-mount loader) — but printing it that way lands on the
 * primary screen buffer, which is invisible once the App below mounts into
 * Ink's alternate screen (see tui.tsx). Mirroring the same per-character
 * continuous-gradient algorithm as JSX keeps the banner inside the frame
 * Ink actually owns, so it survives the alt-screen switch and repaints
 * correctly on theme change.
 *
 * Memoized on [version, themeVer] — gradientHex per character isn't free,
 * and the banner never changes on its own between those.
 */
function BannerImpl({ version }: { version: string; themeVer: number }): JSX.Element {
	const lines = CAST_BANNER.split("\n");
	const totalChars = Math.max(1, lines.reduce((sum, line) => sum + [...line].length, 0) - 1);
	let charIdx = 0;
	return (
		<Box flexDirection="column">
			{lines.map((line, lineIdx) => {
				const chars = [...line];
				const start = charIdx;
				charIdx += chars.length;
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed banner text, lines never reorder
					<Text key={lineIdx} bold>
						{chars.map((ch, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed banner text, characters never reorder
							<Text key={i} color={gradientHex((start + i) / totalChars)}>
								{ch}
							</Text>
						))}
					</Text>
				);
			})}
			<Text> </Text>
			<Text dimColor>v{version}</Text>
		</Box>
	);
}

export const Banner = memo(BannerImpl);
