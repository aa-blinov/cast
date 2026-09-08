/**
 * Horizontal window over the composer's single-line buffer, so the input is
 * always exactly one terminal row.
 *
 * Wrapping is what a shell does, but the composer sits *inside* Ink's live
 * region: a 600-character prompt wrapped to six rows pushed that region past
 * the terminal height, and Ink answers that by clearing the screen — and the
 * scrollback with it — on every frame. Measured while typing one long line at
 * 100 columns: 13 full clears, scroll position gone. Windowing keeps the row
 * count fixed no matter how long the draft gets, the way readline does.
 *
 * Ink's own `wrap="truncate"` can't do this: it always keeps the *head* of the
 * line, so the cursor disappears off the right edge as soon as the draft is
 * wider than the terminal.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Fraction of the row kept for text to the right of the cursor, so typing
 *  mid-draft still shows what comes next instead of pinning the cursor to the
 *  last column. */
const LOOKAHEAD = 4;

export interface LineWindow {
	/** UTF-16 slice bounds of the visible part of the line. */
	start: number;
	end: number;
	clippedLeft: boolean;
	clippedRight: boolean;
}

/**
 * `cells` is the room the row has; `width` measures one grapheme cluster in
 * cells — the caller passes a chip-aware measure, since a chip is one buffer
 * column that renders as its whole `[pasted 40 lines]` label.
 */
export function lineWindow(
	line: string,
	cursor: number,
	cells: number,
	width: (cluster: string) => number,
): LineWindow {
	const budget = Math.max(1, cells);
	const pos = Math.max(0, Math.min(cursor, line.length));
	// A cluster is at least one cell, so no more than `budget` of them can be
	// visible on either side — but one cluster can be many UTF-16 units (a
	// family emoji is 11), hence the factor. Segmenting only this much keeps
	// the cost off the length of the whole draft, as elsewhere in the input.
	const scan = budget * 8 + 32;

	const clusters = (from: number, to: number): Array<{ index: number; text: string }> => {
		const out: Array<{ index: number; text: string }> = [];
		for (const { segment, index } of GRAPHEMES.segment(line.slice(from, to))) {
			out.push({ index: from + index, text: segment });
		}
		return out;
	};

	// The cursor cell itself is always visible: it is either the cluster under
	// the cursor or, at end of line, the one-cell block drawn past the text.
	const ahead = clusters(pos, Math.min(line.length, pos + scan));
	const atCursor = ahead[0];
	let used = atCursor ? width(atCursor.text) : 1;

	// Right of the cursor first, capped, so the left side gets the remainder.
	const lookahead = Math.floor(budget / LOOKAHEAD);
	let end = atCursor ? atCursor.index + atCursor.text.length : pos;
	for (const cluster of ahead.slice(1)) {
		const w = width(cluster.text);
		if (used + w > Math.min(budget, used + lookahead)) break;
		used += w;
		end = cluster.index + cluster.text.length;
	}

	// Then left of the cursor, nearest first, with everything still unspent.
	const behind = clusters(Math.max(0, pos - scan), pos);
	let start = pos;
	for (let i = behind.length - 1; i >= 0; i--) {
		const cluster = behind[i]!;
		const w = width(cluster.text);
		if (used + w > budget) break;
		used += w;
		start = cluster.index;
	}

	// A short draft leaves room the lookahead cap withheld — spend it forward.
	for (const cluster of ahead.slice(1)) {
		if (cluster.index < end) continue;
		const w = width(cluster.text);
		if (used + w > budget) break;
		used += w;
		end = cluster.index + cluster.text.length;
	}

	return {
		start,
		end,
		clippedLeft: start > 0,
		clippedRight: end < line.length,
	};
}
