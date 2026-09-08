/**
 * The TUI printed the model's markdown verbatim, so a reply looked like
 * source: `##`, `**bold**`, backticks, ``` fences, `|---|` table rules. This
 * renderer turns it into terminal lines — and returns *lines*, already wrapped
 * to the width asked for, because the live-region clamp has to know how many
 * rows a block occupies before it renders (see ChatLog).
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ui/display-width.ts";
import { renderMarkdownLines, renderMarkdownTail } from "../src/ui/markdown-terminal.ts";

const plain = (line: { spans: Array<{ text: string }> }) => line.spans.map((s) => s.text).join("");
const render = (text: string, width = 60, indent = "") => renderMarkdownLines(text, { width, indent });

describe("renderMarkdownLines", () => {
	it("drops the markers and keeps the words", () => {
		const lines = render("## Result\n\nFound **three** and one *maybe* in `loop.ts`.");

		const text = lines.map(plain).join("\n");
		expect(text).toContain("Result");
		expect(text).toContain("Found three and one maybe in loop.ts.");
		expect(text).not.toContain("##");
		expect(text).not.toContain("**");
		expect(text).not.toContain("`");
	});

	it("marks emphasis on the spans instead", () => {
		const [line] = render("plain **bold** _italic_ `code`");

		const styled = line!.spans.filter((s) => s.text.trim());
		expect(styled.find((s) => s.text === "bold")?.bold).toBe(true);
		expect(styled.find((s) => s.text === "italic")?.italic).toBe(true);
		expect(styled.find((s) => s.text === "code")?.tone).toBe("code");
	});

	it("keeps every line inside the width, in cells", () => {
		// Cells, not characters: a CJK answer is twice as wide as its length.
		const text = `${"日本語のテキストです".repeat(20)}\n\nand some ascii ${"x".repeat(200)}`;

		for (const line of render(text, 40, "  ")) {
			expect(displayWidth(plain(line)), plain(line)).toBeLessThanOrEqual(40);
		}
	});

	it("gives list items a hanging indent so continuations line up", () => {
		const lines = render("- first item that is long enough to wrap onto another line for sure", 30);

		expect(plain(lines[0]!)).toMatch(/^• /);
		// The continuation is indented under the text, not under the bullet.
		expect(plain(lines[1]!)).toMatch(/^ {2}\S/);
	});

	it("keeps a fenced block's lines flagged as code", () => {
		const lines = render("before\n\n```ts\nconst x = 1;\n```\n\nafter");

		const code = lines.filter((line) => line.code);
		expect(code.length).toBeGreaterThan(0);
		expect(code.map(plain).join("\n")).toContain("const x = 1;");
		// Fence markers themselves are never printed.
		expect(lines.map(plain).join("\n")).not.toContain("```");
	});

	it("aligns a table into columns and drops the rule row", () => {
		const lines = render("| file | rows |\n|------|------|\n| loop.ts | 2840 |\n| session.ts | 1500 |", 40);

		const text = lines.map(plain).join("\n");
		expect(text).not.toContain("|");
		expect(text).not.toContain("---");
		// Both values start at the same column.
		const rows = lines.map(plain).filter((l) => l.includes("loop.ts") || l.includes("session.ts"));
		expect(rows).toHaveLength(2);
		expect(rows[0]!.indexOf("2840")).toBe(rows[1]!.indexOf("1500"));
	});

	it("renders a quote with a gutter and no > marker", () => {
		const lines = render("> note: careful");

		expect(plain(lines[0]!)).toContain("│ ");
		expect(plain(lines[0]!)).toContain("note: careful");
		expect(plain(lines[0]!)).not.toContain(">");
	});

	it("shows a link's text and its target", () => {
		const [line] = render("see [the changelog](https://example.com/x)");

		const text = plain(line!);
		expect(text).toContain("the changelog");
		expect(text).toContain("https://example.com/x");
		expect(text).not.toContain("](");
	});

	it("splits a word wider than the line instead of overflowing", () => {
		const lines = render(`a ${"x".repeat(120)} b`, 30);

		for (const line of lines) expect(displayWidth(plain(line))).toBeLessThanOrEqual(30);
		expect(lines.map(plain).join("")).toContain("x".repeat(30));
	});

	it("is deterministic for the same input and width", () => {
		const text = "## h\n\n- one\n- two\n\n```\ncode\n```\n";
		expect(render(text, 50)).toEqual(render(text, 50));
	});
});

describe("renderMarkdownTail", () => {
	const long = Array.from({ length: 200 }, (_, i) => `line ${i} of the answer`).join("\n");

	it("returns at most the requested number of lines, from the end", () => {
		const { lines, truncated } = renderMarkdownTail(long, { width: 60, maxLines: 5 });

		expect(lines).toHaveLength(5);
		expect(truncated).toBe(true);
		expect(plain(lines.at(-1)!)).toContain("line 199");
	});

	it("keeps code styling for a fence opened before the tail", () => {
		const text = `\`\`\`ts\n${Array.from({ length: 100 }, (_, i) => `const x${i} = ${i};`).join("\n")}`;

		const { lines } = renderMarkdownTail(text, { width: 60, maxLines: 4 });

		expect(lines.every((line) => line.code)).toBe(true);
	});

	it("returns everything when it fits, and says so", () => {
		const { lines, truncated } = renderMarkdownTail("one\ntwo", { width: 60, maxLines: 20 });

		expect(truncated).toBe(false);
		expect(lines.map(plain).join("\n")).toContain("one");
	});
});
