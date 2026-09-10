import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown } from "../src/server/public/markdown.js";

/**
 * The transcript renders markdown through dangerouslySetInnerHTML, and a URL
 * is interpolated into `href="…"`. escapeHtml did not escape quotes, so a URL
 * containing one closed the attribute and the rest became attributes:
 * `https://a.example"onmouseover="alert(1)` produced a working onmouseover
 * handler, running script in the daemon's own origin — where the session
 * cookie and the whole API live. The URL only has to reach the transcript,
 * which anything the model prints does.
 */
describe("escapeHtml", () => {
	it("escapes quotes as well as angle brackets and ampersands", () => {
		expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});
});

describe("renderMarkdown — attribute injection", () => {
	it("cannot break out of an href with a quote (regression)", () => {
		const out = renderMarkdown('https://a.example"onmouseover="alert(1)');
		expect(out).not.toMatch(/onmouseover=["']/);
		expect(out).toContain("&quot;onmouseover=&quot;");
	});

	it("cannot break out from a markdown link either", () => {
		const out = renderMarkdown('[t](https://a.example"onmouseover="alert(document.domain))');
		expect(out).not.toMatch(/onmouseover=["']/);
	});

	it("escapes single quotes too, for attributes written with them", () => {
		expect(renderMarkdown("https://a.example'onmouseover='alert(1)")).not.toMatch(/onmouseover='/);
	});

	it("still renders ordinary markdown", () => {
		expect(renderMarkdown("**bold** and `code`")).toBe("<p><strong>bold</strong> and <code>code</code></p>\n");
		expect(renderMarkdown("[link](https://example.com/a?b=1&c=2)")).toContain(
			'href="https://example.com/a?b=1&amp;c=2"',
		);
		expect(renderMarkdown("plain https://example.com/x")).toContain('<a href="https://example.com/x"');
	});

	it("still escapes script tags in text and in code fences", () => {
		expect(renderMarkdown("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(renderMarkdown("```\n<script>alert(1)</script>\n```")).toContain("&lt;script&gt;");
	});

	// The renderer emits no raw HTML of its own: an HTML token in the source
	// comes back as text. This is the layer the tests can check — DOMPurify,
	// the second one, needs a DOM and only runs in the browser.
	it("keeps inline and block HTML as text", () => {
		expect(renderMarkdown("текст <b>жирный</b> тут")).toBe("<p>текст &lt;b&gt;жирный&lt;/b&gt; тут</p>\n");
		expect(renderMarkdown('<img src=x onerror="alert(1)">')).not.toContain("<img");
		expect(renderMarkdown("<div onclick=alert(1)>x</div>")).not.toMatch(/<div[^>]*onclick/);
	});

	it("links only http/https/mailto, and leaves the rest as plain text", () => {
		expect(renderMarkdown("[x](javascript:alert(1))")).toBe("<p>x</p>\n");
		expect(renderMarkdown("[x](data:text/html;base64,PHNjcmlwdD4=)")).toBe("<p>x</p>\n");
		expect(renderMarkdown("[x](vbscript:msgbox)")).toBe("<p>x</p>\n");
		expect(renderMarkdown("[почта](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
		// An image is a link too: the page's CSP would block a remote <img>.
		expect(renderMarkdown("![alt](javascript:alert(1))")).toBe("<p>alt</p>\n");
		expect(renderMarkdown("![alt](https://x/y.png)")).toContain('<a href="https://x/y.png"');
	});
});

/**
 * The markdown the transcript actually gets. This set is what the hand-rolled
 * regex renderer got wrong: `2 * 3 * 4` came out with "3" in italics,
 * `` `a **b** c` `` put a <strong> inside the <code>, every heading level
 * collapsed to <strong>, and blockquotes, `---`, nested lists, task lists,
 * `~~strike~~`, `__bold__`, `~~~` fences and `1)` numbering did not render at
 * all.
 */
describe("renderMarkdown — structure", () => {
	it("gives each heading level its own tag", () => {
		expect(renderMarkdown("# один")).toBe("<h1>один</h1>\n");
		expect(renderMarkdown("### три")).toBe("<h3>три</h3>\n");
	});

	it("renders blockquotes and thematic breaks", () => {
		expect(renderMarkdown("> цитата")).toContain("<blockquote>");
		expect(renderMarkdown("текст\n\n---\n\nещё")).toContain("<hr>");
	});

	it("nests lists instead of flattening them", () => {
		const out = renderMarkdown("- один\n  - вложенный\n- два");
		expect(out).toMatch(/<li>один<ul>\s*<li>вложенный<\/li>/);
	});

	it("renders task lists as checkboxes", () => {
		const out = renderMarkdown("- [ ] todo\n- [x] done");
		expect(out).toContain('type="checkbox"');
		expect(out).toContain("checked");
		expect(out).not.toContain("[ ]");
	});

	it("supports the syntax the old renderer ignored", () => {
		expect(renderMarkdown("~~вычеркнуто~~")).toContain("<del>вычеркнуто</del>");
		expect(renderMarkdown("__жирный__")).toContain("<strong>жирный</strong>");
		expect(renderMarkdown("_курсив_")).toContain("<em>курсив</em>");
		expect(renderMarkdown("1) раз\n2) два")).toContain("<ol>");
		expect(renderMarkdown("~~~ts\nconst x = 1;\n~~~")).toContain("<code>const x = 1;");
	});

	it("leaves arithmetic and identifiers alone", () => {
		expect(renderMarkdown("2 * 3 * 4 = 24")).toBe("<p>2 * 3 * 4 = 24</p>\n");
		expect(renderMarkdown("файл src/my_file_name.ts")).toBe("<p>файл src/my_file_name.ts</p>\n");
	});

	it("does not format inside inline code", () => {
		expect(renderMarkdown("`a **b** c`")).toBe("<p><code>a **b** c</code></p>\n");
	});

	it("renders a fence inside a list item, and an unterminated one as code", () => {
		expect(renderMarkdown("- пункт:\n  ```ts\n  const x = 1;\n  ```")).toMatch(/<li>пункт:<pre>/);
		// Mid-stream the closing fence has not arrived yet.
		expect(renderMarkdown("```ts\nconst x = 1;")).toContain("<code>const x = 1;");
	});

	it("wraps a table so it can scroll, and keeps the header row", () => {
		const out = renderMarkdown("| файл | строк |\n|---|---:|\n| a.ts | 12 |");
		expect(out).toContain('<div class="md-table-wrap"><table><thead>');
		expect(out).toContain("<th>файл</th>");
		expect(out).toContain("<td>a.ts</td>");
	});

	it("keeps the code block's language label and copy button", () => {
		const out = renderMarkdown("```ts\nconst x = 1;\n```");
		expect(out).toContain('<div class="code-lang">ts</div>');
		expect(out).toContain('class="code-copy-btn"');
	});
});
