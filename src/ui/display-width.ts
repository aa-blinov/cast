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

/** Above this, a line is measured every time instead of being retained. The
 *  lines this cache exists for — repeated prefixes and ordinary wrapped text —
 *  are far shorter than a terminal is wide. */
const MAX_CACHED_LINE_LENGTH = 4096;
/** Enough for a tall terminal's worth of distinct lines across a few frames. */
const MAX_CACHE_ENTRIES = 4096;

const cache = new Map<string, number>();

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
		(cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
		(cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		cp >= 0x1f300 // emoji & symbols (approximation)
	);
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
	let w = 0;
	for (const ch of line) {
		w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
		if (w > maxCells) return w;
	}
	rememberWidth(line, w);
	return w;
}

export function displayWidth(line: string): number {
	const cached = cache.get(line);
	if (cached !== undefined) return cached;
	let w = 0;
	for (const ch of line) {
		w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
	}
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
