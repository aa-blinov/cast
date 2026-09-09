/**
 * Highlighting a code block in a reply. The tokens come from highlight.js, but
 * through its emitter rather than its HTML — so the two things worth pinning
 * are that the scopes actually arrive (a missing `openNode` collected keywords
 * only), and that an unknown language stays plain instead of being guessed at.
 */
import { describe, expect, it } from "vitest";
import { highlightCode, resolveLanguage } from "../src/ui/syntax.ts";

// "-" is a piece the grammar left plain: highlightCode reports no scope for
// it, and the markdown renderer is what labels those "text" for the view.
const scopesOf = (lines: NonNullable<ReturnType<typeof highlightCode>>) =>
	lines.map((line) => line.map((token) => `${token.scope ?? "-"}:${token.text}`));

describe("resolveLanguage", () => {
	it("maps the tags a model actually writes", () => {
		expect(resolveLanguage("ts")).toBe("typescript");
		expect(resolveLanguage("TSX")).toBe("typescript");
		expect(resolveLanguage("sh")).toBe("bash");
		expect(resolveLanguage("yml")).toBe("yaml");
		expect(resolveLanguage("patch")).toBe("diff");
		expect(resolveLanguage("python")).toBe("python");
	});

	it("has no grammar for an unregistered or missing tag", () => {
		expect(resolveLanguage("cobol")).toBeUndefined();
		expect(resolveLanguage("")).toBeUndefined();
		expect(resolveLanguage(undefined)).toBeUndefined();
	});
});

describe("highlightCode", () => {
	it("scopes keywords, strings, numbers and comments", () => {
		const lines = highlightCode('// note\nconst x = "s";\nif (n > 3) {}', "ts");
		expect(lines).not.toBeNull();
		const scopes = scopesOf(lines!);
		expect(scopes[0]).toEqual(["comment:// note"]);
		expect(scopes[1]).toEqual(["keyword:const", "-: x = ", 'string:"s"', "-:;"]);
		expect(scopes[2]!.some((entry) => entry.startsWith("number:3"))).toBe(true);
	});

	it("keeps a token's scope across the lines it spans", () => {
		const lines = highlightCode("/* one\n   two */\nx", "ts");
		expect(scopesOf(lines!)).toEqual([["comment:/* one"], ["comment:   two */"], ["-:x"]]);
	});

	it("colours a diff block, which is what makes a patch readable", () => {
		const lines = highlightCode("--- a/x\n+++ b/x\n-gone\n+added\n same", "diff");
		const scopes = scopesOf(lines!);
		expect(scopes[2]).toEqual(["deletion:-gone"]);
		expect(scopes[3]).toEqual(["addition:+added"]);
		expect(scopes[4]).toEqual(["-: same"]);
	});

	it("returns null for an unknown language rather than guessing", () => {
		expect(highlightCode("x = 1", "cobol")).toBeNull();
		expect(highlightCode("x = 1", undefined)).toBeNull();
	});

	it("highlights a fragment — a snippet in a reply is rarely a whole file", () => {
		// Without ignoreIllegals a grammar's illegal rule aborts the highlight.
		const lines = highlightCode("} else {\n  return 1;\n}", "ts");
		expect(lines).not.toBeNull();
		expect(scopesOf(lines!)[0]!.some((entry) => entry.startsWith("keyword:else"))).toBe(true);
	});

	it("gives every source line a row, blank ones included", () => {
		const lines = highlightCode("a\n\nb", "python");
		expect(lines).toHaveLength(3);
		expect(lines![1]).toEqual([]);
	});
});
