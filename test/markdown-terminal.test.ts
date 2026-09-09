/**
 * The TUI printed the model's markdown verbatim, so a reply looked like
 * source: `##`, `**bold**`, backticks, ``` fences, `|---|` table rules. This
 * renderer turns it into terminal lines — and returns *lines*, already wrapped
 * to the width asked for, because the live-region clamp has to know how many
 * rows a block occupies before it renders (see ChatLog).
 */
import { describe, expect, it } from "vitest";
import { displayWidth } from "../src/ui/display-width.ts";
import {
	isTableLine,
	renderMarkdownLines,
	renderMarkdownTail,
	trailingOpenFence,
} from "../src/ui/markdown-terminal.ts";

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

describe("code blocks and tables", () => {
	// The fence's language tag is not printed, but it decides the grammar the
	// block is coloured with — and the block is highlighted as a whole, so a
	// comment or template literal spanning lines keeps its scope on each.
	it("carries syntax scopes into the spans of a fenced block", () => {
		const lines = renderMarkdownLines('```ts\nconst x = "s";\n```', { width: 60 });
		const spans = lines[0]!.spans.filter((span) => span.scope !== undefined);
		expect(spans.map((span) => [span.scope, span.text])).toEqual([
			["keyword", "const"],
			["text", " x = "],
			["string", '"s"'],
			["text", ";"],
		]);
	});

	it("leaves a block with no language, or an unknown one, flat", () => {
		for (const fence of ["```", "```cobol"]) {
			const lines = renderMarkdownLines(`${fence}\nconst x = 1;\n\`\`\``, { width: 60 });
			expect(lines[0]!.spans.every((span) => span.scope === undefined)).toBe(true);
			expect(lines[0]!.code).toBe(true);
		}
	});

	// Mid-stream the closing fence has not arrived yet; holding the block back
	// until it does would freeze the answer as it is being written.
	it("renders an unclosed fence", () => {
		const lines = renderMarkdownLines("```python\ndef f():\n    return 1", { width: 60 });
		expect(lines.map((line) => line.spans.map((span) => span.text).join(""))).toEqual(["def f():", "    return 1"]);
	});

	it("frames a table and rules its header off, but rules nothing with no data", () => {
		const table = renderMarkdownLines("| файл | строк |\n|---|---|\n| a.ts | 12 |", { width: 40, indent: "" });
		const text = table.map((line) => line.spans.map((span) => span.text).join(""));
		expect(text).toEqual([
			"┌──────┬───────┐",
			"│ файл │ строк │",
			"├──────┼───────┤",
			"│ a.ts │ 12    │",
			"└──────┴───────┘",
		]);
		// Nothing to rule off: a lone row is framed, not divided.
		const headerOnly = renderMarkdownLines("| файл | строк |", { width: 40, indent: "" });
		expect(headerOnly.map((line) => line.spans.map((span) => span.text).join(""))).toEqual([
			"┌──────┬───────┐",
			"│ файл │ строк │",
			"└──────┴───────┘",
		]);
	});
});

describe("lists", () => {
	it("draws a task list as boxes, not as typed-out brackets", () => {
		const lines = renderMarkdownLines("- [ ] сделать\n- [x] сделано\n- обычный пункт", { width: 40, indent: "" });
		expect(lines.map((line) => line.spans.map((span) => span.text).join(""))).toEqual([
			"☐ сделать",
			"☑ сделано",
			"• обычный пункт",
		]);
	});

	it("keeps a nested item under its parent's text, ordered lists included", () => {
		const lines = renderMarkdownLines("1. первый\n   1. вложенный\n- пункт\n  - вложенный", {
			width: 40,
			indent: "",
		});
		const text = lines.map((line) => line.spans.map((span) => span.text).join(""));
		// `1. ` is three cells wide, `• ` two — the indent follows the source.
		expect(text).toEqual(["1. первый", "   1. вложенный", "• пункт", "  ◦ вложенный"]);
	});

	it("gives each level its own bullet shape", () => {
		const lines = renderMarkdownLines("- a\n  - b\n    - c\n      - d", { width: 40, indent: "" });
		const markers = lines.map(
			(line) =>
				line.spans
					.map((span) => span.text)
					.join("")
					.trim()[0],
		);
		expect(markers).toEqual(["•", "◦", "▪", "▪"]);
	});

	it("wraps a long item under its own text, not under the marker", () => {
		const lines = renderMarkdownLines("10. очень длинный пункт списка который перенесётся", {
			width: 30,
			indent: "",
		});
		const text = lines.map((line) => line.spans.map((span) => span.text).join(""));
		expect(text[0]).toMatch(/^10\. /);
		expect(text[1]).toMatch(/^ {4}\S/);
	});
});

describe("a horizontal rule is not a table rule", () => {
	// Both match the same pattern; the pipe is what makes it a table's
	// alignment row. Treating a bare `---` as one swallowed the rule line and
	// left the *next* table without its header divider.
	it("draws `---` as a rule and still divides the table after it", () => {
		const lines = renderMarkdownLines("текст\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |", {
			width: 30,
			indent: "",
		});
		const text = lines.map((line) => line.spans.map((span) => span.text).join(""));
		expect(text).toContain("─".repeat(30));
		expect(text.filter((row) => row.startsWith("├"))).toHaveLength(1);
	});
});

describe("a table cut across chunks", () => {
	it("drops an alignment rule with no header above it, and keeps the rows as data", () => {
		const lines = renderMarkdownLines("|---|---:|\n| Температура | +14 °C |\n| Ветер | штиль |", {
			width: 50,
			indent: "",
		});
		const text = lines.map((line) => line.spans.map((span) => span.text).join(""));
		// No `---  ---:` row, and no rule dividing the first data row off as a
		// header — the header settled in the chunk before this one.
		expect(text).toEqual([
			"┌─────────────┬────────┐",
			"│ Температура │ +14 °C │",
			"│ Ветер       │ штиль  │",
			"└─────────────┴────────┘",
		]);
		expect(lines.every((line) => line.spans.every((span) => !span.bold))).toBe(true);
	});

	it("knows which lines a table owns", () => {
		expect(isTableLine("| a | b |")).toBe(true);
		expect(isTableLine("|---|---:|")).toBe(true);
		expect(isTableLine("| 1 |")).toBe(true);
		expect(isTableLine("обычный текст")).toBe(false);
		expect(isTableLine("")).toBe(false);
	});
});

describe("fenced blocks across chunk boundaries", () => {
	// The stream cuts an answer into chunks at line boundaries and promotes
	// them separately, so a chunk routinely starts inside a fenced block — or
	// with the *closing* fence, which read as an opening one and swallowed the
	// rest of the answer as flat code (a table after a code block came out as
	// raw `| a | b |` rows).
	it("reports the fence a chunk leaves open, with its language", () => {
		expect(trailingOpenFence("text\n```ts\nconst x = 1;")).toEqual({ language: "ts" });
		expect(trailingOpenFence("```ts\nconst x = 1;\n```")).toBeNull();
		expect(trailingOpenFence("```\nplain")).toEqual({});
		expect(trailingOpenFence("still code")).toBeNull();
		// Threaded: the chunk starts inside a fence and closes it.
		expect(trailingOpenFence("```\nprose", { language: "ts" })).toBeNull();
		expect(trailingOpenFence("more code", { language: "ts" })).toEqual({ language: "ts" });
	});

	it("keeps highlighting a block whose opener is in an earlier chunk", () => {
		const lines = renderMarkdownLines('const x = "s";', { width: 60, openFence: { language: "ts" } });
		expect(lines[0]!.code).toBe(true);
		expect(lines[0]!.spans.map((span) => span.scope)).toContain("keyword");
	});

	it("treats a chunk's leading ``` as the close it is, not a new block", () => {
		const lines = renderMarkdownLines("```\n\n| файл | строк |\n|---|---|\n| a.ts | 12 |", {
			width: 40,
			indent: "",
			openFence: { language: "ts" },
		});
		// A table, not five rows of flat code.
		const text = lines.map((line) => line.spans.map((span) => span.text).join(""));
		expect(text.some((row) => row.startsWith("┌"))).toBe(true);
		expect(text.some((row) => row.startsWith("├"))).toBe(true);
		expect(lines.every((line) => line.code !== true)).toBe(true);
	});
});
