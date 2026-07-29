/**
 * Score a haystack against a needle for the modal fuzzy filter.
 *
 * Substring matches always outrank subsequence matches: substring scores in
 * [101, 1000] (`1000 - idx`, floored so a hit deep in a long haystack still
 * beats every subsequence), subsequence in [MIN_SUBSEQUENCE_SCORE, 100]
 * (`100 - gaps`). Without the floor on substring, a session haystack tens of
 * KB long turned a legitimate substring hit at position 56k into a negative
 * score, and the `>= 0` filter silently discarded the row.
 *
 * Subsequence matches with gaps beyond MIN_SUBSEQUENCE_SCORE are rejected
 * (return -1) rather than kept at a token score of 1: a query whose letters
 * are scattered across unrelated words two screens apart isn't a match a
 * user recognizes as "found what I typed," it's noise that happened to share
 * characters — e.g. "login" fuzzy-matching a session about "gpt-4o" and
 * "plan" that never mentions login at all.
 *
 * Empty needle matches everything (returns 0) so the caller can short-circuit
 * filtering when the input is cleared.
 *
 * Inputs are pre-lowered by the caller — lowercase allocation lives in the
 * keystroke hot path, not here.
 */
const MIN_SUBSEQUENCE_SCORE = 50;

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
	const subsequenceScore = 100 - gaps;
	return subsequenceScore >= MIN_SUBSEQUENCE_SCORE ? subsequenceScore : -1;
}
