/**
 * Split a reasoning block into "pure thinking" and a "draft answer" tail.
 *
 * Models that stream `<think>...</think>` inside `delta.content` (MiniMax-M3
 * is the canonical case observed in the wild — see src/core/vendors.ts:54
 * and src/core/llm.ts:578) can exhaust their `max_tokens` budget *inside* the
 * think block, before the closing tag. ThinkBlockParser then flushes the
 * entire buffer as reasoning and the model's draft answer — typically
 * introduced by a markdown heading — lands inside the [reasoning] block
 * with no [agent] counterpart.
 *
 * This is a pure presentation fix at the web layer: the server-side
 * reasoning string is left untouched (so reload from the saved session
 * still shows the original text), we just render the post-heading tail as
 * a separate agent block. Walking from the *last* heading makes the split
 * robust to a model that mentions markdown structure earlier in its
 * thinking and only writes a heading when it actually starts drafting the
 * answer; requiring non-empty content after the heading filters out models
 * that outline structure mid-thinking.
 *
 * Exported as a separate ES module so it can be unit-tested without
 * pulling the rest of the web bundle into the test runner.
 */

/**
 * @param {string} reasoning - the full reasoning text from a model turn
 * @returns {{thinking: string, draft: string | null}} - the thinking portion
 *   (everything before the draft answer) and the draft answer (the markdown
 *   heading and everything after it), or `draft: null` when no split
 *   boundary was found.
 */
export function splitReasoningForDisplay(reasoning) {
	if (!reasoning) return { thinking: "", draft: null };
	const lines = reasoning.split("\n");
	let splitIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^#{1,2}\s/.test(lines[i].trim())) {
			// Require at least one non-empty content line after the heading —
			// a heading alone (or followed only by whitespace) is the model
			// planning, not a draft.
			const after = lines
				.slice(i + 1)
				.join("\n")
				.trim();
			if (after.length > 0) {
				splitIdx = i;
				break;
			}
		}
	}
	if (splitIdx === -1) return { thinking: reasoning, draft: null };
	return {
		thinking: lines.slice(0, splitIdx).join("\n").trimEnd(),
		draft: lines.slice(splitIdx).join("\n").trimEnd(),
	};
}
