import { describe, expect, it } from "vitest";
import {
	collapseMidWordBoundaries,
	mergeMidWordBoundary,
	splitReasoningForDisplay,
} from "../src/web/public/reasoning-split.js";

describe("splitReasoningForDisplay", () => {
	it("returns the original reasoning unchanged when no markdown heading is present", () => {
		const reasoning = "Just thinking here, no structure, no markdown headings at all.";
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(reasoning);
		expect(result.draft).toBeNull();
	});

	it("returns empty thinking and null draft for empty input", () => {
		const result = splitReasoningForDisplay("");
		expect(result.thinking).toBe("");
		expect(result.draft).toBeNull();
	});

	it("does not split when a heading exists but has no content after it", () => {
		// Model planned an outline but never wrote anything under it — leave
		// the whole reasoning block intact, the heuristic would misfire otherwise.
		const reasoning = "Some thinking about structure.\n\n# Planned Section\n\n";
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(reasoning);
		expect(result.draft).toBeNull();
	});

	it("does not split when the heading is the last line of the reasoning", () => {
		const reasoning = "Thinking...\n# Answer";
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(reasoning);
		expect(result.draft).toBeNull();
	});

	it("extracts the draft answer starting at the last heading with content", () => {
		// Canonical MiniMax-M3 truncation: the model ran out of tokens inside
		// <think>, so the entire reasoning including the start of the answer
		// landed in completion.thinking. Split it into the user's view.
		const reasoning = [
			"Пользователь спрашивает прогноз погоды в Астане.",
			"Я нашёл актуальные данные от Sinoptik и world-weather.",
			"Самым актуальным будет SINOPTIK, который показывает 10 дней.",
			"",
			"Данные от SINOPTIK:",
			"- Вт 28 июля: мин +19, макс +30",
			"- Ср 29 июля: мин +21, макс +31",
			"",
			"# Погода в Астане на неделю (30 июля — 5 августа 2026)",
			"",
			"Источники: Sinoptik, World-Weather, Gismeteo.",
		].join("\n");
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(
			[
				"Пользователь спрашивает прогноз погоды в Астане.",
				"Я нашёл актуальные данные от Sinoptik и world-weather.",
				"Самым актуальным будет SINOPTIK, который показывает 10 дней.",
				"",
				"Данные от SINOPTIK:",
				"- Вт 28 июля: мин +19, макс +30",
				"- Ср 29 июля: мин +21, макс +31",
			].join("\n"),
		);
		expect(result.draft).toBe(
			[
				"# Погода в Астане на неделю (30 июля — 5 августа 2026)",
				"",
				"Источники: Sinoptik, World-Weather, Gismeteo.",
			].join("\n"),
		);
	});

	it("uses the LAST heading when multiple are present", () => {
		// Model planned two sections in its reasoning, then drafted the second
		// as the actual answer. Walking from the end makes this robust.
		const reasoning = [
			"План:",
			"# Section 1",
			"",
			"Details for section 1.",
			"",
			"# Section 2",
			"",
			"Details for section 2 — this is the actual answer.",
		].join("\n");
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(["План:", "# Section 1", "", "Details for section 1."].join("\n"));
		expect(result.draft).toBe(["# Section 2", "", "Details for section 2 — this is the actual answer."].join("\n"));
	});

	it("matches level-1 and level-2 markdown headings", () => {
		const withH1 = "thinking\n\n# H1\n\nanswer body";
		expect(splitReasoningForDisplay(withH1).draft).toBe("# H1\n\nanswer body");
		const withH2 = "thinking\n\n## H2\n\nanswer body";
		expect(splitReasoningForDisplay(withH2).draft).toBe("## H2\n\nanswer body");
		// Level 3+ are NOT split — reasoning legitimately uses ### sub-sections
		// mid-thought without intending to draft a final answer.
		const withH3 = "thinking\n\n### H3\n\nanswer body";
		expect(splitReasoningForDisplay(withH3).draft).toBeNull();
	});

	it("trims trailing whitespace from both halves", () => {
		const reasoning = "thinking\n\n# Heading\n\nanswer body\n\n\n";
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe("thinking");
		expect(result.draft).toBe("# Heading\n\nanswer body");
	});

	it("does not split on `#` without a space (not a heading, e.g. a GitHub issue ref)", () => {
		const reasoning = "Consider PR #42 for context. The fix is straightforward.";
		const result = splitReasoningForDisplay(reasoning);
		expect(result.thinking).toBe(reasoning);
		expect(result.draft).toBeNull();
	});

	it("does not split when a heading is mentioned mid-line (e.g. inline code)", () => {
		const reasoning = "Use the `# Title` format.\n\nAnswer body";
		// Mid-line `# Title` should not be treated as a heading boundary — the
		// regex anchors with ^, but the line above doesn't match anyway. The
		// second line "Answer body" is not a heading. Just confirms no false
		// split when there's content but no real heading-with-content.
		const result = splitReasoningForDisplay(reasoning);
		expect(result.draft).toBeNull();
	});
});

describe("mergeMidWordBoundary", () => {
	it("returns inputs unchanged when either side is empty", () => {
		expect(mergeMidWordBoundary("", "час уточню")).toEqual({ thinkingText: "", contentText: "час уточню" });
		expect(mergeMidWordBoundary("...weather.", "")).toEqual({ thinkingText: "...weather.", contentText: "" });
	});

	it("returns inputs unchanged when boundary is whitespace (clean split)", () => {
		const r = mergeMidWordBoundary("...weather. ", "час уточню");
		expect(r).toEqual({ thinkingText: "...weather. ", contentText: "час уточню" });
	});

	it("merges Cyrillic mid-word boundary — observed MiniMax-M3 case", () => {
		// Model emitted `<think>...weather.Сей</think>час уточню...` — the
		// parser split at the `</think>`, leaving "Сей" trailing in
		// reasoning and "час" leading in content. Glue back to "Сейчас".
		const r = mergeMidWordBoundary(
			"The user is asking about the weather in Astana. This is a current information query. I should use web_search to get the current weather.Сей",
			"час уточню текущую погоду в Астане.",
		);
		expect(r.thinkingText).toBe(
			"The user is asking about the weather in Astana. This is a current information query. I should use web_search to get the current weather.",
		);
		expect(r.contentText).toBe("Сейчас уточню текущую погоду в Астане.");
	});

	it("merges Latin mid-word boundary when fragment has internal sentence-ending punctuation", () => {
		// "...weather.Сейчас" — the period inside the fragment is the
		// sentence boundary the model intended; only the partial word
		// "Сей" crosses onto content.
		const r = mergeMidWordBoundary(
			"The user is asking about the weather in Astana. I should use web_search to get the current weather.Сей",
			"час уточню текущую погоду в Астане.",
		);
		expect(r.thinkingText).toBe(
			"The user is asking about the weather in Astana. I should use web_search to get the current weather.",
		);
		expect(r.contentText).toBe("Сейчас уточню текущую погоду в Астане.");
	});

	it("does NOT merge when the fragment ends with sentence-ending punctuation (clean sentence boundary)", () => {
		// Trailing period in the fragment is the sentence terminator —
		// the model meant a complete sentence in thinking and a new one
		// in content. Merging would strip the period off thinking and
		// paste it onto content, which reads worse than the split.
		const r = mergeMidWordBoundary("I should search for the weather.", "Now I will search for the forecast.");
		expect(r).toEqual({
			thinkingText: "I should search for the weather.",
			contentText: "Now I will search for the forecast.",
		});
	});

	it("does NOT merge when the fragment has no internal punctuation and content starts with a capital letter", () => {
		// Ambiguous case the heuristic can't safely resolve — could be
		// mid-word ("weather" + "Now" forming "weatherNow", as the model
		// truncated without a space) or a clean sentence boundary where
		// the model just omitted whitespace. Lean conservative — leave
		// the boundary alone. The user's bug (model emits </think>
		// mid-word) is caught by the punctuation-in-fragment case above.
		const r = mergeMidWordBoundary("I will check", "Now what is X");
		expect(r).toEqual({ thinkingText: "I will check", contentText: "Now what is X" });
	});

	it("does NOT merge when boundary is at whitespace, even mid-content", () => {
		const r = mergeMidWordBoundary("Answer starts here. ", "Next sentence.");
		expect(r).toEqual({ thinkingText: "Answer starts here. ", contentText: "Next sentence." });
	});

	it("does NOT merge across scripts (Latin thinking + Cyrillic content)", () => {
		// Guards against e.g. "API" + "час уточню" being merged into a fake word.
		const r = mergeMidWordBoundary("call the API", "час уточню");
		expect(r).toEqual({ thinkingText: "call the API", contentText: "час уточню" });
	});

	it("does NOT merge across scripts the other way (Cyrillic thinking + Latin content)", () => {
		// Last char of thinking is Cyrillic, first char of content is
		// Latin — different scripts, no merge. (The "web_sea" in the
		// middle is irrelevant; only the boundary chars matter.)
		const r = mergeMidWordBoundary("модель использует веб_поиск для выборк", "data");
		expect(r).toEqual({ thinkingText: "модель использует веб_поиск для выборк", contentText: "data" });
	});

	it("preserves all characters when merging (no silent loss)", () => {
		const thinkingText = "reasoning ends here.Сей";
		const contentText = "час уточню.";
		const r = mergeMidWordBoundary(thinkingText, contentText);
		// Concatenation must reproduce the original concatenation exactly.
		expect(r.thinkingText + r.contentText).toBe(thinkingText + contentText);
	});

	it("keeps a sentence-ending period in thinking, moves only the partial word to content", () => {
		// The fragment "weather.Сей" contains a `.` followed by "Сей" —
		// that's a real sentence boundary inside the fragment, so split
		// at it. Thinking keeps "weather." (with the period); content
		// picks up "Сейчас уточню...".
		const r = mergeMidWordBoundary(
			"The user is asking about the weather in Astana. I should use web_search to get the current weather.Сей",
			"час уточню текущую погоду в Астане.",
		);
		expect(r.thinkingText.endsWith("weather.")).toBe(true);
		expect(r.contentText.startsWith("Сейчас")).toBe(true);
		// Full concatenation still equals the original — no silent loss.
		const original =
			"The user is asking about the weather in Astana. I should use web_search to get the current weather.Сейчас уточню текущую погоду в Астане.";
		expect(r.thinkingText + r.contentText).toBe(original);
	});
});

describe("collapseMidWordBoundaries", () => {
	it("returns inputs unchanged when there are no thinking→content adjacencies", () => {
		const blocks = [
			{ kind: "thinking", text: "think" },
			{ kind: "tool", call: { id: "t1" } },
			{ kind: "content", text: "answer" },
		];
		expect(collapseMidWordBoundaries(blocks)).toEqual(blocks);
	});

	it("merges a thinking→content mid-word boundary", () => {
		// "...weather.Сей" → "...weather." (sentence boundary kept in
		// thinking); content picks up at "Сейчас" with the original
		// "час уточню..." glued on.
		const blocks = [
			{ kind: "thinking", text: "I should use web_search to get the current weather.Сей" },
			{ kind: "content", text: "час уточню..." },
		];
		const out = collapseMidWordBoundaries(blocks);
		expect(out[0]).toEqual({ kind: "thinking", text: "I should use web_search to get the current weather." });
		expect(out[1]).toEqual({ kind: "content", text: "Сейчас уточню..." });
	});

	it("leaves a clean whitespace boundary alone", () => {
		const blocks = [
			{ kind: "thinking", text: "I think about it." },
			{ kind: "content", text: "Here is my answer." },
		];
		expect(collapseMidWordBoundaries(blocks)).toEqual(blocks);
	});

	it("handles non-array input by returning it unchanged", () => {
		expect(collapseMidWordBoundaries(undefined)).toBeUndefined();
		expect(collapseMidWordBoundaries(null)).toBeNull();
	});

	it("does not merge across a tool block between thinking and content", () => {
		const blocks = [
			{ kind: "thinking", text: "...weather.Сей" },
			{ kind: "tool", call: { id: "t1" } },
			{ kind: "content", text: "час уточню..." },
		];
		expect(collapseMidWordBoundaries(blocks)).toEqual(blocks);
	});
});
