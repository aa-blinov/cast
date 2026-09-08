/**
 * Display-width cache for terminal column measurement.
 *
 * CJK and emoji code points occupy two cells; counting UTF-16 units
 * undercounts wrapped rows, which lets the live region overrun the viewport.
 * displayWidth() computes the real width; identical strings always produce
 * the same result, so the cache is safe.
 *
 * During streaming the same prefix lines are measured every ~16 ms frame.
 * The cache is flushed when streaming ends to free memory.
 *
 * Bounded, because the streaming tail line is a *different* string every
 * frame: measuring a 245KB single-line reasoning stream retained ~1000 keys
 * averaging ~122KB each — about 118MB of heap held until the turn ended.
 * Long lines are the ones that cost memory and the ones least likely to
 * repeat, so they aren't cached at all; the rest evict oldest-first.
 */

import { eastAsianWidth } from "get-east-asian-width";

/** Above this, a line is measured every time instead of being retained. The
 *  lines this cache exists for — repeated prefixes and ordinary wrapped text —
 *  are far shorter than a terminal is wide. */
const MAX_CACHED_LINE_LENGTH = 4096;
/** Enough for a tall terminal's worth of distinct lines across a few frames. */
const MAX_CACHE_ENTRIES = 4096;

const cache = new Map<string, number>();

/**
 * Zero-width code points: combining marks, the zero-width space/joiner family,
 * variation selectors' non-emoji half, and emoji skin-tone modifiers (which
 * attach to the preceding emoji rather than occupying their own cell).
 *
 * They used to count as one cell each, which is where the old measurement went
 * wrong on ordinary text: `école` with a combining acute measured 6 instead of
 * 5, and every emoji built from a ZWJ sequence measured far too wide.
 */
function isZeroWidth(cp: number): boolean {
	return (
		cp === 0x200b || // zero-width space
		cp === 0x200c || // zero-width non-joiner
		cp === 0xfeff || // BOM / zero-width no-break space
		(cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
		(cp >= 0x1ab0 && cp <= 0x1aff) ||
		(cp >= 0x1dc0 && cp <= 0x1dff) ||
		(cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
		(cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
		(cp >= 0x1f3fb && cp <= 0x1f3ff) || // emoji skin-tone modifiers
		(cp >= 0xe0100 && cp <= 0xe01ef) // variation selectors supplement
	);
}

/**
 * Terminal cells one line occupies, summed per code point with the pieces that
 * combine into one glyph folded into their base.
 *
 * The width table used to be hand-rolled ranges plus "everything at or above
 * U+1F300 is two cells", which was wrong in both directions and both
 * directions hurt: overcounting made the live region drop text that would have
 * fitted, undercounting let it overrun the viewport — the very failure this
 * module exists to prevent. Measured against `string-width` (the package Ink
 * itself measures with) on 33 strings, the old code disagreed on 8 of them:
 * `👨‍👩‍👧‍👦` was 11 cells instead of 2, `👨‍💻` 5 instead of 2, `👍🏽` 4 instead of 2,
 * while `🀄`, `🈁` and `⌚` were 1 instead of 2. This agrees with all 33 —
 * see test/display-width.test.ts, which cross-checks against string-width
 * directly — and stays a per-code-point loop, because string-width costs 46×
 * more (647ms against 14ms on one 240KB line, well past a 16ms frame).
 *
 * ANSI escapes are counted as printable, as they were before: the callers
 * measure model prose, not styled output.
 */
function accumulate(line: string, maxCells: number): number {
	let w = 0;
	// A ZWJ sequence renders as one glyph: the joiner and everything it joins
	// fold into the width of the first emoji.
	let afterZwj = false;
	// U+FE0F (emoji presentation) makes an otherwise narrow base two cells
	// wide — `❤` is one cell, `❤️` is two.
	let lastNarrow = false;
	for (const ch of line) {
		const cp = ch.codePointAt(0) ?? 0;
		if (afterZwj) {
			afterZwj = cp === 0x200d;
			lastNarrow = false;
			continue;
		}
		if (cp === 0x200d) {
			afterZwj = true;
			continue;
		}
		if (cp === 0xfe0f) {
			if (lastNarrow) {
				w += 1;
				lastNarrow = false;
			}
		} else if (cp === 0xfe0e) {
			lastNarrow = false;
		} else if (!isZeroWidth(cp)) {
			if (cp < 0x0300) {
				// Fast path for ASCII and Latin-1, which is most of every line.
				if (cp >= 0x20) {
					w += 1;
					lastNarrow = true;
				}
			} else {
				const wide = eastAsianWidth(cp, { ambiguousAsWide: false }) === 2;
				w += wide ? 2 : 1;
				lastNarrow = !wide;
			}
		}
		if (w > maxCells) return w;
	}
	return w;
}

/**
 * displayWidth, abandoned as soon as the width passes `maxCells` — the return
 * value is then only known to be greater than it.
 *
 * A caller that just needs "does this line fit in N rows?" stays proportional
 * to the budget instead of to the line. That matters for the streaming tail:
 * a single reasoning line grows into the hundreds of KB, is a different string
 * every frame (so nothing can cache it), and measuring it in full every frame
 * cost 36ms on a 244KB line — twice the frame budget.
 */
export function displayWidthAtMost(line: string, maxCells: number): number {
	const cached = cache.get(line);
	if (cached !== undefined) return cached;
	const w = accumulate(line, maxCells);
	if (w <= maxCells) rememberWidth(line, w);
	return w;
}

export function displayWidth(line: string): number {
	const cached = cache.get(line);
	if (cached !== undefined) return cached;
	const w = accumulate(line, Number.POSITIVE_INFINITY);
	rememberWidth(line, w);
	return w;
}

function rememberWidth(line: string, w: number): void {
	if (line.length <= MAX_CACHED_LINE_LENGTH) {
		if (cache.size >= MAX_CACHE_ENTRIES) {
			// Map iterates in insertion order, so the first key is the oldest.
			for (const oldest of cache.keys()) {
				cache.delete(oldest);
				break;
			}
		}
		cache.set(line, w);
	}
}

/** Flush the cache. Call when streaming ends to free memory. */
export function displayWidthCacheFlush(): void {
	cache.clear();
}

/**
 * The longest suffix of `line` that fits in `maxCells` terminal cells.
 *
 * The hard cut for a single over-long streaming line used to slice
 * `maxCells` *characters* off the end while calling the number a cell budget,
 * and the comment beside it claimed that erred short with wide characters. It
 * erred long, by exactly the character's width: 20,000 CJK characters clamped
 * to a 16-row budget on an 80-column terminal kept 1,280 characters — 2,560
 * cells, 32 rows. A live region taller than the viewport is the one thing the
 * clamp exists to prevent, because Ink cannot erase above the top of the
 * screen and every redraw then stacks another copy of the frame into
 * scrollback.
 *
 * Walked from the end, so the pieces of a ZWJ sequence are counted separately
 * — that overcounts a cluster split by the cut and therefore keeps slightly
 * less than the budget allows, which is the safe direction here.
 */
export function sliceTailToWidth(line: string, maxCells: number): string {
	if (maxCells <= 0) return "";
	// A suffix of at most `maxCells` code points is an upper bound: no code
	// point is narrower than one cell.
	const points = Array.from(line.length > maxCells * 2 ? line.slice(-maxCells * 2) : line);
	const tail = points.length > maxCells ? points.slice(-maxCells) : points;
	let cells = 0;
	let taken = 0;
	for (let i = tail.length - 1; i >= 0; i--) {
		const cp = tail[i]!.codePointAt(0) ?? 0;
		const w = cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e || isZeroWidth(cp) ? 0 : widthOfCodePoint(cp);
		if (cells + w > maxCells) break;
		cells += w;
		taken++;
	}
	return tail.slice(tail.length - taken).join("");
}

/** Cells one code point occupies on its own, ignoring what it combines with. */
function widthOfCodePoint(cp: number): number {
	if (cp < 0x0300) return cp >= 0x20 ? 1 : 0;
	return eastAsianWidth(cp, { ambiguousAsWide: false }) === 2 ? 2 : 1;
}
