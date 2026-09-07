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
		expect(renderMarkdown("**bold** and `code`")).toBe("<strong>bold</strong> and <code>code</code>");
		expect(renderMarkdown("[link](https://example.com/a?b=1&c=2)")).toContain(
			'href="https://example.com/a?b=1&amp;c=2"',
		);
		expect(renderMarkdown("plain https://example.com/x")).toContain('<a href="https://example.com/x"');
	});

	it("still escapes script tags in text and in code fences", () => {
		expect(renderMarkdown("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(renderMarkdown("```\n<script>alert(1)</script>\n```")).toContain("&lt;script&gt;");
	});
});
