import { describe, expect, it } from "vitest";
import { splitReasoningForDisplay } from "../src/web/public/reasoning-split.js";

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
