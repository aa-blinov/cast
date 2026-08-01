// Native reasoning and content are already separate protocol channels. The
// only presentation adjustment retained here fixes an accidental mid-word
// boundary at an explicit <think> → content transition.
/**
 * When a model's reasoning→content boundary is mid-word (e.g. the model
 * emitted `<think>...weather.Сей</think>час уточню...` — the `</think>`
 * landed *inside* the Cyrillic word "Сейчас"), the parsed split is
 * artificial: the user reads "Сейчас" with the agent's answer, not
 * split as "Сей / час". Move the trailing word fragment from the
 * thinking side onto the start of the content side so the user sees
 * the model-intended continuous word.
 *
 * Conservative:
 * - both sides must have non-whitespace at the boundary (otherwise the
 *   parser already split on a clean boundary — leave it)
 * - both sides must be in the same Unicode script (Latin↔Latin,
 *   Cyrillic↔Cyrillic) — guards against e.g. "API" (Latin) + "час"
 *   (Cyrillic) being adjacent for unrelated reasons; cross-script
 *   merges are almost always wrong
 * - empty inputs are returned unchanged
 *
 * @param {string} thinkingText - text currently rendered as reasoning
 * @param {string} contentText - text currently rendered as agent content
 * @returns {{thinkingText: string, contentText: string}} - possibly
 *   merged versions of the two, or the originals unchanged if no merge
 *   condition holds.
 */
export function mergeMidWordBoundary(thinkingText, contentText) {
	if (!thinkingText || !contentText) return { thinkingText, contentText };
	const lastChar = thinkingText[thinkingText.length - 1];
	const firstChar = contentText[0];
	if (!/\S/.test(lastChar) || !/\S/.test(firstChar)) {
		return { thinkingText, contentText };
	}
	// Same-script guard — without this an "API" reasoning tail glued onto
	// "час уточню..." content would form a meaningless fake word. Punctuation
	// (".", "!", "?", ":", "…") is script-agnostic, so a thinking side
	// ending in "." or content starting with ":" is naturally excluded here.
	const lastCode = lastChar.charCodeAt(0);
	const firstCode = firstChar.charCodeAt(0);
	const isLatin = (c) => c >= 0x41 && c <= 0x7a;
	const isCyrillic = (c) => c >= 0x0400 && c <= 0x04ff;
	const scriptMatch = (isLatin(lastCode) && isLatin(firstCode)) || (isCyrillic(lastCode) && isCyrillic(firstCode));
	if (!scriptMatch) return { thinkingText, contentText };
	const fragmentMatch = thinkingText.match(/(\S+)$/);
	if (!fragmentMatch) return { thinkingText, contentText };
	const fragment = fragmentMatch[1];
	// Trailing sentence-ending punctuation in the fragment means the
	// reasoning sentence terminated at the boundary — keep the fragment
	// (period included) in thinking, do not merge. Catches the clean
	// "...weather." | "Now I will search" case where merging would
	// strip the period off thinking and paste it onto content.
	if (/[.!?…]$/.test(fragment)) {
		return { thinkingText, contentText };
	}
	// No trailing punct — look for the last sentence-ending punctuation
	// INSIDE the fragment (preceded by at least one more character so
	// it's a real boundary, not a single trailing period). Splitting
	// there keeps the period in thinking and moves only the partial
	// word to content — observed case: "...weather.Сей" | "час уточню".
	let lastPunctIdx = -1;
	for (let i = fragment.length - 2; i >= 0; i--) {
		const c = fragment[i];
		if (c === "." || c === "!" || c === "?" || c === ":" || c === "…") {
			lastPunctIdx = i;
			break;
		}
	}
	if (lastPunctIdx !== -1) {
		const keepInThinking = fragment.slice(0, lastPunctIdx + 1);
		const moveToContent = fragment.slice(lastPunctIdx + 1);
		return {
			thinkingText: thinkingText.slice(0, -fragment.length + keepInThinking.length).trimEnd(),
			contentText: moveToContent + contentText,
		};
	}
	// No sentence-ending punctuation anywhere in the fragment — we
	// can't tell whether the boundary is mid-word (truncated mid-token)
	// or a clean sentence break where the model just omitted whitespace
	// ("weather" + "Now I will"). Lean conservative: leave the boundary
	// alone. The mid-word cases that matter (MiniMax-M3 emitting
	// </think> inside a Cyrillic word) all have internal punctuation in
	// the fragment because the parser split mid-word right after a
	// sentence-ending period — caught by the branch above.
	return { thinkingText, contentText };
}

/**
 * Apply `mergeMidWordBoundary` to every adjacent (thinking, content) pair
 * across a stream block sequence. Used by the renderer so the agent's
 * answer reads as the model intended, not split across the thinking
 * boundary by a parser-side artifact.
 *
 * @param {Array<{kind: string, text: string}>} blocks - in-order blocks
 *   from a live streaming turn or a settled message.
 * @returns {Array<{kind: string, text: string}>} - same shape, with
 *   mid-word boundaries collapsed.
 */
export function collapseMidWordBoundaries(blocks) {
	if (!Array.isArray(blocks)) return blocks;
	const out = [];
	for (const block of blocks) {
		const prev = out[out.length - 1];
		if (prev && prev.kind === "thinking" && block.kind === "content") {
			const merged = mergeMidWordBoundary(prev.text, block.text);
			out[out.length - 1] = { ...prev, text: merged.thinkingText };
			out.push({ ...block, text: merged.contentText });
		} else {
			out.push(block);
		}
	}
	return out;
}
