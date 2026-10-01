import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../ui/themes/index.ts";
import { paint } from "./paint.ts";

const SEPARATOR = " * ";
const HINTS = ["/ commands", "/settings", "Esc Esc stops a turn", "PageUp scrolls", "Ctrl+C twice quits"];

/** The first parts that fit `width` when joined by `separator`; the last ones are dropped whole, and the first is always kept. */
export function fitParts(parts: string[], separator: string, width: number): string[] {
	const kept = [...parts];
	while (kept.length > 1 && visibleWidth(kept.join(separator)) > width) kept.pop();
	return kept;
}

/**
 * The two rows at the top: `CAST(1) * persona * model * v1.2.3 * folder`, then a hint row.
 * One ` * ` between parts rather than padding to the edges, which is what a narrow
 * screen can spare; parts drop from the end, whole, before anything is cut.
 */
export function bannerRows(parts: string[], width: number): string[] {
	const muted = { color: theme().muted };
	const joiner = paint(SEPARATOR, muted);
	const header = fitParts(["CAST(1)", ...parts], SEPARATOR, width);
	const [name, ...rest] = header;
	const line = [paint(name ?? "", { bold: true }), ...rest.map((part) => paint(part, {}))].join(joiner);
	return [line, paint(fitParts(HINTS, SEPARATOR, width).join(SEPARATOR), muted)];
}
