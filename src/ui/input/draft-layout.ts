/**
 * Wraps the composer draft into visual rows.
 *
 * Typing a long request has to look like typing: the text wraps at the
 * terminal's edge, the way it does everywhere else. What it must *not* do is
 * grow without limit — the composer lives inside Ink's live region, and a
 * region taller than the terminal makes Ink clear the screen *and* the
 * scrollback on every frame. So wrapping is bounded: the caller shows a window
 * of rows around the cursor (see MAX_COMPOSER_ROWS) and this module says which
 * rows exist and which one the cursor is on.
 *
 * Widths are display cells, measured per grapheme cluster, and a chip counts as
 * its whole label — the chip is one buffer character that renders as
 * `[Pasted 40 lines]`.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface VisualRow {
	/** Absolute buffer offsets of the row's text. */
	from: number;
	to: number;
	/** True when the row starts a buffer line (i.e. is not a wrap of one). */
	first: boolean;
}

export interface DraftLayout {
	rows: VisualRow[];
	/** Index in `rows` of the row the cursor sits on. */
	cursorRow: number;
}

export function layoutDraft(
	text: string,
	cursor: number,
	cells: number,
	width: (cluster: string) => number,
): DraftLayout {
	const budget = Math.max(1, cells);
	const pos = Math.max(0, Math.min(cursor, text.length));
	const rows: VisualRow[] = [];
	let cursorRow = 0;

	for (const line of splitLines(text)) {
		let rowStart = line.from;
		let used = 0;
		// Last point the row could break at without splitting a word. Zero means
		// "no break seen yet" — then a word longer than the row breaks mid-word,
		// which is the only way to show it at all.
		let breakAt = 0;
		let first = true;

		const pushRow = (to: number, nextStart: number) => {
			rows.push({ from: rowStart, to, first });
			first = false;
			rowStart = nextStart;
			used = 0;
			breakAt = 0;
		};

		for (const { segment, index } of GRAPHEMES.segment(line.text)) {
			const at = line.from + index;
			const w = width(segment);
			if (used + w > budget && at > rowStart) {
				// Break after the last space if there was one, so words stay
				// whole; the space itself stays on the row it ended.
				if (breakAt > rowStart) {
					// Capture it first: pushRow clears breakAt, and the tail
					// carried onto the new row has to be measured from there.
					const wrapAt = breakAt;
					pushRow(wrapAt, wrapAt);
					used = usedSince(line, wrapAt, at, width);
				} else {
					pushRow(at, at);
				}
			}
			used += w;
			if (segment === " ") breakAt = at + segment.length;
		}
		// Every buffer line contributes at least one row, so an empty line (and
		// an empty draft) still has somewhere to put the cursor.
		rows.push({ from: rowStart, to: line.from + line.text.length, first });
	}

	// A cursor sitting exactly at a wrap point belongs to the row it will type
	// into — the later one.
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]!;
		if (pos >= row.from && pos <= row.to) {
			cursorRow = i;
			if (pos === row.to && i + 1 < rows.length && rows[i + 1]!.from === pos) cursorRow = i + 1;
		}
	}
	return { rows, cursorRow };
}

/** Buffer lines with their absolute start offsets. */
function splitLines(text: string): Array<{ from: number; text: string }> {
	const out: Array<{ from: number; text: string }> = [];
	let from = 0;
	for (;;) {
		const nl = text.indexOf("\n", from);
		if (nl === -1) {
			out.push({ from, text: text.slice(from) });
			return out;
		}
		out.push({ from, text: text.slice(from, nl) });
		from = nl + 1;
	}
}

/** Cells occupied by `[from, to)` of a line — the tail carried to a new row. */
function usedSince(
	line: { from: number; text: string },
	from: number,
	to: number,
	width: (cluster: string) => number,
): number {
	let total = 0;
	for (const { segment } of GRAPHEMES.segment(line.text.slice(from - line.from, to - line.from))) {
		total += width(segment);
	}
	return total;
}

/** Cells from `from` to `to` — the cursor's visual column inside its row. */
export function cellColumn(text: string, from: number, to: number, width: (cluster: string) => number): number {
	let cells = 0;
	for (const { segment } of GRAPHEMES.segment(text.slice(from, to))) cells += width(segment);
	return cells;
}

/**
 * Offset in `row` nearest to a visual `column`, so ↑/↓ keep the cursor under
 * itself across wrapped rows of different character widths.
 */
export function offsetAtColumn(
	text: string,
	row: VisualRow,
	column: number,
	width: (cluster: string) => number,
): number {
	let cells = 0;
	for (const { segment, index } of GRAPHEMES.segment(text.slice(row.from, row.to))) {
		if (cells >= column) return row.from + index;
		cells += width(segment);
	}
	return row.to;
}
