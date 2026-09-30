import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StatusBarConfig } from "../core/settings.ts";
import { fitSegments, getStatusBarSegments, type SegmentContext } from "../ui/statusbar.ts";
import { theme } from "../ui/themes/index.ts";
import { type Paint, paint } from "./paint.ts";

const SEPARATOR = " │ ";

/** Who and what mode you are in stand out; the numbers behind them stay quiet. */
function segmentStyle(id: string, ctx: SegmentContext): Paint {
	const colors = theme();
	if (id === "persona") return { color: colors.persona, bold: true };
	if (id === "worktree") return { color: colors.warning };
	if (id === "mode") return ctx.planMode ? { color: colors.warning, bold: true } : { color: colors.muted };
	if (id === "model") return { color: colors.muted };
	return { color: colors.muted, dim: true };
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
			.map((item) => paint(item.text, segmentStyle(item.id, ctx)))
			.join(paint(SEPARATOR, { color: theme().muted, dim: true }));
	const left = group("left");
	const right = group("right");
	if (!right) return truncateToWidth(left, columns, "…");
	const gap = Math.max(1, columns - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(left + " ".repeat(gap) + right, columns, "…");
}
