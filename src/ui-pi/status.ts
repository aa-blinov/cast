import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "../core/settings.ts";
import { fitSegments, getStatusBarSegments, type SegmentContext } from "../ui/statusbar.tsx";
import { theme } from "../ui/themes/index.ts";
import { paint } from "./paint.ts";

const SEPARATOR = " │ ";

/** Segments that are not plain muted text, as the Ink status bar colours them. */
function segmentColor(id: string, ctx: SegmentContext): string {
	const colors = theme();
	if (id === "persona") return colors.persona;
	if (id === "worktree") return colors.warning;
	if (id === "mode" && ctx.planMode) return colors.warning;
	return colors.muted;
}

/**
 * The status bar as one row: the left group, the right group against the far
 * edge, and whole segments dropped (least useful first) when they do not fit.
 */
export function statusLine(ctx: SegmentContext, config: StatusBarConfig, columns: number): string {
	const visible = new Set(config.visible);
	const all = getStatusBarSegments();
	const ordered = [
		...config.order.map((id) => all.find((s) => s.id === id)).filter((s) => s !== undefined),
		...all.filter((s) => !config.order.includes(s.id)),
	];
	const shown = ordered.flatMap((segment) => {
		if (!visible.has(segment.id)) return [];
		const text = segment.formatValue(ctx);
		if (!text) return [];
		return [{ id: segment.id, side: config.sides[segment.id] ?? segment.side, text }];
	});
	const fitted = fitSegments(shown, columns, visibleWidth);
	const group = (side: "left" | "right") =>
		fitted
			.filter((item) => item.side === side)
			.map((item) => paint(item.text, { color: segmentColor(item.id, ctx), dim: true }))
			.join(paint(SEPARATOR, { color: theme().muted, dim: true }));
	const left = group("left");
	const right = group("right");
	if (!right) return truncateToWidth(left, columns, "…");
	const gap = Math.max(1, columns - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, columns, "…");
}
