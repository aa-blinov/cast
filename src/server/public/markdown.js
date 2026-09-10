/**
 * Markdown rendering for the transcript, and the HTML escaping it relies on.
 *
 * marked does the parsing now. The hand-rolled regex renderer this replaces
 * got the common cases right and then fell over on the rest: `2 * 3 * 4`
 * rendered "3" in italics, `` `a **b** c` `` put a <strong> inside the
 * <code>, headings of every level collapsed to <strong>, and blockquotes,
 * `---`, nested lists, task lists, `~~strike~~`, `__bold__`, `~~~` fences and
 * `1)` numbering were not implemented at all. Regexes cannot see structure —
 * that is the whole reason a parser exists.
 *
 * Two layers keep the output safe, because it goes through
 * dangerouslySetInnerHTML and the source is model output (and the page's CSP
 * allows inline script, so an injected handler would run):
 *
 *  1. the renderer below never emits raw HTML — an HTML token from the source
 *     comes back escaped, and a link is only a link if its scheme is one of
 *     http/https/mailto;
 *  2. DOMPurify sanitizes the result anyway.
 *
 * Either layer alone would do; both cost nothing at runtime and the first one
 * is what the tests can check without a DOM.
 */
// Relative, not `/vendor/...`: the same specifier then resolves for the dev
// server, the production bundler (which inlines these two, while the 1MB
// highlight.js stays external and lazy behind its absolute path) and the
// tests, which import this module directly.
import DOMPurifyModule from "./vendor/dompurify.min.mjs";
import { Marked } from "./vendor/marked.min.mjs";

const markdownCache = new Map();
const CODE_COPY_ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>';
const CODE_COPY_BUTTON = `<button type="button" class="code-copy-btn" title="Copy" aria-label="Copy code">${CODE_COPY_ICON_SVG}</button>`;
const MARKDOWN_CACHE_LIMIT = 300;
/** Schemes a link may keep. Everything else (javascript:, data:, vbscript:) renders as plain text. */
const SAFE_URL_RE = /^(?:https?:\/\/|mailto:)/i;

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

/** The href to use, or null when the scheme is not one we will link to. */
function safeUrl(href) {
	const url = (href ?? "").trim();
	return SAFE_URL_RE.test(url) ? url : null;
}

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
	renderer: {
		// The copy button reads the sibling <code>'s textContent at click time
		// (see the delegated listener in app.js) rather than carrying the code
		// in a data attribute — simpler, and avoids escaping a large block into
		// an HTML attribute.
		code(text, lang) {
			const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : "";
			return `<pre>${CODE_COPY_BUTTON}${label}<code>${escapeHtml(text)}</code></pre>`;
		},
		link(href, title, text) {
			const url = safeUrl(href);
			if (!url) return text;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
		},
		// An <img> would be blocked by the page's CSP anyway (`img-src 'self'
		// data: blob:`), so an image reference becomes a link to it — which is
		// also what the previous renderer did with one, by not knowing it.
		image(href, title, text) {
			const url = safeUrl(href);
			const label = escapeHtml(text || url || "");
			return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
		},
		// Raw HTML in the source is text, not markup: the transcript renders
		// model output, and the page's CSP permits inline script.
		html(html) {
			return escapeHtml(html);
		},
		table(header, body) {
			return `<div class="md-table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
		},
	},
});

// The +esm build exports an already-initialised DOMPurify in a browser and the
// factory in an environment without a DOM (where sanitizing is moot and the
// renderer's own escaping is what the tests exercise).
const purify = typeof DOMPurifyModule?.sanitize === "function" ? DOMPurifyModule : null;
/** `target` on a link, and the checkbox a GFM task list renders. */
const SANITIZE_OPTIONS = { ADD_ATTR: ["target"] };

/**
 * `useCache = false` for the text of a turn that is still streaming: its text
 * is a different string every flush, so every one of those intermediate
 * versions was landing in the cache and evicting the finished messages it
 * exists to hold (300 entries, ~100 new versions per streamed answer). The
 * result is identical either way — this only decides whether it is remembered.
 */
function renderMarkdown(text, useCache = true) {
	if (!text) return "";
	if (useCache && markdownCache.has(text)) return markdownCache.get(text);
	const parsed = marked.parse(text);
	const out = purify ? purify.sanitize(parsed, SANITIZE_OPTIONS) : parsed;
	if (useCache) {
		if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
			const firstKey = markdownCache.keys().next().value;
			markdownCache.delete(firstKey);
		}
		markdownCache.set(text, out);
	}
	return out;
}

export { escapeHtml, renderMarkdown };
