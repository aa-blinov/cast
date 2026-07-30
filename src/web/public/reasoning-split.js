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
		if (/^#{1,6}\s/.test(lines[i].trim())) {
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
	if (splitIdx === -1) {
		// Fallback for MiniMax-M3 (and similar) that exhausts max_tokens
		// inside <think>...</think> before writing any heading. The last
		// non-empty paragraph is then the actual answer, and should land
		// in the [agent] block — otherwise it disappears into reasoning and
		// the user sees an empty draft + a populated reasoning bubble.
		//
		// Triggered only when the thinking side already contains markdown
		// structure (a heading, list, or numbered item). Without that signal
		// a blank line is just a normal paragraph break inside a single
		// reasoning block, and the "draft" we'd extract is indistinguishable
		// from the middle of a thought — splitting it out would put random
		// prose in [agent] and look like a hallucinated response.
		const thinkingHasStructure = lines.some((l) => /^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/.test(l));
		if (thinkingHasStructure) {
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].trim() === "") continue;
				let j = i;
				while (j > 0 && lines[j - 1].trim() !== "") j--;
				if (j === 0) break;
				if (lines[j - 1].trim() !== "") break;
				if (j - 1 < 1) break;
				// Refuse if the candidate draft is only headings (the model
				// planning structure but no prose yet) — same guard as the
				// heading-based branch above, just on a different boundary.
				const candidateDraft = lines.slice(j).join("\n").trim();
				const draftLines = candidateDraft
					.split("\n")
					.map((l) => l.trim())
					.filter(Boolean);
				const onlyHeadings = draftLines.length > 0 && draftLines.every((l) => /^#{1,6}\s+\S/.test(l));
				if (onlyHeadings) break;
				splitIdx = j;
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
