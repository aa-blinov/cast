import type { Span } from "./markdown-terminal.ts";
import { theme } from "./themes/index.ts";

// How a rendered markdown span and the transcript rail are coloured, with no
// drawing in it: the pi-tui transcript paints it.

/** Style for one rendered span, with tones resolved against the theme. */
/**
 * highlight.js scope → theme colour, in five buckets rather than a full
 * editor palette: a terminal theme has one hue per role, and a snippet in a
 * reply needs the shape (what is a string, what is a comment, where a name is)
 * rather than a colour per token class. `text` is a piece the grammar left
 * plain and keeps the default foreground — flat `accent` on everything is what
 * the highlighting replaces.
 *
 * Scopes arrive dotted ("title.function", "meta.string"), so the lookup walks
 * from the most specific prefix down.
 */
export function syntaxColor(scope: string): string | undefined {
	const colors = theme();
	const buckets: Record<string, string | undefined> = {
		text: undefined,
		comment: colors.muted,
		quote: colors.muted,
		meta: colors.muted,
		string: colors.success,
		char: colors.success,
		regexp: colors.success,
		addition: colors.success,
		number: colors.warning,
		literal: colors.warning,
		symbol: colors.warning,
		deletion: colors.error,
		keyword: colors.accent,
		built_in: colors.accent,
		operator: colors.accent,
		// Not `agent`: that is the colour of the rail this code sits behind, and
		// a function name in the rail's own hue reads as chrome.
		title: colors.user,
		section: colors.user,
		name: colors.user,
		tag: colors.user,
		type: colors.user,
		class: colors.user,
		"selector-tag": colors.user,
	};
	let key = scope;
	for (;;) {
		if (key in buckets) return buckets[key];
		const dot = key.lastIndexOf(".");
		if (dot === -1) return undefined;
		key = key.slice(0, dot);
	}
}

export function spanProps(span: Span): {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	dimColor?: boolean;
	underline?: boolean;
} {
	const colors = theme();
	const color =
		span.scope !== undefined
			? syntaxColor(span.scope)
			: span.tone === "code"
				? colors.accent
				: span.tone === "link"
					? colors.accent
					: span.tone === "quote" || span.tone === "marker" || span.tone === "rule"
						? colors.muted
						: undefined;
	return {
		...(color ? { color } : {}),
		...(span.bold ? { bold: true } : {}),
		...(span.italic ? { italic: true } : {}),
		...(span.dim ? { dimColor: true } : {}),
		...(span.underline ? { underline: true } : {}),
	};
}

/**
 * The rail's own colour for a scaffolding row: `muted` is right in most
 * themes, but nord and solarized put it within 1.7–2.8:1 of the background,
 * where a one-cell bar disappears — those give the rail its own value.
 */
export function railMuted(): string {
	const colors = theme();
	return colors.rail ?? colors.muted;
}
