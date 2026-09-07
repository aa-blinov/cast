/**
 * Markdown rendering for the transcript, and the HTML escaping it relies on.
 *
 * Split out of app.js so the escaping can be tested directly: its output goes
 * through dangerouslySetInnerHTML, and a missing quote escape there was a real
 * XSS — a model-supplied URL containing a quote closed the href attribute and
 * the rest became an onmouseover handler, running in the daemon's own origin.
 */

const markdownCache = new Map();
const CODE_COPY_ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>';
const MARKDOWN_CACHE_LIMIT = 300;
const MARKDOWN_LIST_MARKER_RE = /^[ \t]*[-*] /;
const NEWLINE_RUN_RE = /\n+/;
const NUMBERED_LIST_MARKER_RE = /^[ \t]*\d+\. /;
const TABLE_SEPARATOR_RE = /^\|\s*[-:]+[-| :]*$/;
const TRAILING_NL_RE = /\n$/;
const TRAILING_PUNCTUATION_RE = /[.,!?;:]$/;

function escapeHtml(s) {
	if (!s) return "";
	// Quotes included: markdown output goes through dangerouslySetInnerHTML,
	// and a URL is interpolated into `href="…"`. Without escaping them, a URL
	// containing a quote closed the attribute and the rest of the "URL" became
	// attributes — `https://a"onmouseover="alert(1)` rendered as a working
	// onmouseover handler, running script in the daemon's own origin (where
	// the session cookie and the whole API live).
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function renderMarkdown(text) {
	if (!text) return "";
	if (markdownCache.has(text)) return markdownCache.get(text);

	// Pull fenced code blocks out first so inline rules below can't mangle
	// their contents; they go back in verbatim (already escaped) at the end.
	const fences = [];
	const src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
		const i = fences.length;
		const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
		// Copy button reads the sibling <code>'s textContent at click time (see
		// the delegated listener below) rather than carrying the code in a data
		// attribute — simpler, and avoids double-escaping a large code block
		// into an HTML attribute.
		const copyBtn = `<button type="button" class="code-copy-btn" title="Copy" aria-label="Copy code">${CODE_COPY_ICON_SVG}</button>`;
		fences.push(`<pre>${copyBtn}${label}<code>${escapeHtml(code.replace(TRAILING_NL_RE, ""))}</code></pre>`);
		return ` FENCE${i} `;
	});

	// Collapse runs of 2+ blank lines into one — .message-content renders with
	// white-space: pre-wrap, so every blank line in the source is a literal
	// gap on screen, and models frequently emit 2-3 in a row (especially
	// around lists/headings). Safe to do unconditionally on every render
	// (streaming included): it's a pure function of the current text, so it
	// can't desync from what's already on screen or cause a flicker.
	const collapsed = src.replace(/\n{3,}/g, "\n\n");

	let out = escapeHtml(collapsed);
	out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");

	// Links: markdown [text](url) first, then bare http(s) URLs — both pulled
	// into placeholders (same trick as the fenced-code blocks above) so the
	// second pass can't re-match text/attributes already inside an <a> the
	// first pass produced. `out` is already HTML-escaped at this point, so
	// the extracted url is safe to drop straight into an href attribute.
	const links = [];
	out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, linkText, url) => {
		const i = links.length;
		links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${linkText}</a>`);
		return ` LINK${i} `;
	});
	out = out.replace(/https?:\/\/[^\s<>()]+/g, (m) => {
		// Trailing sentence punctuation ("see https://x.com." or "(https://x.com)")
		// usually isn't part of the URL — trim it off before linking.
		let url = m;
		let trail = "";
		while (TRAILING_PUNCTUATION_RE.test(url)) {
			trail = url.slice(-1) + trail;
			url = url.slice(0, -1);
		}
		if (!url) return m;
		const i = links.length;
		links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
		return ` LINK${i} ${trail}`;
	});

	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
	out = out.replace(/^#{1,6} (.+)$/gm, "<strong>$1</strong>");

	// Group consecutive list lines into a single <ul>/<ol>. A blank line
	// between items is swallowed too (but only when another item follows —
	// the lookahead keeps it from also eating a blank line before unrelated
	// prose after the list), since "loose" lists with a blank line between
	// each item are common LLM output; without this, each item became its
	// own single-item <ol>, so every line rendered as "1." instead of
	// counting up.
	out = out.replace(/(?:^[ \t]*[-*] .+$\n?(?:\n(?=[ \t]*[-*] ))?)+/gm, (block) => {
		const items = block
			.trim()
			.split(NEWLINE_RUN_RE)
			.map((l) => `<li>${l.replace(MARKDOWN_LIST_MARKER_RE, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>\n`;
	});
	out = out.replace(/(?:^[ \t]*\d+\. .+$\n?(?:\n(?=[ \t]*\d+\. ))?)+/gm, (block) => {
		const items = block
			.trim()
			.split(NEWLINE_RUN_RE)
			.map((l) => `<li>${l.replace(NUMBERED_LIST_MARKER_RE, "")}</li>`)
			.join("");
		return `<ol>${items}</ol>\n`;
	});

	// Tables: | header | header |\n| --- | --- |\n| cell | cell |
	out = out.replace(/(?:^\|.+\|$\n?)+/gm, (block) => {
		const rows = block
			.trim()
			.split("\n")
			.filter((r) => r.trim());
		if (rows.length < 2) return block;
		// Check for separator row (| --- | --- |)
		const sepIdx = rows.findIndex((r) => TABLE_SEPARATOR_RE.test(r));
		if (sepIdx < 1) return block;
		const parseCells = (row) =>
			row
				.split("|")
				.slice(1, -1)
				.map((c) => c.trim());
		const headers = parseCells(rows[0]);
		const bodyRows = rows.slice(sepIdx + 1).map(parseCells);
		let html = '<div class="md-table-wrap"><table><thead><tr>';
		for (const h of headers) html += `<th>${h}</th>`;
		html += "</tr></thead><tbody>";
		for (const cells of bodyRows) {
			html += "<tr>";
			for (const c of cells) html += `<td>${c}</td>`;
			html += "</tr>";
		}
		html += "</tbody></table></div>";
		return html;
	});

	out = out.replace(/ FENCE(\d+) /g, (_m, i) => fences[Number(i)]);
	out = out.replace(/ ?LINK(\d+) ?/g, (_m, i) => links[Number(i)]);
	if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
		const firstKey = markdownCache.keys().next().value;
		markdownCache.delete(firstKey);
	}
	markdownCache.set(text, out);
	return out;
}

export { escapeHtml, renderMarkdown };
