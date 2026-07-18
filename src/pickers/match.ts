/**
 * Score a haystack against a needle for the modal fuzzy filter.
 *
 * Substring matches always outrank subsequence matches: substring scores in
 * [101, 1000] (`1000 - idx`, floored so a hit deep in a long haystack still
 * beats every subsequence), subsequence in [1, 100] (`100 - gaps`, floored so
 * a scattered match is weak but never dropped). Without the floors a session
 * haystack tens of KB long turned a legitimate substring hit at position 56k
 * into a negative score, and the `>= 0` filter silently discarded the row.
 * Empty needle matches everything (returns 0) so the caller can short-circuit
 * filtering when the input is cleared.
 *
 * Inputs are pre-lowered by the caller — lowercase allocation lives in the
 * keystroke hot path, not here.
 */
export function score(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	const idx = haystack.indexOf(needle);
	if (idx >= 0) return Math.max(1000 - idx, 101);
	let h = 0;
	let gaps = 0;
	for (const ch of needle) {
		const next = haystack.indexOf(ch, h);
		if (next < 0) return -1;
		if (next > h) gaps += next - h;
		h = next + 1;
	}
	return Math.max(100 - gaps, 1);
}
