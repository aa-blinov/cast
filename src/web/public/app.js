/**
 * cast web — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { icons } from "./icons.js";

const html = htm.bind(h);

// Same mark as the CLI's startup banner (core/help.ts's CAST_BANNER) and the
// GitHub Pages/README SVG logo (scripts/build-banner-svg.mjs) — all three now
// read this one grid instead of each keeping its own copy that could drift.
// Fetched (not statically imported) because this file has no build step —
// see the header comment above — and a top-level await here blocks the rest
// of the module (including the initial render() call) until it resolves, so
// there's no flash of a missing logo while it loads.
// Absolute, not relative — a relative fetch resolves against the current
// page URL, which breaks on /shared/<token> (a different path serving this
// same app.js) since it'd then look for /shared/cast-banner-grid.json.
const CAST_BANNER_LINES = await fetch("/cast-banner-grid.json").then((r) => r.json());

// Terminal block-drawing chars, darkest→lightest fill (matches the CLI/site
// banner's own weighting so the shape reads the same everywhere).
const CAST_LOGO_OPACITY = { "░": 0.35, "▒": 0.6, "▓": 0.85, "█": 1 };
const CAST_LOGO_CELL = 10;

// Rendered as an inline SVG (not a static file/<img>) specifically so its
// gradient can be driven by the live theme via plain CSS `stop-color: var(...)`
// on the two <stop> elements below — an <img src="*.svg"> bakes its colors in
// at file-save time and can't react to a runtime /theme change the way the
// old text-clip ASCII version could.
function CastLogo({ class: className }) {
	const rects = [];
	CAST_BANNER_LINES.forEach((line, y) => {
		for (let x = 0; x < line.length; x++) {
			const opacity = CAST_LOGO_OPACITY[line[x]];
			if (!opacity) continue;
			rects.push(
				html`<rect key=${`${x}-${y}`} x=${x * CAST_LOGO_CELL} y=${y * CAST_LOGO_CELL} width=${CAST_LOGO_CELL} height=${CAST_LOGO_CELL} fill="url(#cast-logo-grad)" opacity=${opacity} />`,
			);
		}
	});
	const width = Math.max(...CAST_BANNER_LINES.map((l) => l.length)) * CAST_LOGO_CELL;
	const height = CAST_BANNER_LINES.length * CAST_LOGO_CELL;
	return html`
		<svg class=${className} viewBox="0 0 ${width} ${height}" role="img" aria-label="cast">
			<defs>
				<linearGradient id="cast-logo-grad" x1="0%" y1="0%" x2="100%" y2="0%">
					<stop class="cast-logo-grad-from" offset="0%" />
					<stop class="cast-logo-grad-to" offset="100%" />
				</linearGradient>
			</defs>
			${rects}
		</svg>
	`;
}

const isMac =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
const modKeys = isMac ? ["⌘"] : ["Ctrl"];
const modShiftKeys = isMac ? ["⌘", "⇧"] : ["Ctrl", "Shift"];
const modKey = modKeys.join("");
// kc() renders each key of a shortcut as its own key-cap chip instead of
// one flat text/ASCII string, so multi-key combos read like a keyboard.
const kc = (...keys) => keys.map((k) => `<kbd class="hotkey-key">${k}</kbd>`).join("");

const hotkeysHtml = `
	<div class="hotkey-group">
		<div class="hotkey-group-title">General</div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle sidebar</span><span class="hotkey-keys">${kc(...modKeys, "B")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Toggle diff</span><span class="hotkey-keys">${kc(...modShiftKeys, "D")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New session</span><span class="hotkey-keys">${kc(...modShiftKeys, "N")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Clear context</span><span class="hotkey-keys">${kc(...modShiftKeys, "L")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Show shortcuts</span><span class="hotkey-keys">${kc(...modKeys, "/")}</span></div>
	</div>
	<div class="hotkey-group">
		<div class="hotkey-group-title">Composer</div>
		<div class="hotkey-row"><span class="hotkey-label">Send message</span><span class="hotkey-keys">${kc("↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">New line</span><span class="hotkey-keys">${kc("⇧", "↵")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Abort run</span><span class="hotkey-keys">${kc("Esc")}</span></div>
		<div class="hotkey-row"><span class="hotkey-label">Navigate suggestions</span><span class="hotkey-keys">${kc("↑", "↓")}</span></div>
	</div>
`;

// ── API ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
	const opts = { method, headers: {} };
	if (body !== undefined) {
		opts.headers["Content-Type"] = "application/json";
		opts.body = JSON.stringify(body);
	}
	const res = await fetch(`${window.location.origin}${path}`, opts);
	if (res.status === 401) {
		// The browser normally attaches cached HTTP Basic Auth credentials to
		// every request automatically — a 401 here means they were rejected
		// (e.g. the password changed on disk). Reload to re-trigger the
		// browser's native credential prompt.
		window.location.reload();
		return null;
	}
	const data = await res.json().catch(() => null);
	if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
	return data;
}

// ── Theme ────────────────────────────────────────────────────────────
// Only accent colors are themed (16 palettes, shared with the TUI via
// settings.json's `theme` field) — background/border/text neutrals stay
// fixed so the "terminal control room" look holds regardless of palette.
function applyTheme(colors) {
	if (!colors) return;
	const root = document.documentElement.style;
	root.setProperty("--cyan", colors.accent);
	root.setProperty("--violet", colors.gradient.to);
	root.setProperty("--gradient", `linear-gradient(135deg, ${colors.gradient.from}, ${colors.gradient.to})`);
	// Standalone stops (not just the composed `--gradient` shorthand) — needed
	// so the SVG logo's <linearGradient> stops can track the theme via plain
	// CSS `stop-color: var(...)`, which can't parse a `linear-gradient(...)` value.
	root.setProperty("--gradient-from", colors.gradient.from);
	root.setProperty("--gradient-to", colors.gradient.to);
	root.setProperty("--teal", colors.user);
	root.setProperty("--purple", colors.agent);
	root.setProperty("--blue", colors.tool);
	root.setProperty("--green", colors.success);
	root.setProperty("--amber", colors.warning);
	root.setProperty("--rose", colors.error);
	root.setProperty("--persona", colors.persona);
	root.setProperty("--text-muted", colors.muted);
	// Cached so index.html's inline bootstrap script (which runs before this
	// module even starts fetching /api/themes+/api/config) can apply the same
	// colors synchronously on the very first paint — without it, every reload
	// briefly shows the CSS file's hardcoded default accent instead of the
	// theme actually saved on the server, most noticeable on a slow
	// connection or a non-default theme (see loading-spinner, which is
	// themed via --cyan same as everything else).
	try {
		localStorage.setItem("cast:themeColors", JSON.stringify(colors));
	} catch {}
}

// ── Font ─────────────────────────────────────────────────────────────
// A curated set of well-regarded monospace/coding fonts — not exhaustive,
// just fonts actually built for reading code (ligature/legibility-focused),
// all available from the same Google Fonts CDN style.css already depends
// on. JetBrains Mono (the built-in default) is loaded eagerly by style.css's
// own @import; every other family here is fetched on demand, only once
// actually picked — adding 9 more @import families up front would undo the
// whole point of trimming the dead Inter import (see style.css).
// index.html's inline bootstrap script keeps its own copy of each family
// string (it runs before this module does, same reasoning as applyTheme's
// cache) — update both if a family or id here changes.
// Alphabetical by label within each group — same convention as SETTINGS_TABS
// and SettingsTheme's swatch grid, so the picker order isn't just "however
// they were added". `mono: true` fonts apply to both --font and --font-mono
// (see applyFont) — a sans pick only ever touches --font, since --font-mono
// backs code blocks, tool-arg dumps, tables, and the ASCII banner, all of
// which depend on real monospace character alignment to not look broken.
// Every google id here was verified to actually 200 from fonts.googleapis.com
// (curled each css2?family=... individually) before adding it.
const FONT_OPTIONS = [
	// ── Monospace ──
	{
		id: "cousine",
		label: "Cousine",
		mono: true,
		family: "'Cousine', 'JetBrains Mono', monospace",
		google: "Cousine:wght@400;700",
	},
	{
		id: "fira-code",
		label: "Fira Code",
		mono: true,
		family: "'Fira Code', 'JetBrains Mono', monospace",
		google: "Fira+Code:wght@400;500;600;700",
	},
	{
		id: "ibm-plex-mono",
		label: "IBM Plex Mono",
		mono: true,
		family: "'IBM Plex Mono', monospace",
		google: "IBM+Plex+Mono:wght@400;500;600;700",
	},
	{
		id: "inconsolata",
		label: "Inconsolata",
		mono: true,
		family: "'Inconsolata', monospace",
		google: "Inconsolata:wght@400;500;600;700",
	},
	{
		id: "jetbrains-mono",
		label: "JetBrains Mono",
		mono: true,
		family: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
		google: null,
	},
	{
		id: "roboto-mono",
		label: "Roboto Mono",
		mono: true,
		family: "'Roboto Mono', monospace",
		google: "Roboto+Mono:wght@400;500;600;700",
	},
	{
		id: "source-code-pro",
		label: "Source Code Pro",
		mono: true,
		family: "'Source Code Pro', monospace",
		google: "Source+Code+Pro:wght@400;500;600;700",
	},
	{
		id: "space-mono",
		label: "Space Mono",
		mono: true,
		family: "'Space Mono', monospace",
		google: "Space+Mono:wght@400;700",
	},
	{
		id: "ubuntu-mono",
		label: "Ubuntu Mono",
		mono: true,
		family: "'Ubuntu Mono', monospace",
		google: "Ubuntu+Mono:wght@400;700",
	},
	{
		id: "victor-mono",
		label: "Victor Mono",
		mono: true,
		family: "'Victor Mono', 'JetBrains Mono', monospace",
		google: "Victor+Mono:wght@400;500;600;700",
	},
	// ── Sans-serif (--font only; --font-mono stays whatever mono font is active) ──
	{
		id: "ibm-plex-sans",
		label: "IBM Plex Sans",
		mono: false,
		family: "'IBM Plex Sans', sans-serif",
		google: "IBM+Plex+Sans:wght@400;500;600;700",
	},
	{ id: "inter", label: "Inter", mono: false, family: "'Inter', sans-serif", google: "Inter:wght@400;500;600;700" },
	{ id: "lato", label: "Lato", mono: false, family: "'Lato', sans-serif", google: "Lato:wght@400;700;900" },
	{
		id: "montserrat",
		label: "Montserrat",
		mono: false,
		family: "'Montserrat', sans-serif",
		google: "Montserrat:wght@400;500;600;700",
	},
	{
		id: "nunito",
		label: "Nunito",
		mono: false,
		family: "'Nunito', sans-serif",
		google: "Nunito:wght@400;500;600;700",
	},
	{
		id: "open-sans",
		label: "Open Sans",
		mono: false,
		family: "'Open Sans', sans-serif",
		google: "Open+Sans:wght@400;500;600;700",
	},
	{
		id: "poppins",
		label: "Poppins",
		mono: false,
		family: "'Poppins', sans-serif",
		google: "Poppins:wght@400;500;600;700",
	},
	{ id: "roboto", label: "Roboto", mono: false, family: "'Roboto', sans-serif", google: "Roboto:wght@400;500;700" },
	{
		id: "source-sans-3",
		label: "Source Sans 3",
		mono: false,
		family: "'Source Sans 3', sans-serif",
		google: "Source+Sans+3:wght@400;500;600;700",
	},
	{
		id: "work-sans",
		label: "Work Sans",
		mono: false,
		family: "'Work Sans', sans-serif",
		google: "Work+Sans:wght@400;500;600;700",
	},
];
const DEFAULT_FONT_ID = "jetbrains-mono";

// Injects (once) a <link> for a picked font's Google Fonts family — the same
// CDN style.css's @import already trusts, just loaded lazily per-pick
// instead of every family up front. `display=swap` means the UI keeps using
// the current font (no invisible-text flash) until the new one is ready,
// then swaps.
function loadGoogleFont(google) {
	if (!google) return;
	const id = `google-font-${google}`;
	if (document.getElementById(id)) return;
	const link = document.createElement("link");
	link.id = id;
	link.rel = "stylesheet";
	link.href = `https://fonts.googleapis.com/css2?family=${google}&display=swap`;
	document.head.appendChild(link);
}

// Purely client-side (localStorage), unlike applyTheme — there's no
// equivalent server-side setting to round-trip through, so this applies (and
// persists) immediately, no `/command` involved.
function applyFont(fontId) {
	const font = FONT_OPTIONS.find((f) => f.id === fontId) ?? FONT_OPTIONS.find((f) => f.id === DEFAULT_FONT_ID);
	loadGoogleFont(font.google);
	const root = document.documentElement.style;
	root.setProperty("--font", font.family);
	// --font-mono backs code blocks/tool args/tables/the ASCII banner — all
	// need real monospace alignment, so a sans pick only ever changes --font,
	// leaving whichever monospace font is active untouched.
	if (font.mono) root.setProperty("--font-mono", font.family);
	try {
		localStorage.setItem("cast:fontId", font.id);
	} catch {}
}

const FONT_SCALE_OPTIONS = [0.85, 0.9, 1, 1.1, 1.25, 1.5];
const DEFAULT_FONT_SCALE = 1;

function applyFontScale(scale) {
	document.documentElement.style.setProperty("--font-scale", String(scale));
	try {
		localStorage.setItem("cast:fontScale", String(scale));
	} catch {}
}

// ── Helpers ──────────────────────────────────────────────────────────
function escapeHtml(s) {
	if (!s) return "";
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Raw SVG markup (not preact elements — these live inside dangerouslySetInnerHTML
// markdown output) for the code-block copy button's two states. Same paths as
// icons.js's document-duplicate/check, genuine Heroicons v2.1.5 outline/24.
const CODE_COPY_ICON_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>';
const CODE_COPY_ICON_CHECK_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.75 6 6 9-13.5"/></svg>';

function renderMarkdown(text) {
	if (!text) return "";

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
		fences.push(`<pre>${copyBtn}${label}<code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
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
		while (/[.,!?;:]$/.test(url)) {
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
			.split(/\n+/)
			.map((l) => `<li>${l.replace(/^[ \t]*[-*] /, "")}</li>`)
			.join("");
		return `<ul>${items}</ul>\n`;
	});
	out = out.replace(/(?:^[ \t]*\d+\. .+$\n?(?:\n(?=[ \t]*\d+\. ))?)+/gm, (block) => {
		const items = block
			.trim()
			.split(/\n+/)
			.map((l) => `<li>${l.replace(/^[ \t]*\d+\. /, "")}</li>`)
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
		const sepIdx = rows.findIndex((r) => /^\|\s*[-:]+[-| :]*$/.test(r));
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
	return out;
}

// Recursively renders a parsed arg value as indented "key: value" lines.
// Plain JSON.stringify on nested objects (the previous approach) escapes any
// newline inside a nested string as a literal two-character "\n" — exactly
// the shape of the `edit` tool's args (ops: [{ content: "<multi-line code>" }]),
// so that turned into an unreadable wall of "\n"/"\t" text. Recursing instead
// of stringifying keeps every string's real line breaks intact at any depth.
function formatValue(v, indent) {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		return v.map((item, i) => `${indent}[${i}]\n${formatValue(item, `${indent}  `)}`).join("\n");
	}
	if (v && typeof v === "object") {
		return Object.entries(v)
			.map(([k, val]) => {
				const formatted = formatValue(val, `${indent}  `);
				return formatted.includes("\n") ? `${indent}${k}:\n${formatted}` : `${indent}${k}: ${formatted}`;
			})
			.join("\n");
	}
	return `${indent}${JSON.stringify(v)}`;
}

// Full parameter dump, not a truncated hint — the point is to see exactly
// what the agent is about to run, not just enough to guess.
function formatArgsFull(args) {
	if (!args) return "";
	try {
		const obj = JSON.parse(args);
		const entries = Object.entries(obj);
		if (entries.length === 0) return "";
		return entries
			.map(([k, v]) => {
				const formatted = typeof v === "string" ? v : formatValue(v, "  ");
				return formatted.includes("\n") ? `${k}:\n${formatted}` : `${k}: ${formatted}`;
			})
			.join("\n");
	} catch {
		return args;
	}
}

function shortPath(p) {
	if (!p) return "";
	const parts = p.split("/").filter(Boolean);
	if (parts.length <= 2) return p;
	return `…/${parts.slice(-2).join("/")}`;
}

const _WEB_TOOLS_OPTIONS = [
	{ value: "on", label: "Enable" },
	{ value: "off", label: "Disable" },
];

// ── URL routing ──────────────────────────────────────────────────────
// A query param, not a path segment (`/s/:id`) — the server's static file
// route only knows how to serve index.html for "/" itself, so anything path
// based would need a server-side change; "?session=" needs none, since the
// query string never affects which file gets served.
function sessionIdFromUrl() {
	return new URLSearchParams(window.location.search).get("session");
}
function setUrlSessionId(id, { push } = {}) {
	const url = `${window.location.pathname}?session=${encodeURIComponent(id)}`;
	if (push) window.history.pushState({ sessionId: id }, "", url);
	else window.history.replaceState({ sessionId: id }, "", url);
}

// ── Components ───────────────────────────────────────────────────────

// MCP tools are exposed to the model as "mcp_<server>_<tool>" (see
// core/mcp.ts's mcpToolName) — sanitized-and-joined with no reversible
// separator, so the server name can't be split back out exactly. Stripping
// the "mcp_" prefix and loosening the rest into "word · word" reads far
// better than the raw underscored blob without needing that split to be
// exact — this is a label only, the real name stays in `call.name`/data-tool.
function isMcpTool(name) {
	return name.startsWith("mcp_");
}
function mcpToolLabel(name) {
	return name.slice(4).replace(/_/g, " · ");
}

// todo_write's result is the same {todos, remaining} shape as its args
// (the full list echoed back) — but as one unindented JSON line, it reads
// as a wall of text next to the nicely indented args right above it.
// Reuse the same key:value renderer instead of dumping raw JSON.
function formatToolResult(name, result) {
	if (name !== "todo_write") return result;
	try {
		const parsed = JSON.parse(result);
		return formatValue(parsed, "");
	} catch {
		return result;
	}
}

function ToolCard({ call }) {
	// The header always shows the request (name + full input params) and a
	// status dot, so the terminal-like default view stays a quick "what's it
	// doing / is it still alive" scan. The result body is collapsed by
	// default and rendered lazily on first expand — unlike the TUI, the web
	// UI has room (and a scrollable DOM) to show it on demand without
	// cluttering the log.
	const [open, setOpen] = useState(false);
	const statusClass = call.status || "running";
	const args = formatArgsFull(call.args);
	const mcp = isMcpTool(call.name);
	const hasResult = Boolean(call.result);
	return html`
		<div class="tool-card">
			<div
				class="tool-card-header${hasResult ? " clickable" : ""}"
				data-tool=${call.name}
				onClick=${hasResult ? () => setOpen((o) => !o) : undefined}
			>
				${mcp && html`<span class="tool-card-mcp-badge">MCP</span>`}
				<span class="tool-card-name">${mcp ? mcpToolLabel(call.name) : call.name}</span>
				<span class="tool-card-status ${statusClass}" />
				${hasResult && html`<${open ? icons.chevronUp : icons.chevronDown} class="tool-card-toggle" />`}
			</div>
			${args && html`<div class="tool-card-body">${args}</div>`}
			${
				open &&
				hasResult &&
				(mcp
					? // MCP servers commonly format their own results as markdown (headers,
						// code fences, tables) — worth actually rendering, unlike a built-in
						// tool's result, which has a fixed non-markdown shape (e.g. read's
						// hashline anchors) that markdown rendering would corrupt.
						html`<div class="tool-card-result" dangerouslySetInnerHTML=${{ __html: renderMarkdown(call.result) }}></div>`
					: html`<div class="tool-card-result">${formatToolResult(call.name, call.result)}</div>`)
			}
		</div>
	`;
}

function Message({ msg }) {
	const role = msg.role || "assistant";
	if (role === "tool") return null;

	const labelMap = {
		user: "you",
		agent: "agent",
		assistant: "agent",
		system: "system",
		warning: "notice",
		error: "error",
	};

	// Messages flushed from a live turn this session carry the full ordered
	// block sequence (reasoning / prose / tool calls, same shape as
	// StreamingBlocks) instead of one flattened string — render each block
	// distinctly so reasoning doesn't silently blend into the reply, and so
	// every tool call this turn made stays visible after it settles.
	if (role === "assistant" && Array.isArray(msg.blocks)) {
		return html`
			<div class="message-group">
				${msg.blocks.map((block, i) => {
					if (block.kind === "tool") return html`<${ToolCard} key=${block.call.id} call=${block.call} />`;
					if (block.kind === "thinking") {
						if (!block.text.trim()) return null;
						return html`
							<div key=${i} class="message message-reasoning">
								<div class="message-label">reasoning</div>
								<div class="message-content">${block.text}</div>
							</div>
						`;
					}
					if (!block.text.trim()) return null;
					return html`
						<div key=${i} class="message message-assistant">
							<div class="message-label">agent</div>
							<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />
						</div>
					`;
				})}
			</div>
		`;
	}

	// content is `null` for a tool-call-only turn (see core/loop.ts) — treat
	// that as "no text", not the literal string "null" JSON.stringify gives it.
	const content =
		typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);

	if (role === "assistant") {
		return html`
			<div class="message-group">
				${
					msg.thinking &&
					html`
					<div class="message message-reasoning">
						<div class="message-label">reasoning</div>
						<div class="message-content">${msg.thinking}</div>
					</div>
				`
				}
				${msg.toolCalls?.map((tc) => html`<${ToolCard} key=${tc.id} call=${tc} />`)}
				${
					content &&
					html`
					<div class="message message-assistant">
						<div class="message-label">agent</div>
						<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }} />
					</div>
				`
				}
			</div>
		`;
	}

	return html`
		<div class="message message-${role}">
			<div class="message-label">${labelMap[role] ?? role}</div>
			<div class="message-content" dangerouslySetInnerHTML=${{ __html: role === "user" ? escapeHtml(content) : renderMarkdown(content) }} />
		</div>
	`;
}

// Some providers (observed on MiniMax-M2) interleave content/reasoning deltas
// out of order mid-turn — a token, a thinking chunk, then more tokens — which
// used to render as alternating "agent"/"reasoning" blocks with words split
// across the seam. Merge into the most recent block of the same kind instead
// of only the immediately-preceding one, so thrashing between the two channels
// collapses back into one coherent block each. Tool calls remain hard
// boundaries: text never merges across one, since that ordering is real.
function appendTextBlock(prev, kind, text) {
	for (let j = prev.length - 1; j >= 0; j--) {
		if (prev[j].kind === "tool") break;
		if (prev[j].kind === kind) {
			return [...prev.slice(0, j), { kind, text: prev[j].text + text }, ...prev.slice(j + 1)];
		}
	}
	return [...prev, { kind, text }];
}

function StreamingBlocks({ blocks }) {
	if (!blocks || blocks.length === 0) return null;
	return html`
		<div>
			${blocks.map((block, i) => {
				if (block.kind === "content") {
					return html`<div key=${i} class="streaming-block">
						<div class="streaming-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />
					</div>`;
				}
				if (block.kind === "thinking") {
					return html`<div key=${i} class="streaming-block streaming-thinking">
						<div class="streaming-content">${block.text}</div>
					</div>`;
				}
				if (block.kind === "tool") {
					return html`<${ToolCard} key=${block.call.id} call=${block.call} />`;
				}
				return null;
			})}
		</div>
	`;
}

// The three pickers below are pure display: Composer owns filtering AND
// selection so arrow-key nav and mouse click always agree on the same list.
function CommandPalette({ items, selectedIndex, running, onHover, onSelect, visible }) {
	if (!visible || items.length === 0) return null;

	return html`
		<div class="cmd-palette open">
			${items.map((c, i) => {
				const disabled = c.blocking && running;
				const cls = `cmd-item${disabled ? " disabled" : ""}${i === selectedIndex ? " selected" : ""}`;
				return html`
					<div key=${c.name} class=${cls} onMouseEnter=${() => onHover(i)} onClick=${() => !disabled && onSelect(c.name)}>
						<span class="cmd-name">${c.name}</span>
						<span class="cmd-desc">${c.description}</span>
						${disabled && html`<span class="cmd-blocked-hint">idle only</span>`}
					</div>
				`;
			})}
		</div>
	`;
}

// Shared by every "/command <value>" suggestion list — persona, theme,
// model, reasoning level, web-tools on/off — once normalized to a plain
// {value, label} shape (see Composer's pickerItems). One less near-duplicate
// component per new argument-taking command.
function ValueSuggest({ items, selectedIndex, onHover, onSelect }) {
	if (items.length === 0) return null;

	return html`
		<div class="cmd-palette open">
			${items.map(
				(it, i) => html`
				<div key=${it.value} class="cmd-item${i === selectedIndex ? " selected" : ""}" onMouseEnter=${() => onHover(i)} onClick=${() => onSelect(it.value)}>
					<span class="cmd-name">${it.value}</span>
					<span class="cmd-desc">${it.label}</span>
				</div>
			`,
			)}
		</div>
	`;
}

function Composer({ running, ready, commands, personas, onSubmit, onAbort }) {
	const [value, setValue] = useState("");
	const [cmdVisible, setCmdVisible] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);

	// Only /persona still lives in the composer — model, theme, reasoning,
	// web-tools, MCP/skills/plugins/provider/SSH, and the rest of the former
	// sub-arg pickers moved to the Settings modal (see SettingsModal) so
	// typing "/" only ever surfaces conversation-flow commands.
	const personaMatch = /^\/persona\s+(\S*)$/i.exec(value);

	const resize = useCallback(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
		}
	}, []);

	const handleSubmit = useCallback(() => {
		const trimmed = value.trim();
		if (!trimmed) return;
		onSubmit(trimmed);
		setValue("");
		setCmdVisible(false);
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [value, onSubmit]);

	const handleCmdSelect = useCallback(
		(name) => {
			// Argument-less commands (help, current, usage, ...) should just run —
			// filling the box with "/current " and waiting for a second Enter is
			// exactly the "picker doesn't work" feeling this is meant to fix.
			const cmd = commands.find((c) => c.name === name);
			if (cmd && !cmd.takesArgs) {
				onSubmit(name);
				setValue("");
				setCmdVisible(false);
				if (textareaRef.current) textareaRef.current.style.height = "auto";
				return;
			}
			setValue(`${name} `);
			setCmdVisible(false);
			textareaRef.current?.focus();
			requestAnimationFrame(resize);
		},
		[commands, onSubmit, resize],
	);

	const handlePersonaSelect = useCallback(
		(name) => {
			onSubmit(`/persona ${name}`);
			setValue("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
		},
		[onSubmit],
	);

	const handleInput = useCallback(
		(e) => {
			const val = e.target.value;
			setValue(val);
			setCmdVisible(val.startsWith("/") && !val.includes(" "));
			setSelectedIndex(0);
			resize();
		},
		[resize],
	);

	// One active picker at a time — Composer owns the filtered list and the
	// selection index so arrow keys and mouse clicks act on the exact same
	// row order, whichever picker happens to be showing. Persona/model
	// normalize to {value, label} so ValueSuggest can render either the same way.
	let pickerItems = [];
	let pickerSelect = null;
	if (personaMatch) {
		pickerItems = personas
			.filter((p) => p.name.toLowerCase().startsWith(personaMatch[1].toLowerCase()))
			.map((p) => ({ value: p.name, label: p.label }));
		pickerSelect = handlePersonaSelect;
	} else if (cmdVisible) {
		pickerItems = (value ? commands.filter((c) => c.name.startsWith(value)) : commands).filter((c) => !c.hidden);
		pickerSelect = handleCmdSelect;
	}
	const clampedIndex = pickerItems.length > 0 ? Math.min(selectedIndex, pickerItems.length - 1) : 0;

	// Arrow-key nav must scroll the picker, not just select past the visible
	// edge — mouse/scroll-wheel already worked, but the highlighted row could
	// silently move off-screen when reached via the keyboard.
	// biome-ignore lint/correctness/useExhaustiveDependencies: clampedIndex isn't read in the body — it's the trigger to re-scroll to the now-selected row, found via DOM query instead of the value itself.
	useEffect(() => {
		pickerRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
	}, [clampedIndex]);

	const handleKeyDown = useCallback(
		(e) => {
			// Esc stops a running turn — checked before anything else so it wins
			// regardless of what's in the composer (an open command palette, a
			// half-typed /steer), matching the TUI's Escape-aborts behavior. The
			// hotkeys reference has always listed this; the web port just never
			// actually wired it up until now.
			if (e.key === "Escape" && running) {
				e.preventDefault();
				onAbort();
				return;
			}
			if (pickerItems.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSelectedIndex((clampedIndex + 1) % pickerItems.length);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSelectedIndex((clampedIndex - 1 + pickerItems.length) % pickerItems.length);
					return;
				}
				if (e.key === "Escape") {
					setCmdVisible(false);
					return;
				}
				if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
					const item = pickerItems[clampedIndex];
					const disabled = item && "blocking" in item && item.blocking && running;
					if (item && !disabled) {
						e.preventDefault();
						pickerSelect(item.value ?? item.name ?? item.id);
						return;
					}
				}
			}
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				handleSubmit();
			}
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: pickerItems/pickerSelect are plain values recomputed every render (not memoized) — already fine since this callback is rebuilt on every keystroke (`value` is a dep) regardless.
		[pickerItems, clampedIndex, pickerSelect, running, handleSubmit, onAbort],
	);

	return html`
		<div class="composer-wrap">
			<div ref=${pickerRef}>
				${
					personaMatch
						? html`<${ValueSuggest} items=${pickerItems} selectedIndex=${clampedIndex} onHover=${setSelectedIndex} onSelect=${pickerSelect} />`
						: html`<${CommandPalette} items=${pickerItems} selectedIndex=${clampedIndex} running=${running} visible=${cmdVisible} onHover=${setSelectedIndex} onSelect=${handleCmdSelect} />`
				}
			</div>
			<div class="composer">
				<textarea
					ref=${textareaRef}
					class="composer-input"
					placeholder=${!ready ? "Connecting…" : pickerItems.length > 0 ? "↑↓ to navigate, Enter to pick" : "Type a message or / for commands..."}
					rows="1"
					disabled=${!ready}
					value=${value}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
				/>
				${
					running
						? html`<button class="composer-abort" onClick=${onAbort} aria-label="Abort"><${icons.stop} /></button>`
						: html`<button class="composer-send" onClick=${handleSubmit} disabled=${!ready || !value.trim()} aria-label="Send"><${icons.send} /></button>`
				}
			</div>
		</div>
	`;
}

function DiffPanel({
	data,
	activeFile,
	onSelectFile,
	onResizeStart,
	open,
	activeId,
	tab,
	onTabChange,
	confirm,
	fsRefreshNonce,
	bootstrapping,
}) {
	const openClass = open ? " open" : "";

	const header = html`
		<div class="diff-header">
			<div class="diff-tabs">
				<button class="diff-tab${tab === "changes" ? " active" : ""}" onClick=${() => onTabChange("changes")}>Changes</button>
				<button class="diff-tab${tab === "fs" ? " active" : ""}" onClick=${() => onTabChange("fs")}>Files</button>
			</div>
		</div>
	`;

	// A draft session (nothing sent yet) has no cwd on the server to diff or
	// browse — show that plainly instead of either tab's normal content
	// (which would otherwise sit on a permanent "Loading…"/blank state).
	// During bootstrap, though, activeId is only briefly null while the last
	// session is still being resolved — a real session is about to load, so
	// this must say "Loading", not "No session yet" (which read as wrong the
	// instant a real session's data landed a moment later).
	if (!activeId) {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				${
					bootstrapping
						? html`<div class="diff-empty">Loading…</div>`
						: html`
						<div class="diff-empty diff-empty-hint">
							<div>
								<p class="diff-empty-title">No session yet</p>
								<p>Send a message to start this thread, then its changes and files show up here.</p>
							</div>
						</div>
					`
				}
			</aside>
		`;
	}

	if (tab === "fs") {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				<${FileExplorer} activeId=${activeId} confirm=${confirm} refreshNonce=${fsRefreshNonce} />
			</aside>
		`;
	}

	if (!data)
		return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			${header}
			<div class="diff-empty">Loading...</div>
		</aside>
	`;

	const allFiles = data.files || [];
	const groups = data.groups || {};

	const groupDefs = [
		{ key: "untracked", label: "New files", cls: "badge-new" },
		{ key: "added", label: "Staged", cls: "badge-added" },
		{ key: "modified", label: "Modified", cls: "badge-modified" },
		{ key: "deleted", label: "Deleted", cls: "badge-deleted" },
		{ key: "renamed", label: "Renamed", cls: "badge-renamed" },
	];

	// Sort dirs first within each group
	const sortFiles = (arr) =>
		[...arr].sort((a, b) => {
			const aRoot = !a.path.includes("/");
			const bRoot = !b.path.includes("/");
			if (aRoot !== bRoot) return aRoot ? 1 : -1;
			return a.path.localeCompare(b.path);
		});

	const fileLookup = {};
	for (const f of allFiles) fileLookup[f.path] = f;

	// Build grouped file list with section headers
	const sections = [];
	for (const g of groupDefs) {
		const paths = groups[g.key];
		if (!paths || paths.length === 0) continue;
		const files = sortFiles(paths.map((p) => fileLookup[p]).filter(Boolean));
		if (files.length === 0) continue;
		sections.push({ ...g, files });
	}

	const activePath = activeFile || (sections.length > 0 ? sections[0].files[0]?.path : null);
	const file = activePath ? fileLookup[activePath] : null;

	// Pre-compute hunk lines
	let diffContent = null;
	if (file && file.hunks.length > 0) {
		diffContent = file.hunks.map((hunk, hi) => {
			let addN = hunk.newStart;
			let delN = hunk.oldStart;
			const lines = hunk.lines.map((line, li) => {
				const typeClass = line.type === "+" ? "diff-line-add" : line.type === "-" ? "diff-line-del" : "";
				let num = "";
				if (line.type === "+") {
					num = addN;
					addN++;
				} else if (line.type === "-") {
					num = delN;
					delN++;
				}
				return { key: li, typeClass, num, content: line.content };
			});
			return { hi, hunk, lines };
		});
	}

	return html`
		<aside class="diff-panel${openClass}">
			<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
			${header}
			<div class="diff-file-list">
				${sections.map(
					(sec) => html`
					<div key=${sec.key}>
						<div class="diff-group-header">
							<span class="diff-group-label">${sec.label}</span>
							<span class="diff-group-count">${sec.files.length}</span>
						</div>
						${sec.files.map(
							(f) => html`
							<div key=${f.path} class="diff-file-item${f.path === activePath ? " active" : ""}" onClick=${() => onSelectFile(f.path)} title=${f.path}>
								<span class="diff-file-badge ${sec.cls}"></span>
								<span class="diff-file-path">
									<span class="diff-file-dir">${f.path.slice(0, f.path.lastIndexOf("/") + 1)}</span><span class="diff-file-base">${f.path.slice(f.path.lastIndexOf("/") + 1)}</span>
								</span>
								<span class="diff-file-stats">
									<span class="add">+${f.additions}</span>
									<span class="del">-${f.deletions}</span>
								</span>
							</div>
						`,
						)}
					</div>
				`,
				)}
			</div>
			<div class="diff-view">
				${
					diffContent
						? diffContent.map(
								(h) => html`
						<div key=${h.hi}>
							<div class="diff-hunk-header">@@ -${h.hunk.oldStart},${h.hunk.oldLines} +${h.hunk.newStart},${h.hunk.newLines} @@</div>
							${h.lines.map(
								(l) => html`
								<div key=${l.key} class="diff-line ${l.typeClass}">
									<span class="diff-line-num">${l.num}</span>
									<span class="diff-line-content">${l.content}</span>
								</div>
							`,
							)}
						</div>
					`,
							)
						: data.noRepo
							? html`
						<div class="diff-empty diff-empty-hint">
							<div>
								<p class="diff-empty-title">Not a git repository</p>
								<p>Ask the agent to run <code>git init</code> to enable the diff view.</p>
							</div>
						</div>
					`
							: data.error
								? html`<div class="diff-empty diff-empty-error">${data.error}</div>`
								: html`<div class="diff-empty">No changes</div>`
				}
			</div>
		</aside>
	`;
}

// Read/download/delete view of the session's actual working directory — the
// Changes tab above only shows uncommitted git diffs, which is empty (or
// wrong) the moment something's been committed, or the cwd isn't a git repo
// at all. This reads the real filesystem directly, so it works regardless.
// Lazily loads one directory at a time (no .gitignore filtering, so an eager
// full walk could mean tens of thousands of node_modules entries) and always
// hides .git itself.
function FileExplorer({ activeId, confirm, refreshNonce }) {
	const [tree, setTree] = useState({});
	const [expanded, setExpanded] = useState(new Set());
	const [loadingDirs, setLoadingDirs] = useState(new Set());
	const [query, setQuery] = useState("");
	const [searchResults, setSearchResults] = useState(null);
	const [searching, setSearching] = useState(false);
	const [busyPath, setBusyPath] = useState(null);
	const [error, setError] = useState(null);
	const [renamingPath, setRenamingPath] = useState(null);
	const [renameValue, setRenameValue] = useState("");
	const [previewPath, setPreviewPath] = useState(null);
	const renameInputRef = useRef(null);
	const searchTimerRef = useRef(null);

	const loadDir = useCallback(
		async (relPath) => {
			setLoadingDirs((prev) => new Set(prev).add(relPath));
			try {
				const data = await api("GET", `/api/sessions/${activeId}/fs?path=${encodeURIComponent(relPath || ".")}`);
				if (data?.entries) {
					setTree((prev) => ({ ...prev, [relPath]: data.entries }));
					setError(null);
				} else if (data?.error) {
					setError(data.error);
				}
			} catch (err) {
				setError(err.message);
			} finally {
				setLoadingDirs((prev) => {
					const next = new Set(prev);
					next.delete(relPath);
					return next;
				});
			}
		},
		[activeId],
	);

	useEffect(() => {
		setTree({});
		setExpanded(new Set());
		setSearchResults(null);
		setQuery("");
		setError(null);
		if (activeId) loadDir("");
	}, [activeId, loadDir]);

	const toggleDir = (relPath) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(relPath)) {
				next.delete(relPath);
			} else {
				next.add(relPath);
				if (!tree[relPath]) loadDir(relPath);
			}
			return next;
		});
	};

	const collapseAll = () => setExpanded(new Set());

	const runSearch = useCallback(
		async (q) => {
			setSearching(true);
			try {
				const data = await api("GET", `/api/sessions/${activeId}/fs/search?q=${encodeURIComponent(q)}`);
				setSearchResults(data?.results ?? []);
			} catch (err) {
				setError(err.message);
			} finally {
				setSearching(false);
			}
		},
		[activeId],
	);

	const onSearchInput = (value) => {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (!value.trim()) {
			setSearchResults(null);
			return;
		}
		searchTimerRef.current = setTimeout(() => runSearch(value.trim()), 300);
	};

	// A write/edit tool call while this tab is open should show up without
	// the user having to manually collapse and reopen a folder — re-fetch
	// every directory that's currently loaded (not just expanded ones still
	// visible) and re-run an active search, so new/changed/deleted files
	// surface on their own.
	const isFirstRunRef = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only refreshNonce should trigger this — loadDir/runSearch/tree/query are read fresh via closures but must not themselves cause a re-run (tree changes every time loadDir resolves, which would otherwise loop).
	useEffect(() => {
		if (isFirstRunRef.current) {
			isFirstRunRef.current = false;
			return;
		}
		if (!activeId) return;
		for (const relPath of Object.keys(tree)) loadDir(relPath);
		if (query.trim()) runSearch(query.trim());
	}, [refreshNonce]);

	const doDelete = async (relPath, type) => {
		const message =
			type === "dir"
				? `Delete folder "${relPath}" and everything inside it? This can't be undone.`
				: `Delete "${relPath}"? This can't be undone.`;
		if (!(await confirm(message))) return;
		setBusyPath(relPath);
		try {
			await api("DELETE", `/api/sessions/${activeId}/fs?path=${encodeURIComponent(relPath)}`);
			if (searchResults) {
				setSearchResults((prev) => prev.filter((r) => r.path !== relPath));
			}
			const parent = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
			await loadDir(parent);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusyPath(null);
		}
	};

	const startRename = (fullPath, currentName) => {
		setRenamingPath(fullPath);
		setRenameValue(currentName);
		requestAnimationFrame(() => {
			renameInputRef.current?.focus();
			renameInputRef.current?.select();
		});
	};

	const commitRename = async (fullPath) => {
		const name = renameValue.trim();
		setRenamingPath(null);
		const oldName = fullPath.includes("/") ? fullPath.slice(fullPath.lastIndexOf("/") + 1) : fullPath;
		if (!name || name === oldName) return;
		const parent = fullPath.includes("/") ? fullPath.slice(0, fullPath.lastIndexOf("/")) : "";
		try {
			await api("POST", `/api/sessions/${activeId}/fs/rename`, { path: fullPath, name });
			await loadDir(parent);
			if (searchResults) runSearch(query.trim());
		} catch (err) {
			setError(err.message);
		}
	};

	const downloadHref = (relPath) => `/api/sessions/${activeId}/fs/download?path=${encodeURIComponent(relPath)}`;
	const previewHref = (relPath) => `${downloadHref(relPath)}&inline=1`;

	const humanSize = (bytes) => {
		if (bytes == null) return "";
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	};

	// Shared between the tree view and the flat search-results list — a name
	// cell that swaps to an inline rename input, and an actions cell with
	// download/rename/delete — so the two render paths don't drift apart.
	const renderName = (fullPath, name, isDir) =>
		renamingPath === fullPath
			? html`
				<input
					ref=${renameInputRef}
					class="fs-rename-input"
					value=${renameValue}
					onClick=${(e) => e.stopPropagation()}
					onInput=${(e) => setRenameValue(e.target.value)}
					onKeyDown=${(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							commitRename(fullPath);
						}
						if (e.key === "Escape") {
							e.preventDefault();
							setRenamingPath(null);
						}
					}}
					onBlur=${() => commitRename(fullPath)}
				/>
			`
			: html`<span
					class="fs-name"
					title=${fullPath}
					onClick=${(e) => {
						if (isDir) return;
						e.stopPropagation();
						setPreviewPath(fullPath);
					}}
				>${name}</span>`;

	const renderActions = (fullPath, name, type, isBusy) => html`
		<div class="fs-row-actions">
			${
				type !== "dir"
					? html`<a class="fs-action" href=${downloadHref(fullPath)} download title="Download" onClick=${(e) => e.stopPropagation()}><${icons.arrowDownTray} /></a>`
					: null
			}
			<button
				class="fs-action"
				disabled=${isBusy}
				title="Rename"
				onClick=${(e) => {
					e.stopPropagation();
					startRename(fullPath, name);
				}}
			><${icons.pencil} /></button>
			<button
				class="fs-action"
				disabled=${isBusy}
				title=${type === "dir" ? "Delete folder" : "Delete file"}
				onClick=${(e) => {
					e.stopPropagation();
					doDelete(fullPath, type);
				}}
			><${icons.trash} /></button>
		</div>
	`;

	const renderEntry = (parentPath, entry, depth) => {
		const fullPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
		const isDir = entry.type === "dir";
		const isOpen = expanded.has(fullPath);
		const isLoading = loadingDirs.has(fullPath);
		const isBusy = busyPath === fullPath;
		return html`
			<div key=${fullPath}>
				<div class="fs-row">
					<div class="fs-row-main" style=${{ paddingLeft: `${depth * 16}px` }} onClick=${() => isDir && toggleDir(fullPath)}>
						${
							isDir
								? html`<span class="fs-chevron${isOpen ? " open" : ""}"><${icons.chevronRight} /></span>`
								: html`<span class="fs-chevron-spacer"></span>`
						}
						<span class="fs-icon">${isDir ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
						${renderName(fullPath, entry.name, isDir)}
						${!isDir && entry.size != null ? html`<span class="fs-size">${humanSize(entry.size)}</span>` : null}
					</div>
					${renderActions(fullPath, entry.name, entry.type, isBusy)}
				</div>
				${
					isDir && isOpen
						? isLoading
							? html`<div class="fs-loading" style=${{ paddingLeft: `${(depth + 1) * 16}px` }}>Loading…</div>`
							: (tree[fullPath] || []).map((child) => renderEntry(fullPath, child, depth + 1))
						: null
				}
			</div>
		`;
	};

	return html`
		<div class="fs-explorer">
			<div class="fs-toolbar">
				<input class="fs-search" placeholder="Search files…" value=${query} onInput=${(e) => onSearchInput(e.target.value)} />
				<button class="fs-collapse-btn" title="Collapse all folders" onClick=${collapseAll}><${icons.chevronUp} /></button>
			</div>
			<div class="fs-tree">
				${error ? html`<div class="diff-empty diff-empty-error">${error}</div>` : null}
				${
					searchResults
						? searching
							? html`<div class="fs-loading">Searching…</div>`
							: searchResults.length === 0
								? html`<div class="diff-empty">No matches</div>`
								: searchResults.map((r) => {
										const baseName = r.path.includes("/")
											? r.path.slice(r.path.lastIndexOf("/") + 1)
											: r.path;
										const isBusy = busyPath === r.path;
										return html`
										<div key=${r.path} class="fs-row">
											<div class="fs-row-main">
												<span class="fs-chevron-spacer"></span>
												<span class="fs-icon">${r.type === "dir" ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
												${renderName(r.path, r.path, r.type === "dir")}
											</div>
											${renderActions(r.path, baseName, r.type, isBusy)}
										</div>
									`;
									})
						: tree[""]
							? tree[""].map((entry) => renderEntry("", entry, 0))
							: loadingDirs.has("")
								? html`<div class="fs-loading">Loading…</div>`
								: null
				}
			</div>
		</div>
		<${FilePreviewModal}
			path=${previewPath}
			onClose=${() => setPreviewPath(null)}
			downloadHref=${previewPath ? downloadHref(previewPath) : null}
			previewHref=${previewPath ? previewHref(previewPath) : null}
		/>
	`;
}

// Extensions previewable as text vs. image — anything else just gets a
// "no preview" message with a download button, rather than dumping raw
// binary bytes into a <pre> or guessing wrong from a magic-byte sniff.
const FS_TEXT_EXTENSIONS = new Set([
	"txt",
	"md",
	"markdown",
	"js",
	"mjs",
	"cjs",
	"jsx",
	"ts",
	"tsx",
	"json",
	"jsonc",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"sh",
	"bash",
	"zsh",
	"fish",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"c",
	"h",
	"cpp",
	"hpp",
	"cs",
	"php",
	"sql",
	"css",
	"scss",
	"less",
	"html",
	"htm",
	"xml",
	"svg",
	"log",
	"lock",
]);
const FS_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
const FS_TABLE_EXTENSIONS = new Set(["csv", "tsv"]);
const FS_PREVIEW_MAX_BYTES = 512 * 1024;
const FS_TABLE_MAX_ROWS = 1000;

// csv's delimiter isn't always a comma in practice (Excel exports in some
// locales default to ";", and plenty of "csv" files out there are secretly
// tab- or pipe-separated) — tsv's extension already tells us, but for csv
// sniff the first line rather than assuming.
function detectDelimiter(text, ext) {
	if (ext === "tsv") return "\t";
	const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
	const candidates = [",", ";", "\t", "|"];
	let best = ",";
	let bestCount = -1;
	for (const d of candidates) {
		const count = firstLine.split(d).length - 1;
		if (count > bestCount) {
			best = d;
			bestCount = count;
		}
	}
	return bestCount > 0 ? best : ",";
}

// A minimal RFC 4180 parser (quoted fields, "" as an escaped quote, quoted
// fields that contain the delimiter or a literal newline) — a naive
// text.split(delimiter) breaks on exactly the files this is for.
function parseDelimited(text, delimiter) {
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}
		if (ch === '"') inQuotes = true;
		else if (ch === delimiter) {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch === "\r") {
			// swallowed — a following \n (CRLF) closes the row on its own
		} else {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	// Trailing blank line from a file ending in a newline produces one
	// single-empty-string row — not a real data row.
	while (rows.length > 0 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
	return rows;
}

// "" for a dotfile with no further extension (.bashrc, .gitignore, .env) or
// a file with no extension at all (Makefile, Dockerfile, LICENSE) — treated
// as previewable text by default below rather than needing every possible
// rc-file name enumerated in FS_TEXT_EXTENSIONS.
function fileExtOf(path) {
	const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

// Read/download/delete's neighbor — a quick look at a file's content without
// leaving the panel. Text files render as-is; images render inline; anything
// else (or anything too large) just offers the download button that's
// already one click away on the row itself.
function FilePreviewModal({ path, onClose, downloadHref, previewHref }) {
	const [content, setContent] = useState(null);
	const [tooLarge, setTooLarge] = useState(false);
	const [error, setError] = useState(null);
	const modalRef = useModalFocusTrap(!!path);
	const ext = path ? fileExtOf(path) : "";
	const isImage = FS_IMAGE_EXTENSIONS.has(ext);
	const isPdf = !isImage && ext === "pdf";
	const isTable = !isImage && !isPdf && FS_TABLE_EXTENSIONS.has(ext);
	const isText = !isImage && !isPdf && !isTable && (ext === "" || FS_TEXT_EXTENSIONS.has(ext));
	const fetchesContent = isText || isTable;

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchesContent is derived from path every render, including it would refetch on every unrelated re-render.
	useEffect(() => {
		setContent(null);
		setTooLarge(false);
		setError(null);
		if (!path || !fetchesContent) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${window.location.origin}${downloadHref}`);
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const len = Number(res.headers.get("content-length") ?? 0);
				if (len > FS_PREVIEW_MAX_BYTES) {
					if (!cancelled) setTooLarge(true);
					return;
				}
				const text = await res.text();
				if (!cancelled) setContent(text);
			} catch (err) {
				if (!cancelled) setError(err.message);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, downloadHref]);

	if (!path) return null;
	const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;

	let body;
	if (isImage) {
		body = html`<img class="fs-preview-image" src=${previewHref} alt=${name} />`;
	} else if (isPdf) {
		body = html`<iframe class="fs-preview-pdf" src=${previewHref} title=${name}></iframe>`;
	} else if (error) {
		body = html`<div class="diff-empty diff-empty-error">${error}</div>`;
	} else if (!isText && !isTable) {
		body = html`<div class="diff-empty">No preview for this file type.</div>`;
	} else if (tooLarge) {
		body = html`<div class="diff-empty">Too large to preview — use Download instead.</div>`;
	} else if (content == null) {
		body = html`<div class="diff-empty">Loading…</div>`;
	} else if (isTable) {
		const delimiter = detectDelimiter(content, ext);
		const rows = parseDelimited(content, delimiter);
		const shown = rows.slice(0, FS_TABLE_MAX_ROWS);
		body =
			rows.length === 0
				? html`<div class="diff-empty">Empty file.</div>`
				: html`
				<div class="fs-preview-table-wrap">
					<table class="fs-preview-table">
						<thead><tr>${shown[0].map((cell, i) => html`<th key=${i}>${cell}</th>`)}</tr></thead>
						<tbody>
							${shown.slice(1).map(
								(row, ri) => html`
								<tr key=${ri}>${row.map((cell, ci) => html`<td key=${ci}>${cell}</td>`)}</tr>
							`,
							)}
						</tbody>
					</table>
					${rows.length > FS_TABLE_MAX_ROWS ? html`<div class="fs-preview-table-note">Showing first ${FS_TABLE_MAX_ROWS} of ${rows.length} rows — download for the rest.</div>` : null}
				</div>
			`;
	} else {
		body = html`<pre class="fs-preview-text">${content}</pre>`;
	}

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal modal-preview" role="dialog" aria-modal="true" aria-label="File preview" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span title=${path}>${name}</span>
					<div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
						<a class="modal-btn icon-btn" href=${downloadHref} download title="Download"><${icons.arrowDownTray} /></a>
						<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
					</div>
				</div>
				<div class="fs-preview-body">${body}</div>
			</div>
		</div>
	`;
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

// Shared by every modal (dir picker, status, settings, hotkeys): moves focus
// into the dialog on open, keeps Tab from leaking to the page behind the
// backdrop, and hands focus back to whatever triggered it on close — none of
// that happens for free just from the backdrop/click-outside handling.
function useModalFocusTrap(active) {
	const ref = useRef(null);
	useEffect(() => {
		if (!active) return;
		const container = ref.current;
		const previouslyFocused = document.activeElement;
		(container?.querySelector(FOCUSABLE_SELECTOR) || container)?.focus();

		const onKeyDown = (e) => {
			if (e.key !== "Tab" || !container) return;
			const focusables = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			previouslyFocused?.focus?.();
		};
	}, [active]);
	return ref;
}

// Read-only folder browser (like a native "Open Folder" dialog) for picking
// a new session's working directory — /api/browse lists subdirectories only,
// server-side, and this just walks that one level at a time.
function DirectoryBrowser({ initialPath, onPick, onClose, confirm }) {
	const [path, setPath] = useState(initialPath || "");
	const [parent, setParent] = useState(null);
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const newNameRef = useRef(null);

	const load = useCallback(async (p) => {
		setLoading(true);
		try {
			const data = await api("GET", `/api/browse?path=${encodeURIComponent(p ?? "")}`);
			if (data) {
				setPath(data.path);
				setParent(data.parent);
				setEntries(data.entries || []);
				setError(data.error ?? null);
			}
		} catch (err) {
			setError(err.message);
		}
		setLoading(false);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: initialPath seeds the first load only — later navigation uses load(parent)/load(entry.path), so re-running this on prop changes would fight in-modal navigation. load itself never changes (empty deps).
	useEffect(() => {
		load(initialPath);
	}, []);
	const modalRef = useModalFocusTrap(true);

	const openCreate = useCallback(() => {
		setCreating(true);
		setNewName("");
		// Input isn't mounted yet this tick — focus on the next one.
		requestAnimationFrame(() => newNameRef.current?.focus());
	}, []);

	const submitCreate = useCallback(async () => {
		const name = newName.trim();
		if (!name) {
			setCreating(false);
			return;
		}
		setBusy(true);
		try {
			await api("POST", "/api/browse/mkdir", { path, name });
			setCreating(false);
			await load(path);
		} catch (err) {
			setError(err.message);
		}
		setBusy(false);
	}, [newName, path, load]);

	const deleteEntry = useCallback(
		async (entry) => {
			const ok = await confirm(`Delete empty folder "${entry.name}"? This can't be undone.`);
			if (!ok) return;
			setBusy(true);
			try {
				await api("DELETE", `/api/browse?path=${encodeURIComponent(entry.path)}`);
				await load(path);
			} catch (err) {
				setError(err.message);
			}
			setBusy(false);
		},
		[confirm, path, load],
	);

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal" role="dialog" aria-modal="true" aria-label="Choose working directory" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Choose working directory</span>
					<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="dir-path" title=${path}>${path}</div>
				<div class="dir-list">
					${
						parent !== null &&
						html`
						<div class="dir-item dir-item-up" onClick=${() => load(parent)}>.. (parent directory)</div>
					`
					}
					${entries.map(
						(e) => html`
						<div key=${e.path} class="dir-item dir-item-row">
							<span class="dir-item-name" onClick=${() => load(e.path)}>${e.name}</span>
							<button
								class="modal-btn icon-btn dir-item-delete"
								title="Delete folder"
								disabled=${busy}
								onClick=${(ev) => {
									ev.stopPropagation();
									deleteEntry(e);
								}}
							><${icons.trash} /></button>
						</div>
					`,
					)}
					${!loading && entries.length === 0 && !error && html`<div class="dir-empty">No subdirectories</div>`}
					${error && html`<div class="dir-error">${error}</div>`}
				</div>
				${
					creating
						? html`
						<div class="dir-create-row">
							<input
								ref=${newNameRef}
								type="text"
								placeholder="New folder name"
								value=${newName}
								disabled=${busy}
								onInput=${(e) => setNewName(e.target.value)}
								onKeyDown=${(e) => {
									if (e.key === "Enter") submitCreate();
									if (e.key === "Escape") setCreating(false);
								}}
							/>
							<button class="modal-btn" disabled=${busy} onClick=${() => setCreating(false)}>Cancel</button>
							<button class="modal-btn modal-btn-primary" disabled=${busy || !newName.trim()} onClick=${submitCreate}>Create</button>
						</div>
					`
						: html`<button class="modal-btn dir-new-folder" disabled=${busy} onClick=${openCreate}>+ New folder</button>`
				}
				<div class="modal-footer">
					<button class="modal-btn" onClick=${onClose}>Cancel</button>
					<button class="modal-btn modal-btn-primary" onClick=${() => onPick(path)}>Use this folder</button>
				</div>
			</div>
		</div>
	`;
}

const SETTINGS_TABS = [
	{ id: "font", label: "Font" },
	{ id: "mcp", label: "MCP" },
	{ id: "model", label: "Model" },
	{ id: "plugins", label: "Plugins" },
	{ id: "provider", label: "Provider" },
	{ id: "skills", label: "Skills" },
	{ id: "ssh", label: "SSH" },
	{ id: "theme", label: "Theme" },
	{ id: "tools", label: "Tools" },
];

// A centered modal, same treatment as the Hotkeys reference — an anchored
// corner dropdown doesn't have anywhere safe to sit on a narrow screen (the
// status button lives among 3 others in the header, nowhere near the actual
// right edge, so "align to the button" pushed it half off the left side of
// the viewport on mobile). Status is a glance-and-close read either way, so
// a modal costs nothing here and works identically at any viewport width.
// Reloads on every open since usage/message-count/git-dirty drift constantly.
function StatusPopover({ activeId, running }) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);

	const load = useCallback(async () => {
		setError(null);
		try {
			const [current, repo, providers] = await Promise.all([
				api("POST", `/api/sessions/${activeId}/command`, { command: "/current" }),
				api("POST", `/api/sessions/${activeId}/command`, { command: "/repo" }),
				api("POST", `/api/sessions/${activeId}/command`, { command: "/provider list" }),
			]);
			setData({ current: current?.result, repo: repo?.result, providers: providers?.result });
		} catch (err) {
			setError(err.message);
		}
	}, [activeId]);

	const openModal = useCallback(() => {
		setOpen(true);
		load();
	}, [load]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	// Left open across a turn, the numbers it showed on open go stale the
	// moment a reply lands — reload the instant `running` flips back to
	// false so it never needs a manual close/reopen (or a page refresh) to
	// catch up.
	const wasRunning = useRef(running);
	useEffect(() => {
		if (open && wasRunning.current && !running) load();
		wasRunning.current = running;
	}, [running, open, load]);
	const modalRef = useModalFocusTrap(open);

	return html`
		<button class="menu-toggle" onClick=${openModal} aria-label="Status" title="Status">
			<${icons.info} />
		</button>
		${
			open &&
			html`
			<div class="modal-backdrop" onClick=${() => setOpen(false)}>
				<div class="modal modal-status" role="dialog" aria-modal="true" aria-label="Status" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
					<div class="modal-header">
						<span>Status</span>
						<button class="modal-close" onClick=${() => setOpen(false)} aria-label="Close"><${icons.xMark} /></button>
					</div>
					<div class="modal-status-body">
						${error && html`<div class="settings-error">${error}</div>`}
						${!data && !error ? html`<div class="settings-loading">Loading…</div>` : html`<${SettingsStatus} data=${data} />`}
					</div>
				</div>
			</div>
		`
		}
	`;
}

// Everything that used to be a slash command typed into the composer but
// isn't part of the actual back-and-forth with the agent (MCP/skills/
// plugins/provider/SSH management, theme, model/reasoning details, usage) —
// consolidated here so the chat transcript stays just the conversation.
// Every action still runs through the exact same POST /command endpoint the
// composer used, just without ever appending a chat notice for it.
function SettingsModal({
	activeId,
	personas,
	onQuickSessionPersonaChange,
	themes,
	currentThemeId,
	onApplyTheme,
	onThemeChange,
	currentFontId,
	currentFontScale,
	onPickFont,
	onPickScale,
	onClose,
	confirm,
	onReload,
}) {
	const [tab, setTab] = useState(activeId ? "model" : "theme");
	const [data, setData] = useState({});
	const [errors, setErrors] = useState({});
	const [busy, setBusy] = useState(false);

	const run = useCallback(
		async (command) => {
			if (!activeId) return { ok: false, error: "No active session" };
			try {
				return await api("POST", `/api/sessions/${activeId}/command`, { command });
			} catch (err) {
				return { ok: false, error: err.message };
			}
		},
		[activeId],
	);

	const load = useCallback(
		async (t) => {
			setErrors((e) => ({ ...e, [t]: null }));
			if (!activeId && t !== "theme" && t !== "font") return;
			if (t === "model") {
				const [models, reasoning, current, providers] = await Promise.all([
					api("GET", "/api/models/cached").catch(() => null),
					api("GET", `/api/sessions/${activeId}/reasoning-options`).catch(() => null),
					run("/current"),
					run("/provider list"),
				]);
				setData((d) => ({
					...d,
					model: {
						models: models?.models ?? [],
						reasoningOptions: reasoning?.options ?? [],
						current: current?.result,
						providers: providers?.result ?? [],
					},
				}));
			} else if (t === "tools") {
				const [web, permissions, searchProvider, quickSessionPersona] = await Promise.all([
					run("/web"),
					run("/permissions"),
					run("/web-search-provider"),
					run("/quick-session-persona"),
				]);
				setData((d) => ({
					...d,
					tools: {
						web: web?.result,
						permissions: permissions?.result,
						searchProvider: searchProvider?.result,
						quickSessionPersona: quickSessionPersona?.result,
					},
				}));
			} else if (t === "mcp") {
				const res = await run("/mcp list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, mcp: res.error }));
					return;
				}
				setData((d) => ({ ...d, mcp: res.result }));
			} else if (t === "skills") {
				const res = await run("/skills list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, skills: res.error }));
					return;
				}
				setData((d) => ({ ...d, skills: res.result }));
			} else if (t === "plugins") {
				const [plugins, marketplaces] = await Promise.all([run("/plugin list"), run("/plugin marketplace list")]);
				setData((d) => ({
					...d,
					plugins: { plugins: plugins?.result ?? [], marketplaces: marketplaces?.result ?? [] },
				}));
			} else if (t === "provider") {
				const res = await run("/provider list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, provider: res.error }));
					return;
				}
				setData((d) => ({ ...d, provider: res.result }));
			} else if (t === "ssh") {
				const res = await run("/ssh list");
				if (!res.ok) {
					setErrors((e) => ({ ...e, ssh: res.error }));
					return;
				}
				setData((d) => ({ ...d, ssh: res.result }));
			}
		},
		[run, activeId],
	);

	// Preload every tab in parallel as soon as the modal mounts (or the active
	// session changes) — clicking a tab then just shows what's already there
	// instead of a fresh fetch-and-flash "Loading…" every single time.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId isn't read in the body directly, but load() closes over it (see `run`'s deps above) — re-running this on session switch is the intended behavior.
	useEffect(() => {
		for (const t of SETTINGS_TABS) load(t.id);
	}, [activeId, load]);
	const modalRef = useModalFocusTrap(true);
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// Runs a mutating command, shows any error inline, and reloads the
	// current tab's data on success so the list reflects the new state
	// immediately instead of waiting for the next manual refresh.
	const act = useCallback(
		async (command) => {
			setBusy(true);
			setErrors((e) => ({ ...e, [tab]: null }));
			const res = await run(command);
			if (!res.ok) setErrors((e) => ({ ...e, [tab]: res.error ?? "Failed" }));
			// Always refresh the Model tab too: a /provider Switch changes the
			// active provider, which the Model picker's model list depends on.
			await Promise.all([load(tab), tab === "model" ? Promise.resolve() : load("model")]);
			// /reload and any /skills mutation can change which skills are
			// loaded/enabled — those show up as native /<skill-id> slash commands,
			// so the composer's palette needs to catch up too.
			if (res.ok && (command === "/reload" || command.startsWith("/skills "))) onReload?.();
			setBusy(false);
			return res;
		},
		[run, load, tab, onReload],
	);

	// theme's data comes from the `themes` prop (fetched once at app boot,
	// always present already) rather than the per-tab preload above.
	// theme and font both come from props/local state (fetched once at app
	// boot, or never fetched at all for font — see applyFont) rather than the
	// per-tab preload above.
	const needsSession = tab !== "theme" && tab !== "font";
	const hasData = !needsSession || data[tab] !== undefined;

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Settings</span>
					<div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
						<button class="modal-btn" disabled=${busy} onClick=${() => act("/reload")}>Reload resources</button>
						<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
					</div>
				</div>
				<div class="settings-body">
					<div class="settings-tabs">
						${SETTINGS_TABS.map(
							(t) => html`
							<button key=${t.id} class="settings-tab${tab === t.id ? " active" : ""}" onClick=${() => setTab(t.id)}>${t.label}</button>
						`,
						)}
					</div>
					<div class="settings-pane">
						${errors[tab] && html`<div class="settings-error">${errors[tab]}</div>`}
						${
							!activeId && needsSession
								? html`<div class="settings-hint">Open or create a session to access this tab.</div>`
								: !hasData
									? html`<div class="settings-loading">Loading…</div>`
									: tab === "font"
										? html`<${SettingsFont} currentFontId=${currentFontId} currentFontScale=${currentFontScale} onPickFont=${onPickFont} onPickScale=${onPickScale} />`
										: tab === "model"
											? html`<${SettingsModel} data=${data.model} busy=${busy} act=${act} />`
											: tab === "theme"
												? html`<${SettingsTheme} themes=${themes} currentThemeId=${currentThemeId} onPick=${async (
														id,
													) => {
														const res = await act(`/theme ${id}`);
														if (res.ok && res.result?.colors) onApplyTheme(res.result.colors);
														if (res.ok && res.result?.theme) onThemeChange(res.result.theme);
													}} />`
												: tab === "tools"
													? html`<${SettingsTools} data=${data.tools} busy=${busy} act=${act} personas=${personas} onQuickSessionPersonaChange=${onQuickSessionPersonaChange} />`
													: tab === "mcp"
														? html`<${SettingsMcp} data=${data.mcp} busy=${busy} act=${act} confirm=${confirm} />`
														: tab === "skills"
															? html`<${SettingsSkills} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
															: tab === "plugins"
																? html`<${SettingsPlugins} data=${data.plugins} busy=${busy} act=${act} confirm=${confirm} />`
																: tab === "provider"
																	? html`<${SettingsProvider} data=${data.provider} busy=${busy} act=${act} confirm=${confirm} />`
																	: tab === "ssh"
																		? html`<${SettingsSsh} data=${data.ssh} busy=${busy} act=${act} confirm=${confirm} />`
																		: null
						}
					</div>
				</div>
			</div>
		</div>
	`;
}

function SettingsStatus({ data }) {
	if (!data) return null;
	const c = data.current || {};
	const r = data.repo || {};
	const u = c.usage || {};
	const providerName = (data.providers || []).find((p) => p.active)?.name;
	return html`
		<div class="settings-rows">
			<div class="settings-row"><span>Persona</span><span>${c.persona ?? "—"}</span></div>
			${providerName ? html`<div class="settings-row"><span>Provider</span><span>${providerName}</span></div>` : null}
			<div class="settings-row"><span>Model</span><span>${c.model ?? "—"}</span></div>
			<div class="settings-row"><span>Mode</span><span>${c.mode ?? "build"}</span></div>
			<div class="settings-row"><span>Status</span><span>${c.status ?? "—"}</span></div>
			<div class="settings-row"><span>Messages</span><span>${c.messageCount ?? 0}</span></div>
			<div class="settings-row"><span>Tokens</span><span>${u.totalTokens ?? 0} (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)</span></div>
			${
				u.cacheReadTokens > 0 && u.promptTokens > 0
					? html`<div class="settings-row"><span>Cached</span><span>${u.cacheReadTokens} (${Math.round((u.cacheReadTokens / u.promptTokens) * 100)}% of input)</span></div>`
					: null
			}
			${u.cost ? html`<div class="settings-row"><span>Cost</span><span>$${u.cost.toFixed(4)}</span></div>` : null}
			${c.lastTurn?.tokensPerSecond ? html`<div class="settings-row"><span>Last turn</span><span>${c.lastTurn.tokensPerSecond} tok/s (${(c.lastTurn.generationMs / 1000).toFixed(1)}s)</span></div>` : null}
			<div class="settings-row"><span>Directory</span><span title=${r.cwd}>${shortPath(r.cwd)}</span></div>
			${r.isGit && html`<div class="settings-row"><span>Git branch</span><span>${r.branch}${r.dirty ? " (dirty)" : ""}</span></div>`}
			${r.isGit === false && html`<div class="settings-row"><span>Git</span><span>not a repository</span></div>`}
		</div>
	`;
}

/**
 * Cascading provider → model picker.  When the user picks a provider its
 * /v1/models list is fetched and shown in the model dropdown.  The "Set"
 * button fires two commands: one to set the provider, one to set the model.
 * "Reset" clears both overrides so the slot falls back to the active provider
 * and main model.
 */
/**
 * Cascading provider → model picker.
 * @param providerCommand  e.g. "/subagent-model-provider" or "/provider"
 * @param modelCommand      e.g. "/subagent-model" or "/model"
 */
function SlotModelPicker({
	busy,
	act,
	providers,
	activeProviderName,
	currentProvider,
	currentModel,
	fallbackModel,
	providerCommand,
	modelCommand,
	isMainSlot,
	initialModels,
}) {
	const initialProvider = currentProvider || "";
	// Only the slot's own chosen model is "selected"; an inherited
	// fallback is shown via the placeholder, so every slot reads the
	// same "Pick a model…" line instead of silently showing a model
	// the slot never explicitly picked.
	const effectiveModel = currentModel || "";
	const [providerValue, setProviderValue] = useState(initialProvider);
	const [modelValue, setModelValue] = useState(effectiveModel);
	const [models, setModels] = useState(initialModels || []);
	const [loading, setLoading] = useState(false);

	// Label for the empty option in the provider dropdown.
	// Empty option label: the main slot shows the provider the main model
	// currently uses; subagent/plan show that they inherit it (there's no
	// separate "default" — the main model's provider IS the default).
	const defaultLabel = isMainSlot
		? activeProviderName || "Select…"
		: activeProviderName
			? `${activeProviderName} (same as main)`
			: "Same as main";

	// Models for this slot: if a specific per-slot provider is pinned,
	// fetch its list; otherwise the slot follows the *active* provider, so
	// fetch that provider's models (resolved by name on the server) and
	// re-fetch whenever activeProviderName changes — e.g. after a
	// /provider Switch — so the picker reflects the new endpoint without
	// a page reload.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			// `initialModels` (the parent's own /api/models/cached call, made
			// once for all three slots) already seeded state for first paint —
			// re-fetching that same cache per-slot here was pure duplicate
			// traffic, and its state can not affect anything, since this
			// followup live fetch always overwrites it moments later anyway.
			setLoading(true);
			const effectiveProvider = initialProvider || activeProviderName || "";
			const qs = effectiveProvider ? `?provider=${encodeURIComponent(effectiveProvider)}` : "";
			try {
				const res = await api("GET", `/api/models${qs}`);
				if (!cancelled) setModels(res?.models ?? []);
			} catch {
				if (!cancelled) setModels([]);
			}
			if (!cancelled) setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [initialProvider, activeProviderName]);

	// Fetch models when provider changes.
	const onProviderChange = useCallback(async (name) => {
		setProviderValue(name);
		setModelValue("");
		setLoading(true);
		try {
			const qs = name ? `?provider=${encodeURIComponent(name)}` : "";
			const res = await api("GET", `/api/models${qs}`);
			setModels(res?.models ?? []);
		} catch {
			setModels([]);
		}
		setLoading(false);
	}, []);

	const doSet = useCallback(async () => {
		if (providerValue) await act(`${providerCommand} ${providerValue}`);
		if (modelValue && models.some((m) => m.id === modelValue)) await act(`${modelCommand} ${modelValue}`);
	}, [providerValue, modelValue, models, act, providerCommand, modelCommand]);

	const doReset = useCallback(async () => {
		if (providerCommand !== "/provider") await act(`${providerCommand} off`);
		await act(`${modelCommand} off`);
		setProviderValue("");
		setModelValue("");
		setModels([]);
	}, [act, providerCommand, modelCommand]);

	const hasOverride = currentProvider || currentModel;

	return html`
		<div class="settings-form-row">
			<select disabled=${busy} value=${providerValue} onChange=${(e) => onProviderChange(e.target.value)}>
				<option value="">${defaultLabel}</option>
				${providers.map((p) => html`<option key=${p.name} value=${p.name}>${p.name}</option>`)}
			</select>
			<select disabled=${busy || (loading && models.length === 0)} onChange=${(e) => setModelValue(e.target.value)} value=${modelValue && models.some((m) => m.id === modelValue) ? modelValue : ""}>
				<option value="">${
					loading && models.length === 0
						? "Loading…"
						: `Pick a model…${fallbackModel && models.some((m) => m.id === fallbackModel) ? ` (inherits ${fallbackModel})` : ""}`
				}</option>
				${[...models].sort((a, b) => a.id.localeCompare(b.id)).map((m) => html`<option key=${m.id} value=${m.id}>${m.id}${m.reasoning ? " (reasoning)" : ""}</option>`)}
			</select>
			<button
				class="modal-btn icon-btn"
				title="Apply"
				disabled=${
					busy ||
					!modelValue ||
					!models.some((m) => m.id === modelValue) ||
					(providerValue === initialProvider && modelValue === effectiveModel)
				}
				onClick=${doSet}
			><${icons.check} /></button>
			${!isMainSlot ? html`<button class="modal-btn icon-btn" title="Clear model override" disabled=${busy} onClick=${() => act(`${modelCommand} off`)}><${icons.xCircle} /></button>` : null}
			${!isMainSlot && hasOverride ? html`<button class="modal-btn icon-btn" title="Reset all overrides" disabled=${busy} onClick=${doReset}><${icons.arrowUturnLeft} /></button>` : null}
		</div>
	`;
}

function SettingsModel({ data, busy, act }) {
	const [reasoningValue, setReasoningValue] = useState("");
	if (!data) return null;
	const c = data.current || {};
	const providers = data.providers || [];
	const activeProviderName = providers.find((p) => p.active)?.name ?? "";
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Model</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${activeProviderName} currentModel=${c.model} providerCommand="/provider" modelCommand="/model" isMainSlot=${true} initialModels=${data.models} />
			<div class="settings-section-title">Reasoning — current: ${c.reasoningLevel ?? "off"}</div>
			${
				data.reasoningOptions.length === 0
					? html`<div class="settings-hint">This model exposes no reasoning controls.</div>`
					: html`
					<div class="settings-form-row">
						<select onChange=${(e) => setReasoningValue(e.target.value)}>
							<option value="">Pick a level…</option>
							${data.reasoningOptions.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
						</select>
						<button class="modal-btn icon-btn" title="Apply reasoning" disabled=${busy || !reasoningValue} onClick=${() => act(`/reasoning ${reasoningValue}`)}><${icons.check} /></button>
					</div>
				`
			}
			<div class="settings-section-title">Subagent model${c.subagentModelProvider ? ` — @ ${c.subagentModelProvider}` : ""}</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${c.subagentModelProvider} currentModel=${c.subagentModel} fallbackModel=${c.model} providerCommand="/subagent-model-provider" modelCommand="/subagent-model" initialModels=${data.models} />
			<div class="settings-section-title">Plan-mode model${c.planModelProvider ? ` — @ ${c.planModelProvider}` : ""}</div>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${c.planModelProvider} currentModel=${c.planModel} fallbackModel=${c.model} providerCommand="/plan-model-provider" modelCommand="/plan-model" initialModels=${data.models} />
		</div>
	`;
}

function SettingsTheme({ themes, currentThemeId, onPick }) {
	return html`
		<div class="settings-theme-grid">
			${[...(themes || [])]
				.sort((a, b) => a.label.localeCompare(b.label))
				.map(
					(t) => html`
				<button key=${t.id} class="settings-theme-swatch${t.id === currentThemeId ? " active" : ""}" style=${{ "--swatch-accent": t.colors?.accent }} onClick=${() => onPick(t.id)} title=${t.description}>
					<span class="settings-theme-dot" />
					${t.label}
				</button>
			`,
				)}
		</div>
	`;
}

// Client-only (localStorage) — unlike SettingsTheme, picking here never
// round-trips through `act`/`/command`, so it applies the instant it's
// clicked/dragged. Each swatch renders its own label in its own font as a
// live preview of what picking it actually looks like.
function SettingsFont({ currentFontId, currentFontScale, onPickFont, onPickScale }) {
	return html`
		<div class="settings-rows" style=${{ marginBottom: "16px" }}>
			<div class="settings-row-label">Scale</div>
			<div class="settings-scale-row">
				${FONT_SCALE_OPTIONS.map(
					(s) => html`
					<button key=${s} class="settings-scale-btn${s === currentFontScale ? " active" : ""}" onClick=${() => onPickScale(s)}>
						${Math.round(s * 100)}%
					</button>
				`,
				)}
			</div>
		</div>
		<div class="settings-row-label">Monospace</div>
		<div class="settings-theme-grid">
			${FONT_OPTIONS.filter((f) => f.mono).map(
				(f) => html`
				<button key=${f.id} class="settings-theme-swatch${f.id === currentFontId ? " active" : ""}" style=${{ fontFamily: f.family }} onClick=${() => onPickFont(f.id)}>
					${f.label}
				</button>
			`,
			)}
		</div>
		<div class="settings-row-label" style=${{ marginTop: "14px" }}>Sans-serif</div>
		<div class="settings-theme-grid">
			${FONT_OPTIONS.filter((f) => !f.mono).map(
				(f) => html`
				<button key=${f.id} class="settings-theme-swatch${f.id === currentFontId ? " active" : ""}" style=${{ fontFamily: f.family }} onClick=${() => onPickFont(f.id)}>
					${f.label}
				</button>
			`,
			)}
		</div>
	`;
}

function InfoPopover({ text, readUrl }) {
	const [open, setOpen] = useState(false);
	const [fullContent, setFullContent] = useState(null);
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		if (!open) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
				setFullContent(null);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);
	const loadFull = async () => {
		setOpen(true);
		setLoading(true);
		try {
			const res = await api("GET", readUrl);
			setFullContent(res?.content || res?.error || "No content");
		} catch {
			setFullContent("Failed to load");
		}
		setLoading(false);
	};
	const close = () => {
		setOpen(false);
		setFullContent(null);
	};
	if (!text && !readUrl) return null;
	return [
		html`<span class="info-popover-wrap" style=${{ display: "inline-flex", gap: "2px" }}>
			${
				text
					? html`<button class="modal-btn icon-btn" title="Description" onClick=${(e) => {
							e.stopPropagation();
							setFullContent(null);
							setOpen(true);
						}}><${icons.info} /></button>`
					: null
			}
			${
				readUrl
					? html`<button class="modal-btn icon-btn" title="Read full content" onClick=${(e) => {
							e.stopPropagation();
							loadFull();
						}}><${icons.bookOpen} /></button>`
					: null
			}
		</span>`,
		open && html`<div class="info-popover-backdrop" onClick=${close} />`,
		open &&
			html`<div class="info-popover" onClick=${(e) => e.stopPropagation()}>
			<div class="info-popover-header"><button class="modal-btn icon-btn" onClick=${close}><${icons.xMark} /></button></div>
			<div class="info-popover-text">${loading ? "Loading…" : fullContent || text}</div>
		</div>`,
	];
}

function SettingsTools({ data, busy, act, personas, onQuickSessionPersonaChange }) {
	const [tavilyKey, setTavilyKey] = useState("");
	const [braveKey, setBraveKey] = useState("");
	const [quickPersonaValue, setQuickPersonaValue] = useState("");
	if (!data) return null;
	const web = data.web || {};
	const perm = data.permissions || {};
	const search = data.searchProvider || {};
	const quickPersona = data.quickSessionPersona?.quickSessionPersona ?? "coding";
	const webOn = web.webTools;
	const provider = search.searchProvider || "ddg";
	const tKey = tavilyKey || search.tavilyApiKey || "";
	const bKey = braveKey || search.braveApiKey || "";
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Web tools</div>
			<div class="settings-form-row">
				<button class="modal-btn${webOn ? " modal-btn-primary" : ""}" title="Enable web_search and web_fetch" disabled=${busy} onClick=${() => act("/web on")}>Enabled</button>
				<button class="modal-btn${!webOn ? " modal-btn-primary" : ""}" title="Disable web_search and web_fetch" disabled=${busy} onClick=${() => act("/web off")}>Disabled</button>
			</div>
			<div class="settings-section-title">Web search backend</div>
			<div class="settings-form-row">
				<button class="modal-btn${provider === "ddg" ? " modal-btn-primary" : ""}" title="Free, no key — ~4 searches per IP before rate-limited" disabled=${busy} onClick=${() => act("/web-search-provider ddg")}>DuckDuckGo</button>
				<button class="modal-btn${provider === "tavily" ? " modal-btn-primary" : ""}" title="API key required — 1000 free searches/month" disabled=${busy} onClick=${() => {
					if (tKey) act(`/web-search-provider tavily ${tKey}`);
				}}>Tavily</button>
				<button class="modal-btn${provider === "brave" ? " modal-btn-primary" : ""}" title="API key required — Brave's own general web index" disabled=${busy} onClick=${() => {
					if (bKey) act(`/web-search-provider brave ${bKey}`);
				}}>Brave Search</button>
			</div>
			<div class="settings-form-row">
				<input type="password" autocomplete="off" placeholder="Tavily API key (tvly-...)" value=${tKey} onInput=${(e) => setTavilyKey(e.target.value)} />
				<button class="modal-btn" disabled=${busy || !tKey} onClick=${() => act(`/web-search-provider tavily ${tKey}`)}>Save & use Tavily</button>
			</div>
			<div class="settings-form-row">
				<input type="password" autocomplete="off" placeholder="Brave Search API key (BSA...)" value=${bKey} onInput=${(e) => setBraveKey(e.target.value)} />
				<button class="modal-btn" disabled=${busy || !bKey} onClick=${() => act(`/web-search-provider brave ${bKey}`)}>Save & use Brave</button>
			</div>
			<div class="settings-section-title">Bash confirmation mode</div>
			<div class="settings-form-row">
				<button class="modal-btn${perm.permissionMode === "default" ? " modal-btn-primary" : ""}" title="Confirm dangerous commands" disabled=${busy} onClick=${() => act("/permissions default")}>Default</button>
				<button class="modal-btn${perm.permissionMode === "bypass" ? " modal-btn-primary" : ""}" title="Skip confirmation prompts" disabled=${busy} onClick=${() => act("/permissions bypass")}>Bypass</button>
			</div>
			<div class="settings-section-title">Quick session persona</div>
			<p class="settings-hint">Persona the sidebar's "Quick" button uses — skips the picker, opens straight into a fresh sandbox directory.</p>
			<div class="settings-form-row">
				<select
					disabled=${busy || !(personas || []).length}
					value=${quickPersonaValue || quickPersona}
					onChange=${(e) => setQuickPersonaValue(e.target.value)}
				>
					${(personas || []).map((p) => html`<option key=${p.name} value=${p.name}>${p.label}</option>`)}
				</select>
				<button
					class="modal-btn icon-btn"
					title="Apply quick session persona"
					disabled=${busy || !quickPersonaValue || quickPersonaValue === quickPersona}
					onClick=${async () => {
						const res = await act(`/quick-session-persona ${quickPersonaValue}`);
						if (res.ok) {
							onQuickSessionPersonaChange?.(quickPersonaValue);
							setQuickPersonaValue("");
						}
					}}
				><${icons.check} /></button>
			</div>
		</div>
	`;
}

function SettingsMcp({ data, busy, act, confirm }) {
	const servers = data || [];
	const groups = [
		{ key: "global", label: "Global", items: servers.filter((s) => s.source === "global") },
		{ key: "project", label: "Project", items: servers.filter((s) => s.source === "project") },
	];
	const renderServer = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.connected ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.disabled ? "disabled" : s.connected ? "connected" : "not connected"}</span>
			</div>
			<div class="settings-item-actions">
				${!s.disabled && html`<button class="modal-btn icon-btn" title="Reconnect" disabled=${busy} onClick=${() => act(`/mcp reconnect ${s.name}`)}><${icons.arrowPath} /></button>`}
				<button class="modal-btn icon-btn" title=${s.disabled ? "Enable" : "Disable"} disabled=${busy} onClick=${() => act(`/mcp ${s.disabled ? "enable" : "disable"} ${s.name}`)}>${s.disabled ? html`<${icons.play} />` : html`<${icons.pause} />`}</button>
				<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
					if (await confirm(`Uninstall MCP server "${s.name}"?`)) act(`/mcp uninstall ${s.name}`);
				}}><${icons.trash} /></button>
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderServer)}
				</div>
			`,
				)}
			${servers.length === 0 && html`<div class="settings-hint">No MCP servers configured.</div>`}
		</div>
	`;
}

function SettingsSkills({ data, busy, act, confirm }) {
	const skills = data || [];
	const groups = [
		{ key: "builtin", label: "Built-in", items: skills.filter((s) => s.source === "builtin") },
		{ key: "global", label: "Global", items: skills.filter((s) => s.source === "global") },
		{
			key: "project",
			label: "Project",
			items: skills.filter((s) => s.source === "project" || s.source === "agents" || s.source === "path"),
		},
		{ key: "plugin", label: "Plugins", items: skills.filter((s) => s.source === "plugin") },
	];
	const renderSkill = (s) => html`
		<div key=${s.name} class="settings-item-row">
			<div class="settings-item-info">
				<span class="settings-item-status ${s.enabled ? "ok" : "off"}" />
				<span class="settings-item-name">${s.name}</span>
				<span class="settings-item-meta">${s.source === "plugin" && s.pluginId ? s.pluginId : s.source}</span>
				<${InfoPopover} text=${s.description} readUrl=${`/api/skill-content?name=${encodeURIComponent(s.name)}`} />
			</div>
			<div class="settings-item-actions">
				<button class="modal-btn icon-btn" title=${s.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/skills ${s.enabled ? "disable" : "enable"} ${s.name}`)}>${s.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
				${
					s.uninstallable &&
					html`<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
						if (await confirm(`Uninstall skill "${s.name}"?`)) act(`/skills uninstall ${s.name}`);
					}}><${icons.trash} /></button>`
				}
			</div>
		</div>
	`;
	return html`
		<div class="settings-rows">
			${groups
				.filter((g) => g.items.length > 0)
				.map(
					(g) => html`
				<div key=${g.key} class="settings-group">
					<div class="settings-section-title">${g.label}</div>
					${[...g.items].sort((a, b) => a.name.localeCompare(b.name)).map(renderSkill)}
				</div>
			`,
				)}
			${skills.length === 0 && html`<div class="settings-hint">No skills found.</div>`}
		</div>
	`;
}

function SettingsPlugins({ data, busy, act, confirm }) {
	const [installRef, setInstallRef] = useState("");
	const [mpSource, setMpSource] = useState("");
	if (!data) return null;
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Installed plugins</div>
			${[...data.plugins]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map(
					(p) => html`
				<div key=${p.id} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-status ${p.enabled ? "ok" : "off"}" />
						<span class="settings-item-name">${p.plugin || p.id}</span>
						<span class="settings-item-meta">${p.marketplace || ""}</span>
						<${InfoPopover} text=${p.description} />
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title=${p.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/plugin ${p.enabled ? "disable" : "enable"} ${p.id}`)}>${p.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
							if (await confirm(`Uninstall plugin "${p.id}"?`)) act(`/plugin uninstall ${p.id}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${data.plugins.length === 0 && html`<div class="settings-hint">No plugins installed.</div>`}
			<div class="settings-form-row">
				<input type="text" placeholder="name@marketplace" value=${installRef} onInput=${(e) => setInstallRef(e.target.value)} />
				<button class="modal-btn icon-btn" title="Install plugin" disabled=${busy || !installRef} onClick=${() => {
					act(`/plugin install ${installRef}`);
					setInstallRef("");
				}}><${icons.arrowDownTray} /></button>
			</div>
			<div class="settings-section-title">Marketplaces</div>
			${[...data.marketplaces]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(mp) => html`
				<div key=${mp.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${mp.name}</span>
						<span class="settings-item-meta" title=${mp.source}>${shortPath(mp.source)}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title="Update" disabled=${busy} onClick=${() => act(`/plugin marketplace update ${mp.name}`)}><${icons.arrowPath} /></button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
							if (await confirm(`Remove marketplace "${mp.name}"?`))
								act(`/plugin marketplace remove ${mp.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${data.marketplaces.length === 0 && html`<div class="settings-hint">No marketplaces added.</div>`}
			<div class="settings-form-row">
				<input type="text" placeholder="owner/repo, URL, or path" value=${mpSource} onInput=${(e) => setMpSource(e.target.value)} />
				<button class="modal-btn icon-btn" title="Add marketplace" disabled=${busy || !mpSource} onClick=${() => {
					act(`/plugin marketplace add ${mpSource}`);
					setMpSource("");
				}}><${icons.plus} /></button>
			</div>
		</div>
	`;
}

function SettingsProvider({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [editing, setEditing] = useState(null);
	const [verifyState, setVerifyState] = useState(null);
	const [saving, setSaving] = useState(false);
	const startEdit = (p) => {
		setEditing(p.name);
		setName(p.name);
		setUrl(p.url);
		setApiKey(p.apiKey);
		setVerifyState(p.url && p.apiKey ? { ok: true, msg: "Saved — re-verify to confirm changes" } : null);
	};
	const cancelEdit = () => {
		setEditing(null);
		setName("");
		setUrl("");
		setApiKey("");
		setVerifyState(null);
	};
	// Probe the entered URL + key without saving. Rejects outright when either
	// field is empty so the button can't fire a pointless round trip.
	const doVerify = async () => {
		if (!url || !apiKey) {
			setVerifyState({ ok: false, msg: "Enter a base URL and API key first" });
			return;
		}
		setVerifyState({ ok: null, msg: "Verifying…" });
		try {
			const res = await api("POST", "/api/provider/verify", { url, apiKey });
			if (res?.ok) setVerifyState({ ok: true, msg: "Provider reachable" });
			else setVerifyState({ ok: false, msg: res?.error || "Verification failed" });
		} catch (_e) {
			setVerifyState({ ok: false, msg: "Verification request failed" });
		}
	};
	// Mandatory gate: a provider is never saved with unverified credentials.
	const saveProvider = async () => {
		if (!name || !url || !apiKey) return;
		setSaving(true);
		try {
			const res = await api("POST", "/api/provider/verify", { url, apiKey });
			if (!res?.ok) {
				setVerifyState({ ok: false, msg: res?.error || "Verification failed — provider not saved" });
				return;
			}
			if (editing) {
				await act(`/provider delete ${editing}`);
				await act(`/provider add ${name} ${url} ${apiKey}`);
				if (data.find((p) => p.active && p.name === editing)) await act(`/provider ${name}`);
			} else {
				await act(`/provider add ${name} ${url} ${apiKey}`);
			}
			cancelEdit();
		} finally {
			setSaving(false);
		}
	};
	return html`
		<div class="settings-rows">
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(p) => html`
				<div key=${p.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${p.name}</span>
						<span class="settings-item-meta" title=${p.url}>${shortPath(p.url)}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn" title="Edit" disabled=${busy} onClick=${() => startEdit(p)}><${icons.pencil} /></button>
						<button class="modal-btn icon-btn modal-btn-danger" title="Delete" disabled=${busy} onClick=${async () => {
							if (await confirm(`Delete provider "${p.name}"?`)) act(`/provider delete ${p.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${!data || data.length === 0 ? html`<div class="settings-hint">No saved providers.</div>` : null}
			${data && data.length > 0 ? html`<div class="settings-hint">Providers here are just a saved list. In the Model tab, pick which provider each model slot uses (main / subagent / plan) — they can be on different providers.</div>` : null}
			<div class="settings-section-title">${editing ? `Edit provider: ${editing}` : "Add provider"}</div>
			<div class="settings-form-row">
				<input type="text" placeholder="name" value=${name} disabled=${!!editing} onInput=${(e) => {
					setName(e.target.value);
					setVerifyState(null);
				}} />
				<input type="text" placeholder="base URL" value=${url} onInput=${(e) => {
					setUrl(e.target.value);
					setVerifyState(null);
				}} />
				<input type="password" placeholder="API key" value=${apiKey} onInput=${(e) => {
					setApiKey(e.target.value);
					setVerifyState(null);
				}} />
				<button class="modal-btn icon-btn" title="Verify credentials" disabled=${busy || saving || !url || !apiKey} onClick=${doVerify}><${icons.arrowPath} /></button>
				<button class="modal-btn icon-btn" title=${editing ? "Save changes" : "Add provider"} disabled=${busy || saving || !name || !url || !apiKey} onClick=${saveProvider}><${icons.check} /></button>
				${editing ? html`<button class="modal-btn icon-btn" title="Cancel" disabled=${busy || saving} onClick=${cancelEdit}><${icons.xCircle} /></button>` : null}
			</div>
			${verifyState ? html`<div class="settings-hint ${verifyState.ok === false ? "settings-error" : verifyState.ok === true ? "settings-ok" : ""}">${verifyState.ok === false ? "✕ " : verifyState.ok === true ? "✓ " : ""}${verifyState.msg}</div>` : null}
			<div class="settings-hint">Credentials are verified before saving — the provider must be reachable.</div>
		</div>
	`;
}

function SettingsSsh({ data, busy, act, confirm }) {
	const [name, setName] = useState("");
	const [host, setHost] = useState("");
	const [username, setUsername] = useState("");
	const [port, setPort] = useState("");
	const [keyContent, setKeyContent] = useState("");
	return html`
		<div class="settings-rows">
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(h) => html`
				<div key=${h.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${h.name}</span>
						<span class="settings-item-meta">${h.username ? `${h.username}@` : ""}${h.host}${h.port ? `:${h.port}` : ""}${h.keyPath ? " (key)" : ""}</span>
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
							if (await confirm(`Remove host "${h.name}"?`)) act(`/ssh remove ${h.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
			${(!data || data.length === 0) && html`<div class="settings-hint">No SSH hosts configured.</div>`}
			<div class="settings-section-title">Add host</div>
			<div class="settings-ssh-form">
				<div class="settings-form-row">
					<input type="text" placeholder="name" value=${name} onInput=${(e) => setName(e.target.value)} />
					<input type="text" placeholder="host or IP" value=${host} onInput=${(e) => setHost(e.target.value)} />
				</div>
				<div class="settings-form-row">
					<input type="text" placeholder="username" value=${username} onInput=${(e) => setUsername(e.target.value)} />
					<input type="text" placeholder="port" value=${port} style=${{ maxWidth: "80px" }} onInput=${(e) => setPort(e.target.value)} />
				</div>
				<textarea class="settings-textarea" placeholder="Paste SSH private key (optional)" onInput=${(e) => setKeyContent(e.target.value)} rows="4">${keyContent}</textarea>
				<div class="settings-form-row" style=${{ justifyContent: "flex-end" }}>
					<button class="modal-btn icon-btn" title="Add SSH host" disabled=${busy || !name || !host} onClick=${async () => {
						let kp = "-";
						if (keyContent.trim()) {
							const res = await api("POST", "/api/ssh/key", { name, key: keyContent.trim() });
							if (!res?.ok) {
								alert(res?.error || "Failed to save key");
								return;
							}
							kp = res.path;
						}
						const parts = [name, host, username || "-", port || "-", kp];
						await act(`/ssh add ${parts.join(" ")}`);
						setName("");
						setHost("");
						setUsername("");
						setPort("");
						setKeyContent("");
					}}><${icons.plus} /></button>
				</div>
			</div>
		</div>
	`;
}

// Sentinel sent to the server when the "new" (sandbox) toggle is active — the
// actual ~/.cast/sandbox/cast-<session id> directory is only created server-side
// at session-creation time (see bridge.ts), so the UI never holds a path that
// doesn't exist yet.
const SANDBOX_CWD = "sandbox";

function Sidebar({
	sessions,
	activeId,
	personas,
	cwd,
	defaultCwd,
	quickSessionPersona,
	onSelectSession,
	onCreateSession,
	onDeleteSession,
	onOpenDirPicker,
	onSetCwd,
	onRenameSession,
	onPinSession,
	onShareSession,
	open,
	confirm,
}) {
	const [personaOpen, setPersonaOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [editingId, setEditingId] = useState(null);
	const [editValue, setEditValue] = useState("");
	const editInputRef = useRef(null);
	// One shared menu (Rename/Delete) rather than per-row state — opened by
	// the ⋮ button or a right-click anywhere on the row, closed by an outside
	// click/Escape/picking an action. Frees up the row for one icon instead
	// of two permanently-visible ones.
	const [menuFor, setMenuFor] = useState(null);
	// Whether the last-opened menu should render above its anchor instead of
	// below — a row near the bottom of the (often short, scrolled) sidebar
	// otherwise had the menu's fixed "always opens downward" positioning push
	// it straight past the viewport edge, unreachable and unclickable.
	const [menuUpward, setMenuUpward] = useState(false);
	const openMenu = useCallback((id, rowEl) => {
		if (rowEl) {
			const rect = rowEl.getBoundingClientRect();
			const ESTIMATED_MENU_HEIGHT = 150; // 3 items + padding, roomy on purpose
			setMenuUpward(rect.bottom + ESTIMATED_MENU_HEIGHT > window.innerHeight);
		}
		setMenuFor(id);
	}, []);
	useEffect(() => {
		if (!menuFor) return;
		const close = () => setMenuFor(null);
		const onKey = (e) => {
			if (e.key === "Escape") close();
		};
		// Capture phase + next-tick registration: the same click that opens
		// the menu (button click / contextmenu) would otherwise immediately
		// bubble up and close it again.
		const id = setTimeout(() => {
			window.addEventListener("click", close);
			window.addEventListener("contextmenu", close);
		}, 0);
		window.addEventListener("keydown", onKey);
		return () => {
			clearTimeout(id);
			window.removeEventListener("click", close);
			window.removeEventListener("contextmenu", close);
			window.removeEventListener("keydown", onKey);
		};
	}, [menuFor]);

	// Pinned is its own group above a divider (a deliberate, manual choice —
	// it shouldn't just be one more sort key mixed into the rest). Within
	// each group, running floats to the top (that's the "control room" — see
	// what's actually working), then most-recently-active.
	const byRunningThenDate = (a, b) => {
		const runningA = a.status === "running" ? 1 : 0;
		const runningB = b.status === "running" ? 1 : 0;
		if (runningA !== runningB) return runningB - runningA;
		return a.updatedAt < b.updatedAt ? 1 : -1;
	};
	const q = search.trim().toLowerCase();
	const filtered = sessions.filter(
		(s) =>
			!q ||
			(s.title ?? "").toLowerCase().includes(q) ||
			s.persona.toLowerCase().includes(q) ||
			s.model.toLowerCase().includes(q),
	);
	const pinnedGroup = filtered.filter((s) => s.pinned).sort(byRunningThenDate);
	const otherGroup = filtered.filter((s) => !s.pinned).sort(byRunningThenDate);
	const isSandbox = cwd === SANDBOX_CWD;

	const active = sessions.find((s) => s.id === activeId);

	const startEdit = useCallback((s) => {
		setEditingId(s.id);
		setEditValue(s.title || s.persona || "");
	}, []);
	const commitEdit = useCallback(() => {
		if (editingId) onRenameSession(editingId, editValue);
		setEditingId(null);
	}, [editingId, editValue, onRenameSession]);

	// Focus only when entering edit mode (a stable ref + effect keyed on
	// editingId), not on every keystroke — a callback ref re-invoked each
	// render would re-focus/reset the cursor on every character typed.
	useEffect(() => {
		if (editingId && editInputRef.current) {
			editInputRef.current.focus();
			editInputRef.current.select();
		}
	}, [editingId]);

	const doDelete = async (s) => {
		const message =
			s.status === "running"
				? "Stop the running agent and permanently delete this thread? This can't be undone."
				: "Permanently delete this thread? This can't be undone.";
		if (await confirm(message)) onDeleteSession(s.id);
	};

	const renderItem = (s) => html`
		<div
			key=${s.id}
			class="sidebar-item${s.id === activeId ? " active" : ""}"
			title=${s.cwd}
			onClick=${() => onSelectSession(s.id)}
			onContextMenu=${(e) => {
				e.preventDefault();
				e.stopPropagation();
				openMenu(s.id, e.currentTarget);
			}}
		>
			<span class="sidebar-item-status ${s.status || "idle"}" />
			<button
				class="sidebar-item-pin${s.pinned ? " pinned" : ""}"
				title=${s.pinned ? "Unpin" : "Pin to top"}
				onClick=${(e) => {
					e.stopPropagation();
					onPinSession(s.id, !s.pinned);
				}}
			>
				<${icons.bookmark} />
			</button>
			${
				editingId === s.id
					? html`
					<input
						ref=${editInputRef}
						class="sidebar-item-name-input"
						value=${editValue}
						onClick=${(e) => e.stopPropagation()}
						onInput=${(e) => setEditValue(e.target.value)}
						onKeyDown=${(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commitEdit();
							}
							if (e.key === "Escape") {
								e.preventDefault();
								setEditingId(null);
							}
						}}
						onBlur=${commitEdit}
					/>
				`
					: html`<span class="sidebar-item-name" onDblClick=${(e) => {
							e.stopPropagation();
							startEdit(s);
						}}>${s.title || s.persona || "unknown"}</span>`
			}
			<span class="sidebar-item-meta">${s.messageCount} msg</span>
			<div class="sidebar-item-menu-anchor">
				<button
					class="sidebar-item-more"
					title="More"
					aria-label="More"
					onClick=${(e) => {
						e.stopPropagation();
						openMenu(menuFor === s.id ? null : s.id, e.currentTarget.closest(".sidebar-item"));
					}}
				><${icons.ellipsisVertical} /></button>
				${
					menuFor === s.id &&
					html`
					<div class="sidebar-item-menu${menuUpward ? " upward" : ""}" onClick=${(e) => e.stopPropagation()}>
						<button
							class="sidebar-item-menu-item"
							onClick=${() => {
								setMenuFor(null);
								startEdit(s);
							}}
						><${icons.pencil} /> Rename</button>
						<button
							class="sidebar-item-menu-item"
							onClick=${() => {
								setMenuFor(null);
								onShareSession(s);
							}}
						><${icons.link} /> Share</button>
						<button
							class="sidebar-item-menu-item danger"
							onClick=${() => {
								setMenuFor(null);
								doDelete(s);
							}}
						><${icons.trash} /> Delete</button>
					</div>
				`
				}
			</div>
		</div>
	`;

	return html`
		<nav class="sidebar${open ? " open" : ""}">
			<div class="sidebar-new-section">
				<div class="sidebar-new-buttons">
					<button
						class="new-session-btn"
						title="Pick a persona and directory for a new session"
						onClick=${() => setPersonaOpen(!personaOpen)}
					><${icons.plus} /> New session</button>
					<button
						class="new-session-btn-quick"
						title=${`Quick session — ${personas.find((p) => p.name === quickSessionPersona)?.label ?? quickSessionPersona}, fresh sandbox directory (configurable in Settings > Tools)`}
						aria-label="Quick session"
						onClick=${() => {
							setPersonaOpen(false);
							onCreateSession(quickSessionPersona, SANDBOX_CWD);
						}}
					><${icons.bolt} /></button>
				</div>
			</div>
			<div class="sidebar-divider" />
			<div class="sidebar-scroll">
				<div class="persona-list${personaOpen ? " open" : ""}">
					<div class="dir-row">
						<span class="dir-row-label">Directory</span>
						<div class="dir-toggle">
							<button
								class="dir-toggle-btn${!isSandbox ? " active" : ""}"
								title=${isSandbox ? defaultCwd : cwd}
								onClick=${isSandbox ? () => onSetCwd(null) : onOpenDirPicker}
							>${shortPath(isSandbox ? defaultCwd : cwd)}</button>
							<button
								class="dir-toggle-btn dir-toggle-sandbox${isSandbox ? " active" : ""}"
								title="Create a fresh sandbox directory for a throwaway session"
								onClick=${() => onSetCwd(SANDBOX_CWD)}
							>new</button>
						</div>
					</div>
					${personas.map(
						(p) => html`
						<div key=${p.name} class="persona-item" onClick=${() => {
							onCreateSession(p.name, cwd);
							setPersonaOpen(false);
						}}>
							${p.label}
							<span class="persona-label">${p.source}</span>
						</div>
					`,
					)}
				</div>
				<div class="sidebar-section">
					<div class="sidebar-section-title">Sessions</div>
					${
						sessions.length > 4 &&
						html`
						<input
							class="sidebar-search"
							type="text"
							placeholder="Search sessions..."
							value=${search}
							onInput=${(e) => setSearch(e.target.value)}
						/>
					`
					}
					${
						pinnedGroup.length > 0 &&
						html`
						<div class="sidebar-group-label">Pinned</div>
						${pinnedGroup.map(renderItem)}
						<div class="sidebar-group-divider" />
					`
					}
					${otherGroup.map(renderItem)}
					${pinnedGroup.length === 0 && otherGroup.length === 0 && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
				</div>
			</div>
			${
				active &&
				html`
				<div class="sidebar-footer" title=${active.cwd}>
					<span class="sidebar-footer-status ${active.status || "idle"}" />
					<span class="sidebar-footer-model">${active.model}</span>
				</div>
			`
			}
		</nav>
	`;
}

// ── App (root) ───────────────────────────────────────────────────────

// Stable render key per message object, independent of its position in the
// array. Needed because loadOlderMessages() prepends to the front of
// session.messages — an index-based key would make every already-mounted
// message look "changed" (its index shifted) and force Preact to remount
// each one instead of just inserting the new items above them. Message
// objects are only ever created once and then carried by reference through
// spreads (`[...prev.messages, x]`), never cloned, so a WeakMap keyed by
// that reference is a correct, zero-touch-site way to give every message a
// permanent identity — no need to stamp an id at each of the many places a
// message enters the array (initial fetch, scroll-up page, live SSE events,
// steering/queue injections, ...).
const messageKeys = new WeakMap();
let nextMessageKey = 0;
function keyForMessage(msg) {
	if (typeof msg !== "object" || msg === null) return String(msg);
	let k = messageKeys.get(msg);
	if (k === undefined) {
		k = ++nextMessageKey;
		messageKeys.set(msg, k);
	}
	return k;
}

// Generates (idempotent) or revokes a thread's public /shared/<token> link.
// Opened from the sidebar's ⋮ menu — `session` is null when closed.
function ShareModal({ session, onClose }) {
	const [url, setUrl] = useState(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const modalRef = useModalFocusTrap(!!session);

	useEffect(() => {
		if (!session) {
			setUrl(null);
			setCopied(false);
			return;
		}
		setBusy(true);
		api("POST", `/api/sessions/${session.id}/share`)
			.then((data) => {
				if (data) setUrl(`${window.location.origin}${data.url}`);
			})
			.finally(() => setBusy(false));
	}, [session]);

	if (!session) return null;

	const copy = async () => {
		try {
			if (navigator.clipboard) await navigator.clipboard.writeText(url);
			else {
				const ta = document.createElement("textarea");
				ta.value = url;
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
			}
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};

	const revoke = async () => {
		setBusy(true);
		try {
			await api("DELETE", `/api/sessions/${session.id}/share`);
			onClose();
		} finally {
			setBusy(false);
		}
	};

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal modal-share" role="dialog" aria-modal="true" aria-label="Share thread" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Share "${session.title || session.persona}"</span>
					<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="modal-share-body">
					<p class="modal-hint">Anyone with this link can read the conversation, read-only — no cast login needed.</p>
					${
						url
							? html`
							<div class="share-link-row">
								<input class="share-link-input" readOnly value=${url} onClick=${(e) => e.target.select()} />
								<button class="modal-btn icon-btn" title="Copy link" onClick=${copy}>
									<${copied ? icons.check : icons.link} />
								</button>
							</div>
						`
							: html`<div class="modal-hint">Generating link…</div>`
					}
				</div>
				<div class="modal-footer">
					<button class="modal-btn modal-btn-danger" disabled=${busy || !url} onClick=${revoke}>Revoke link</button>
					<button class="modal-btn" onClick=${onClose}>Done</button>
				</div>
			</div>
		</div>
	`;
}

// Live stopwatch shown in the composer footer while a turn runs — split out
// as its own component (rather than state living in App) so its 10Hz tick
// only re-renders this one tiny <span>, not the entire app (sidebar, header,
// message list) ten times a second. That whole-tree churn was visible as a
// flicker across the UI (the header's "i" button included) for the entire
// duration of every run.
// turnStartRef is owned by App (see there) and mutated directly by
// handleSubmit right when a new turn starts — a ref write triggers no
// re-render on its own, so App can clear the previous entry there without
// reintroducing the whole-tree churn this component exists to avoid.
function ElapsedTimer({ running, activeId, connected, turnStartRef }) {
	const [elapsedMs, setElapsedMs] = useState(0);
	useEffect(() => {
		if (running && connected) {
			if (!turnStartRef.current.has(activeId)) turnStartRef.current.set(activeId, Date.now());
			const id = setInterval(() => {
				const start = turnStartRef.current.get(activeId);
				if (start) setElapsedMs(Date.now() - start);
			}, 100);
			return () => clearInterval(id);
		} else if (!running) {
			// Freeze the display for 5s after the run ends, then hide.
			const timeout = setTimeout(() => setElapsedMs(0), 5000);
			return () => clearTimeout(timeout);
		}
		// Disconnected while running — freeze the timer at the last known
		// value instead of counting up with a stale connection. When the SSE
		// reconnects (connected→true) the interval resumes from the real
		// start time; if the run ended server-side while offline, the next
		// `end` event will transition to the "not running" branch.
	}, [running, activeId, connected, turnStartRef]);

	if (elapsedMs <= 0) return null;
	return html`<span class="composer-elapsed">${(elapsedMs / 1000).toFixed(1)}s</span>`;
}

function App() {
	const [sessions, setSessions] = useState([]);
	const [activeId, setActiveId] = useState(null);
	// Per-session turn start times for ElapsedTimer's stopwatch — a plain ref
	// (not state) so handleSubmit can clear the previous entry on a new turn
	// without causing a re-render; see ElapsedTimer's own comment for why the
	// tick itself lives there instead of here.
	const turnStartRef = useRef(new Map());
	const [session, setSession] = useState(null);
	const [personas, setPersonas] = useState([]);
	const [commands, setCommands] = useState([]);
	// Re-fetched per active session (not just once at boot) because the list
	// now includes one live slash-command entry per loaded, enabled skill —
	// those vary by session cwd and change after /reload, so a stale one-shot
	// fetch would leave the palette missing/showing skills that no longer
	// match reality.
	const refreshCommands = useCallback(async (id) => {
		const c = await api("GET", `/api/commands${id ? `?session=${encodeURIComponent(id)}` : ""}`).catch(() => null);
		if (c) setCommands(c);
	}, []);
	useEffect(() => {
		if (activeId) refreshCommands(activeId);
	}, [activeId, refreshCommands]);
	const [themes, setThemes] = useState([]);
	const [currentThemeId, setCurrentThemeId] = useState(null);
	// Font/scale, unlike theme, are purely client-side (localStorage — see
	// applyFont/applyFontScale) — index.html's inline script already applied
	// whatever was cached before this component ever mounted, so these just
	// need to start in sync with that for Settings > Font's swatches/scale
	// buttons to show the right one as selected from the first render.
	const [currentFontId, setCurrentFontId] = useState(() => {
		try {
			return localStorage.getItem("cast:fontId") || DEFAULT_FONT_ID;
		} catch {
			return DEFAULT_FONT_ID;
		}
	});
	const [currentFontScale, setCurrentFontScale] = useState(() => {
		try {
			return Number(localStorage.getItem("cast:fontScale")) || DEFAULT_FONT_SCALE;
		} catch {
			return DEFAULT_FONT_SCALE;
		}
	});
	const [streaming, setStreaming] = useState([]);
	// SSE delivers token/thinking deltas at the model's raw generation rate,
	// which can spike well past 60fps for a fast model or a burst of buffered
	// events. Calling setStreaming (full markdown re-render + reflow of the
	// whole growing block) on every single delta was measured causing 300ms+
	// main-thread stalls and dropped frames on long, tool-heavy replies — so
	// high-frequency updates go through this ref and get coalesced to at most
	// one React commit per animation frame instead of one per SSE event.
	const streamingRef = useRef([]);
	const streamingRafRef = useRef(null);
	const flushStreaming = useCallback(() => {
		streamingRafRef.current = null;
		setStreaming(streamingRef.current);
	}, []);
	const updateStreaming = useCallback(
		(updater) => {
			streamingRef.current = updater(streamingRef.current);
			if (streamingRafRef.current == null) streamingRafRef.current = requestAnimationFrame(flushStreaming);
		},
		[flushStreaming],
	);
	// Discrete transitions (turn end, abort, reconnect) that must land
	// immediately rather than risk sitting behind a still-pending frame.
	const resetStreamingNow = useCallback(() => {
		if (streamingRafRef.current != null) {
			cancelAnimationFrame(streamingRafRef.current);
			streamingRafRef.current = null;
		}
		streamingRef.current = [];
		setStreaming([]);
	}, []);
	// Same, but for call sites that need the accumulated blocks (streaming
	// content being promoted into a real persisted message) before clearing.
	const takeStreamingNow = useCallback(() => {
		if (streamingRafRef.current != null) {
			cancelAnimationFrame(streamingRafRef.current);
			streamingRafRef.current = null;
		}
		const snapshot = streamingRef.current;
		streamingRef.current = [];
		setStreaming([]);
		return snapshot;
	}, []);
	const [running, setRunning] = useState(false);
	// Shown as a small gray line under the last reply so the user knows which
	// provider/model actually answered before deciding whether to /model away
	// from it. Ephemeral — reset on session switch, not part of `session`.
	const [turnMeta, setTurnMeta] = useState(null);
	const [pendingSteers, setPendingSteers] = useState([]);
	const [pendingQueue, setPendingQueue] = useState([]);
	// Open/closed and which tab, like theme/font below, survive a page
	// reload via localStorage — losing "I had Files open" on every refresh
	// (or worse, having to reload while it was mid-task) was just annoying.
	const [diffOpen, setDiffOpen] = useState(() => {
		try {
			return localStorage.getItem("cast:diffOpen") === "1";
		} catch {
			return false;
		}
	});
	const [diffData, setDiffData] = useState(null);
	const [diffFile, setDiffFile] = useState(null);
	const [diffTab, setDiffTab] = useState(() => {
		try {
			return localStorage.getItem("cast:diffTab") || "changes";
		} catch {
			return "changes";
		}
	});
	// Bumped on every tool_end while the diff panel is open, same trigger as
	// loadDiff() below — the Files tab's tree is fetched once per expanded
	// folder and otherwise never refetched on its own, so a write/edit that
	// landed while you had it open wouldn't show up until you manually
	// collapsed and reopened that folder.
	const [fsRefreshNonce, setFsRefreshNonce] = useState(0);
	useEffect(() => {
		try {
			localStorage.setItem("cast:diffOpen", diffOpen ? "1" : "0");
		} catch {}
	}, [diffOpen]);
	useEffect(() => {
		try {
			localStorage.setItem("cast:diffTab", diffTab);
		} catch {}
	}, [diffTab]);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [diffWidth, setDiffWidth] = useState(null);
	const [toasts, setToasts] = useState([]);
	const [connected, setConnected] = useState(true);
	const [backendUp, setBackendUp] = useState(true);
	// True only for the very first bootstrap (page load / hard refresh),
	// before initClientState has picked a session (or, with none saved yet,
	// staged a draft) — see the empty-state render below. Without this, a
	// reload landing on ?session=<id> shows the "Ready when you are" empty
	// thread banner for the beat it takes the GET to resolve, then swaps to
	// the real transcript — reading as the thread flashing/reloading.
	const [bootstrapping, setBootstrapping] = useState(true);
	const [atBottom, setAtBottom] = useState(true);
	const [defaultCwd, setDefaultCwd] = useState("");
	// Persona the sidebar's "Quick session" button uses — configurable in
	// Settings > Tools, defaults to "coding" server-side when never set.
	const [quickSessionPersona, setQuickSessionPersona] = useState("coding");
	// "new" (a fresh sandbox dir) is the default for a new session, not the
	// project root — picking the root path is the deliberate action here.
	const [selectedCwd, setSelectedCwd] = useState(SANDBOX_CWD);
	const [dirPickerOpen, setDirPickerOpen] = useState(false);
	const [hotkeysOpen, setHotkeysOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Settings' destructive actions (uninstall/remove/delete) need a Yes/No
	// gate. A single piece of state here — rather than one per callsite —
	// means one confirm modal, styled like the rest of the app instead of
	// the browser's native confirm(), reused by every "are you sure?" button.
	const [confirmState, setConfirmState] = useState(null);
	const requestConfirm = useCallback((message) => new Promise((resolve) => setConfirmState({ message, resolve })), []);
	const cwd = selectedCwd ?? defaultCwd ?? "";

	// Legacy per-browser "declutter" set from the old soft-close action (now
	// replaced by the sidebar menu's real Delete) — kept so anyone with
	// entries already in localStorage doesn't have old dismissed sessions
	// reappear, and re-opening one by URL (a shared link, browser history)
	// still un-hides it again.
	const [dismissedIds, setDismissedIds] = useState(() => {
		try {
			return new Set(JSON.parse(localStorage.getItem("cast:dismissedSessions") || "[]"));
		} catch {
			return new Set();
		}
	});
	const undismiss = useCallback((id) => {
		setDismissedIds((prev) => {
			if (!prev.has(id)) return prev;
			const next = new Set(prev);
			next.delete(id);
			try {
				localStorage.setItem("cast:dismissedSessions", JSON.stringify([...next]));
			} catch {}
			return next;
		});
	}, []);

	const esRef = useRef(null);
	const messagesRef = useRef(null);
	const autoScrollRef = useRef(true);
	const selfClosingRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const wasRunningRef = useRef(false);
	const [reconnectNonce, setReconnectNonce] = useState(0);
	// Read inside the SSE effect's onmessage handler instead of closing over
	// `diffOpen` directly — that effect only needs the *current* value at
	// event time, not to itself re-run (and tear down/reopen the whole
	// EventSource, refetching and remounting every message — see below)
	// every time the diff panel opens or closes.
	const diffOpenRef = useRef(false);
	diffOpenRef.current = diffOpen;
	// Same idea, read by initClientState on a reconnect where personas were
	// already loaded once (see staticResourcesLoadedRef) and it's just
	// picking a default for a fresh draft — without needing `personas` as a
	// dependency of that useCallback.
	const personasRef = useRef([]);
	personasRef.current = personas;

	// Scroll-up pagination for long threads: older pages already fetched this
	// tab session, keyed by session id, so switching away and back doesn't
	// refetch. Cleared only on a full reload — messages never change once
	// fetched (compaction can't retroactively edit history, see recordCompaction),
	// so there's no staleness to invalidate against.
	const olderPagesCacheRef = useRef(new Map());
	const loadingOlderRef = useRef(false);
	// Set right before prepending older messages, to the scroll container's
	// current scrollHeight — the restore effect below uses it to keep the
	// same content visually in place instead of the view jumping as new
	// (taller) content gets inserted above what's on screen.
	const pendingScrollRestoreRef = useRef(null);

	// Toast helper — stacks; each entry removes itself after 4s.
	const showToast = useCallback((text, type = "info") => {
		const id = `${Date.now()}-${Math.random()}`;
		setToasts((prev) => [...prev, { id, text, type }]);
		setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
	}, []);

	// Command feedback belongs in the permanent transcript, not a 4-second
	// toast — role "warning" (not "system") since the real system-prompt
	// message at messages[0] is role:"system" and gets filtered from view.
	const addNotice = useCallback((text, role = "warning") => {
		setSession((prev) => (prev ? { ...prev, messages: [...prev.messages, { role, content: text }] } : prev));
	}, []);

	// Load sessions
	const loadSessions = useCallback(async () => {
		try {
			const data = await api("GET", "/api/sessions");
			setSessions(data);
		} catch {}
	}, []);

	// Select session — `push` controls whether this lands as a new browser
	// history entry (a real click) or just replaces the current URL
	// (programmatic: initial bootstrap, reconnect recovery, popstate).
	const selectSession = useCallback(
		async (id, { push = true, prefetch = null } = {}) => {
			try {
				// initClientState may already have this in flight — kicked off
				// alongside (not after) the personas/session-list calls when the
				// URL names a session up front, saving a full round trip on a
				// reload landing on ?session=<id>. Falls through to a normal fetch
				// for every other caller (sidebar clicks, popstate, ...).
				const data = prefetch ? await prefetch : await api("GET", `/api/sessions/${id}`);
				if (!data) throw new Error("Not found");
				// Splice in older pages already loaded via scroll-up earlier this
				// tab session — only if nothing changed underneath: the cache's
				// anchorSeq is the oldestSeq the *latest* page had when caching
				// started, so a mismatch means new turns landed since (e.g. a
				// background task woke this session while looking at another
				// one) and the cache is stale for the gap. Simplest safe answer:
				// drop it and let scroll-up refetch — correctness over a saved
				// round trip in that rare case.
				const cached = olderPagesCacheRef.current.get(id);
				if (cached && cached.anchorSeq === data.oldestSeq) {
					data.messages = [...cached.messages, ...data.messages];
					data.oldestSeq = cached.oldestSeq;
					data.hasMoreHistory = cached.hasMore;
				} else {
					olderPagesCacheRef.current.set(id, {
						anchorSeq: data.oldestSeq,
						messages: [],
						oldestSeq: data.oldestSeq,
						hasMore: data.hasMoreHistory,
					});
				}
				setSession(data);
				setActiveId(id);
				resetStreamingNow();
				setTurnMeta(null);
				setRunning(data.status === "running");
				wasRunningRef.current = data.status === "running";
				setSidebarOpen(false);
				try {
					localStorage.setItem("cast:lastSessionId", id);
				} catch {}
				setUrlSessionId(id, { push });
				undismiss(id);
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[showToast, undismiss, resetStreamingNow],
	);

	// Create session — the POST already returns the full new (empty) session,
	// so apply it directly instead of two more round trips (list + refetch)
	// before anything shows up. Internal: only ever called once, either by
	// startDraft's first-message handoff in submitMessage, or directly for
	// the handful of places that still need a session to exist immediately
	// (nothing left after this change — kept as the one place that actually
	// talks to POST /api/sessions).
	const commitSession = useCallback(
		async (persona, cwd, { push = true } = {}) => {
			const data = await api("POST", "/api/sessions", { persona, cwd });
			setActiveId(data.id);
			setSession({
				id: data.id,
				persona: data.session.persona,
				model: data.session.model,
				cwd: data.session.cwd,
				status: "idle",
				messages: [],
				usage: data.session.usage,
				createdAt: data.session.createdAt,
				updatedAt: data.session.updatedAt,
			});
			resetStreamingNow();
			setRunning(false);
			setSidebarOpen(false);
			try {
				localStorage.setItem("cast:lastSessionId", data.id);
			} catch {}
			setUrlSessionId(data.id, { push });
			loadSessions();
			return data.id;
		},
		[loadSessions, resetStreamingNow],
	);

	// "+ New session" — picking a persona no longer hits the server at all.
	// It stages a local-only draft (persona + cwd, empty transcript) so an
	// abandoned "new chat" never shows up as a thread anywhere — the real
	// POST /api/sessions only happens from submitMessage, the first time
	// this draft actually gets a message (see there). Same idea as ChatGPT's
	// "New chat": the conversation doesn't exist until you say something.
	const startDraft = useCallback(
		(persona, draftCwd) => {
			if (esRef.current) {
				esRef.current.close();
				esRef.current = null;
			}
			setActiveId(null);
			setSession({
				id: null,
				persona,
				model: "",
				cwd: draftCwd,
				status: "idle",
				messages: [],
				usage: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				isDraft: true,
			});
			resetStreamingNow();
			setRunning(false);
			setSidebarOpen(false);
			const url = window.location.pathname;
			window.history.pushState({ sessionId: null }, "", url);
		},
		[resetStreamingNow],
	);

	// Static, rarely-changing resource lists — personas/commands/themes/config
	// — only ever need fetching once per tab. Theme changes made mid-session
	// (Settings modal, /theme) already call applyTheme()/setCurrentThemeId
	// directly, so there's nothing here that goes stale between then and a
	// reconnect. Guarded by this ref rather than state so initClientState
	// (a useCallback) doesn't need it as a dependency.
	const staticResourcesLoadedRef = useRef(false);

	// Full client bootstrap — on first mount, personas/commands/themes/config
	// too; every time (including reconnect), the session list, landing on
	// whichever one was last active (see selectSession's localStorage write).
	// Also used to recover after the backend goes away and comes back (see
	// startReconnectLoop below): sessions live only in-memory server-side, so
	// a backend restart loses every one of them, and re-running this exact
	// sequence is what lets the page keep working without a manual reload
	// once it's back. Re-fetching (and re-applying) the static resources on
	// every one of those reconnects too used to make the theme/persona list
	// visibly flash back in on every blip — see staticResourcesLoadedRef.
	const initClientState = useCallback(async () => {
		try {
			// Fired immediately, before anything else, so a reload landing on
			// ?session=<id> (the common case: a bookmarked/shared/reopened link)
			// doesn't pay for personas -> session list -> this session's own GET
			// as three round trips in a row when the id is already known up
			// front. Awaited down in the `s.length > 0` branch below, by which
			// point it's had the personas+session-list fetch time to resolve in
			// the background — usually free.
			const urlId = sessionIdFromUrl();
			const sessionPrefetch = urlId ? api("GET", `/api/sessions/${urlId}`).catch(() => null) : null;

			if (!staticResourcesLoadedRef.current) {
				const p = await api("GET", "/api/personas");
				if (!p) return false;
				const sortedPersonas = [...p].sort((a, b) => a.label.localeCompare(b.label));
				setPersonas(sortedPersonas);
				api("GET", "/api/commands")
					.then((c) => c && setCommands(c))
					.catch(() => {});
				api("GET", "/api/themes")
					.then((t) => {
						if (!t) return;
						setThemes(t);
						api("GET", "/api/config")
							.then((cfg) => {
								if (!cfg) return;
								setDefaultCwd(cfg.cwd ?? "");
								if (cfg.quickSessionPersona) setQuickSessionPersona(cfg.quickSessionPersona);
								const current = t.find((x) => x.id === cfg.theme) ?? t.find((x) => x.id === "cast");
								if (current) {
									applyTheme(current.colors);
									setCurrentThemeId(current.id);
								}
							})
							.catch(() => {});
					})
					.catch(() => {});
				staticResourcesLoadedRef.current = true;
			}

			const s = await api("GET", "/api/sessions");
			if (!s) return false;
			setSessions(s);
			if (s.length > 0) {
				// URL wins (lets a shared/duplicated/bookmarked link always land on
				// that exact thread) over the last-active fallback from localStorage.
				let lastId = null;
				try {
					lastId = localStorage.getItem("cast:lastSessionId");
				} catch {}
				const target =
					urlId && s.find((x) => x.id === urlId)
						? urlId
						: lastId && s.find((x) => x.id === lastId)
							? lastId
							: s[0].id;
				await selectSession(target, { push: false, prefetch: target === urlId ? sessionPrefetch : null });
			} else {
				const current = personasRef.current;
				const defaultP = current.find((x) => x.name === "coding") ?? current[0];
				if (defaultP) startDraft(defaultP.name, undefined);
			}
			return true;
		} catch {
			return false;
		}
	}, [selectSession, startDraft]);

	// The browser's own EventSource retry only covers a connection that
	// dropped after connecting fine (network blip, laptop sleep) — it does
	// NOT retry when the very first request comes back non-2xx (readyState
	// goes straight to CLOSED), which is exactly what happens when the
	// backend restarts: every session lived only in memory, so the old
	// session id 404s forever. This polls until the backend responds again,
	// then re-bootstraps and bumps reconnectNonce so the SSE effect below
	// re-subscribes even if selectSession happens to land back on the same id.
	const startReconnectLoop = useCallback(() => {
		if (reconnectTimerRef.current) return;
		// Set synchronously, before the first async attempt even starts — a
		// dropped connection can fire `onerror` more than once in a row (each
		// EventSource the SSE effect spins up during recovery has its own),
		// and without a guard that's set immediately, two overlapping retry
		// loops can each see "no sessions yet" and each create their own
		// default session (a real duplicate-session race, caught in testing).
		reconnectTimerRef.current = "pending";
		const tryOnce = async () => {
			const ok = await initClientState();
			if (ok) {
				reconnectTimerRef.current = null;
				setBackendUp(true);
				setReconnectNonce((n) => n + 1);
			} else {
				setBackendUp(false);
				reconnectTimerRef.current = setTimeout(tryOnce, 3000);
			}
		};
		tryOnce();
	}, [initClientState]);

	// The sidebar's Delete action — actually removes the session (and its
	// messages) from disk, unlike the old close/soft-hide it replaced. Drops
	// the row from `sessions` entirely instead of hiding it via the
	// per-browser dismissed-set, and aborts first if it's still running.
	const deleteSessionPermanently = useCallback(
		async (id) => {
			if (id === activeId) selfClosingRef.current = id;
			try {
				await api("DELETE", `/api/sessions/${id}/permanent`);
			} catch (err) {
				showToast(err.message, "error");
				return;
			}
			setSessions((prev) => prev.filter((s) => s.id !== id));
			try {
				if (localStorage.getItem("cast:lastSessionId") === id) localStorage.removeItem("cast:lastSessionId");
			} catch {}
			if (id !== activeId) return;

			if (esRef.current) {
				esRef.current.close();
				esRef.current = null;
			}
			const remaining = sessions.filter((s) => s.id !== id && !dismissedIds.has(s.id));
			if (remaining.length > 0) {
				await selectSession(remaining[0].id, { push: false });
				return;
			}
			const defaultP = personas.find((x) => x.name === "coding") ?? personas[0];
			if (defaultP) startDraft(defaultP.name, undefined);
			else {
				setActiveId(null);
				setSession(null);
				resetStreamingNow();
			}
		},
		[sessions, activeId, personas, selectSession, startDraft, showToast, dismissedIds, resetStreamingNow],
	);

	// Rename — overrides the auto-derived-from-first-message title. Updates
	// the sidebar list optimistically instead of waiting on a full refetch.
	const renameSession = useCallback(
		async (id, title) => {
			try {
				const data = await api("POST", `/api/sessions/${id}/rename`, { title });
				setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: data?.title } : s)));
				if (id === activeId) setSession((prev) => (prev ? { ...prev, title: data?.title } : prev));
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, showToast],
	);

	const pinSession = useCallback(
		async (id, pinned) => {
			try {
				const data = await api("POST", `/api/sessions/${id}/pin`, { pinned });
				setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, pinned: data?.pinned } : s)));
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[showToast],
	);

	// Holds the session the Share modal is open for — null when closed.
	const [shareModalSession, setShareModalSession] = useState(null);

	// Sidebar toggle — a drawer on mobile (existing transform-based behavior),
	// a collapsible grid column on desktop (same button, different meaning).
	// On mobile both drawers are full-screen, so opening this one closes the
	// diff/Files drawer if it was open — otherwise the most-recently-opened
	// one wins by CSS accident and the other requires an extra manual close.
	const toggleSidebar = useCallback(() => {
		if (window.innerWidth <= 768) {
			setSidebarOpen((v) => {
				const next = !v;
				if (next) setDiffOpen(false);
				return next;
			});
		} else setSidebarCollapsed((v) => !v);
	}, []);

	// Opening the diff panel on a mid-width viewport leaves too little room for
	// the chat column otherwise — auto-collapse the sidebar to compensate. Only
	// on open, and only if the user hasn't already dealt with it; closing diff
	// doesn't force the sidebar back (that'd fight a manual re-expand). On
	// mobile, both drawers are full-screen, so opening this one closes the
	// sidebar drawer if it was open — same reasoning as toggleSidebar above.
	const toggleDiff = useCallback(() => {
		setDiffOpen((v) => {
			const next = !v;
			if (next && window.innerWidth <= 768) setSidebarOpen(false);
			if (next && window.innerWidth > 768 && window.innerWidth < 1200) setSidebarCollapsed(true);
			return next;
		});
	}, []);

	// Diff panel drag-to-resize — pointer events so mouse and touch both work.
	const dragStateRef = useRef(null);
	const onDiffResizeMove = useCallback((e) => {
		const st = dragStateRef.current;
		if (!st) return;
		const delta = st.startX - e.clientX;
		const next = Math.min(Math.max(st.startWidth + delta, 320), Math.round(window.innerWidth * 0.85));
		setDiffWidth(next);
	}, []);
	const onDiffResizeEnd = useCallback(() => {
		dragStateRef.current = null;
		document.body.classList.remove("resizing-diff");
		window.removeEventListener("pointermove", onDiffResizeMove);
	}, [onDiffResizeMove]);
	const startDiffResize = useCallback(
		(e) => {
			e.preventDefault();
			const panel = document.querySelector(".diff-panel");
			dragStateRef.current = {
				startX: e.clientX,
				startWidth: panel?.getBoundingClientRect().width ?? diffWidth ?? 560,
			};
			document.body.classList.add("resizing-diff");
			window.addEventListener("pointermove", onDiffResizeMove);
			window.addEventListener("pointerup", onDiffResizeEnd, { once: true });
		},
		[diffWidth, onDiffResizeMove, onDiffResizeEnd],
	);

	// Submit message
	const submitMessage = useCallback(
		async (text) => {
			// Pure client-side commands need no live (or even draft) session —
			// handled before any draft-commit below so idly hitting /diff or
			// /copy on a fresh "new session" draft can't spuriously create a
			// real backend session with nothing actually said yet.
			if (text === "/diff") {
				toggleDiff();
				return;
			}
			if (text === "/copy") {
				const lastAssistant = [...(session?.messages ?? [])].reverse().find((m) => m.role === "assistant");
				if (!lastAssistant) {
					addNotice("Nothing to copy yet");
					return;
				}
				// Live-flushed messages carry `blocks`, not a flat `content` string —
				// copy the reply text only (skip reasoning/tool blocks).
				const text2 = Array.isArray(lastAssistant.blocks)
					? lastAssistant.blocks
							.filter((b) => b.kind === "content")
							.map((b) => b.text)
							.join("")
					: typeof lastAssistant.content === "string"
						? lastAssistant.content
						: JSON.stringify(lastAssistant.content);
				try {
					if (navigator.clipboard) {
						await navigator.clipboard.writeText(text2);
					} else {
						// HTTP fallback — Clipboard API unavailable outside secure contexts.
						const ta = document.createElement("textarea");
						ta.value = text2;
						ta.style.cssText = "position:fixed;opacity:0";
						document.body.appendChild(ta);
						ta.select();
						document.execCommand("copy");
						document.body.removeChild(ta);
					}
					addNotice("Copied to clipboard");
				} catch {
					addNotice("Copy failed", "error");
				}
				return;
			}

			// The composer is enabled for a local-only draft (see startDraft) as
			// well as a real session — this is the one place a draft ever turns
			// into an actual backend session, exactly when it gets its first
			// real content, same as ChatGPT's "new chat" only existing once you
			// send something into it.
			let id = activeId;
			if (!id) {
				if (session?.isDraft) {
					try {
						id = await commitSession(session.persona, session.cwd, { push: true });
					} catch (err) {
						showToast(err.message, "error");
						return;
					}
				} else {
					// Composer is disabled while !ready, so this only fires on a very
					// fast Enter right as the page loads — surface it instead of eating
					// the message silently.
					showToast("Still connecting — try again in a moment", "error");
					return;
				}
			}
			if (text.startsWith("/")) {
				try {
					const result = await api("POST", `/api/sessions/${id}/command`, { command: text });
					if (text === "/sessions") await loadSessions();
					if (text.startsWith("/new") && result?.result?.sessionId) {
						await loadSessions();
						await selectSession(result.result.sessionId);
						return; // now viewing the fresh session — nothing to append a notice to
					}
					if (text === "/clear" && session) {
						olderPagesCacheRef.current.delete(id);
						setSession({ ...session, messages: [], oldestSeq: null, hasMoreHistory: false });
						return; // context just got wiped — nothing left to append a notice to
					}
					if (text.startsWith("/persona") && result?.result?.persona) {
						setSession((prev) => (prev ? { ...prev, persona: result.result.persona } : prev));
						await loadSessions();
						addNotice(`Persona: ${result.result.label ?? result.result.persona}`);
					} else if (text.startsWith("/model") && result?.result?.model) {
						setSession((prev) => (prev ? { ...prev, model: result.result.model } : prev));
						await loadSessions();
						addNotice(`Model: ${result.result.model}`);
					} else if (text.startsWith("/theme") && result?.result?.theme) {
						if (result.result.colors) applyTheme(result.result.colors);
						setCurrentThemeId(result.result.theme);
						addNotice(`Theme: ${result.result.label ?? result.result.theme}`);
					} else if (text.startsWith("/current") && result?.result) {
						const r = result.result;
						addNotice(`${r.persona} · ${r.model} · ${r.status} · ${r.messageCount} msg`);
					} else if (text.startsWith("/usage") && result?.result) {
						const u = result.result;
						const cost = u.cost ? ` · $${u.cost.toFixed(4)}` : "";
						addNotice(
							`${u.totalTokens ?? 0} tokens (${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out)${cost}`,
						);
					} else if (text === "/sessions" && Array.isArray(result?.result)) {
						addNotice(`${result.result.length} session${result.result.length === 1 ? "" : "s"}`);
					} else if (text.startsWith("/repo") && result?.result) {
						const r = result.result;
						addNotice(
							r.isGit ? `${r.cwd} · ${r.branch}${r.dirty ? " (dirty)" : ""}` : `${r.cwd} — not a git repository`,
						);
					} else if (text.startsWith("/reasoning") && result?.result) {
						const r = result.result;
						addNotice(
							r.note ??
								`Reasoning: ${r.reasoningLevel}${r.options?.length ? ` (options: ${r.options.join(", ")})` : ""}`,
						);
					} else if (text.startsWith("/web") && result?.result && "webTools" in result.result) {
						addNotice(`Web tools: ${result.result.webTools ? "enabled" : "disabled"}`);
					} else if ((text.startsWith("/steer") || text.startsWith("/s ")) && result?.ok) {
						const msg = text.replace(/^\/(steer|s)\s*/, "");
						if (msg) setPendingSteers((prev) => [...prev, msg]);
						addNotice(result.result);
					} else if ((text.startsWith("/queue") || text.startsWith("/q ")) && result?.ok) {
						const msg = text.replace(/^\/(queue|q)\s*/, "");
						if (msg) setPendingQueue((prev) => [...prev, msg]);
						addNotice(result.result);
					} else if ((text === "/queue-reset" || text === "/qr") && result?.ok) {
						setPendingQueue([]);
						addNotice(result.result);
					} else if ((text === "/plan" || text === "/build") && result?.ok) {
						const mode = text === "/plan" ? "plan" : "build";
						setSession((prev) => (prev ? { ...prev, mode } : prev));
						addNotice(result.result);
					} else if (result?.result && typeof result.result === "string") {
						addNotice(result.result);
					} else if (result?.result && typeof result.result === "object") {
						// Fallback so an object/array result is never silently swallowed —
						// this exact gap (POST succeeds, nothing visible) is what made
						// /current, /usage, and /sessions look completely broken before.
						addNotice(JSON.stringify(result.result));
					}
				} catch (err) {
					addNotice(err.message, "error");
				}
				return;
			}
			// Show the message immediately — waiting for the POST to resolve before
			// appending it made every send feel like it had a beat of lag, even
			// though the round trip to localhost is fast.
			setSession((prev) =>
				prev ? { ...prev, messages: [...prev.messages, { role: "user", content: text }] } : prev,
			);
			turnStartRef.current.delete(id);
			try {
				await api("POST", `/api/sessions/${id}/chat`, { text });
				// Picks up the auto-derived title after a session's first message
				// (and keeps the sidebar's message counts from drifting stale).
				loadSessions();
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, session, commitSession, loadSessions, selectSession, showToast, toggleDiff, addNotice],
	);

	// Abort
	const abortRun = useCallback(async () => {
		if (!activeId) return;
		try {
			await api("POST", `/api/sessions/${activeId}/abort`);
		} catch {}
		setSession((prev) =>
			prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: "Run aborted" }] } : prev,
		);
	}, [activeId]);

	// Load diff — always the full multi-file diff. Selecting a file in the
	// list (setDiffFile below) just changes which of the already-fetched
	// files is shown; it must never re-fetch a single-file diff, since that
	// response would replace the whole list with just that one entry (and
	// for a file git treats as binary, with none at all — "picking a file
	// makes everything disappear").
	const loadDiff = useCallback(async () => {
		if (!activeId) return;
		try {
			setDiffData(await api("GET", `/api/sessions/${activeId}/diff`));
		} catch {
			setDiffData({ files: [] });
		}
	}, [activeId]);

	// SSE
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop). diffOpen is deliberately not a dependency — see diffOpenRef above; making it one would tear down and reopen the EventSource (full refetch, full message remount) on every diff-panel toggle.
	useEffect(() => {
		if (!activeId) return;
		if (esRef.current) esRef.current.close();

		const es = new EventSource(`${window.location.origin}/api/sessions/${activeId}/events`);
		esRef.current = es;
		setConnected(true);

		es.onopen = () => {
			setConnected(true);
			// Refetch session state on reconnect — the server may have
			// advanced while we were disconnected (e.g. mobile tab was
			// backgrounded). This catches messages missed between the last
			// SSE event we received and the reconnect.
			api("GET", `/api/sessions/${activeId}`)
				.then((data) => {
					if (!data) return;
					const isRunning = data.status === "running";
					setRunning(isRunning);
					wasRunningRef.current = isRunning;
					setSession((prev) => {
						if (!prev) return data;
						// This fires on every connect, not just a true reconnect after a
						// drop — including the very first open right after selectSession
						// already fetched the same page. Swapping in the freshly-parsed
						// `data.messages` there too would hand every message a brand new
						// object identity, and keyForMessage's WeakMap keys off identity —
						// so every message in the DOM would unmount/remount and replay its
						// entrance animation, reading as the whole chat blinking. Nothing
						// was actually missed when the count already matches, so keep the
						// existing message objects and just refresh the rest of the
						// session fields.
						if (prev.id === data.id && (data.messages || []).length === prev.messages.length) {
							return { ...prev, status: data.status, usage: data.usage, updatedAt: data.updatedAt };
						}
						return { ...data, messages: data.messages || [] };
					});
					// Always clear streaming on reconnect — stale blocks from
					// before the disconnect would conflict with new SSE events.
					// If the agent is still running, new streaming events will
					// arrive immediately via SSE and rebuild the live region.
					resetStreamingNow();
					setPendingSteers([]);
					setPendingQueue([]);
					// Scroll to bottom after reconnect — user wants to see
					// the latest messages, not where they were before disconnect.
					autoScrollRef.current = true;
					setAtBottom(true);
				})
				.catch(() => {});
		};

		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				switch (event.type) {
					case "user_message": {
						// Another tab sent a user message — add it to our local state.
						setSession((prev) => {
							if (!prev) return prev;
							// Avoid duplicates if this tab also has the message.
							const msgs = prev.messages;
							const last = msgs[msgs.length - 1];
							if (last && last.role === "user" && last.content === event.message.content) return prev;
							return { ...prev, messages: [...msgs, event.message] };
						});
						break;
					}
					case "status": {
						const isRunning = event.status === "running";
						setRunning(isRunning);
						if (isRunning) setTurnMeta(null);
						setSession((prev) => (prev ? { ...prev, status: event.status } : prev));
						// If the run ended between our initial GET and the SSE
						// connect, we missed the `end` event. The `session_end`
						// event (which follows `status: idle`) carries usage and
						// messageCount — it handles the refetch when counts diverge.
						wasRunningRef.current = isRunning;
						break;
					}
					case "token":
						updateStreaming((prev) => appendTextBlock(prev, "content", event.text));
						break;
					case "thinking":
						updateStreaming((prev) => appendTextBlock(prev, "thinking", event.text));
						break;
					case "tool_start":
						updateStreaming((prev) => [
							...prev,
							{ kind: "tool", call: { id: event.id, name: event.name, args: event.args, status: "running" } },
						]);
						break;
					case "tool_end":
						updateStreaming((prev) =>
							prev.map((b) =>
								b.kind === "tool" && b.call.id === event.id
									? {
											...b,
											call: {
												...b.call,
												status: event.result?.isError ? "error" : "ok",
												// Full, untruncated — same text the model actually saw.
												// A page reload already shows this in full (bridge.ts's
												// toDisplayMessages applies no cap), so a live turn
												// truncating it here just meant the same result read
												// differently depending on when you looked at it.
												result: event.result?.content ?? "",
											},
										}
									: b,
							),
						);
						if (diffOpenRef.current) {
							loadDiff();
							setFsRefreshNonce((n) => n + 1);
						}
						break;
					case "assistant_message": {
						// Keep reasoning, prose, and tool calls as separate ordered blocks
						// (mirrors the TUI's [reasoning]/[agent] rows) instead of flattening
						// them into one string — otherwise a turn's thinking text silently
						// merges into the visible reply with no label or distinction.
						const prevStreaming = takeStreamingNow();
						setSession((prev) => {
							if (!prev) return prev;
							if (prevStreaming.length === 0) return prev;
							const msg = { role: "assistant", blocks: prevStreaming };
							return { ...prev, messages: [...prev.messages, msg] };
						});
						break;
					}
					case "end":
						resetStreamingNow();
						setRunning(false);
						setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
						setPendingSteers([]);
						setPendingQueue([]);
						break;
					case "turn_meta":
						setTurnMeta({ model: event.model, provider: event.provider, totalMs: event.totalMs });
						break;
					case "session_end":
						setSession((prev) => {
							if (!prev) return prev;
							// If the client already has all messages from SSE streaming
							// (normal uninterrupted run), just apply usage — skip the
							// full refetch. Only refetch when message counts diverge
							// (mid-run reconnect where SSE events were missed).
							if (event.messageCount === prev.messages.length) {
								return { ...prev, usage: event.usage };
							}
							// Reconnect recovery: pull the latest page from the server (only
							// that page now, not full history — GET /api/sessions/:id is
							// paginated). Only ever grow the visible thread, never shrink
							// it: if the user has scrolled up and loaded older history via
							// loadOlderMessages, that's more than a single fresh page can
							// possibly contain, and must survive this reconnect merge.
							api("GET", `/api/sessions/${activeId}`)
								.then((d) => {
									if (!d) return;
									setSession((inner) => {
										if (!inner) return inner;
										const serverMsgs = d.messages || [];
										const messages = serverMsgs.length > inner.messages.length ? serverMsgs : inner.messages;
										return { ...inner, messages, usage: d.usage, updatedAt: d.updatedAt };
									});
								})
								.catch(() => {});
							return { ...prev, usage: event.usage };
						});
						break;
					case "error":
						resetStreamingNow();
						setRunning(false);
						setSession((prev) =>
							prev
								? {
										...prev,
										status: "error",
										messages: [
											...prev.messages,
											{ role: "error", content: event.message ?? "Unknown error" },
										],
									}
								: prev,
						);
						break;
					case "session_update":
						setSessions((prev) => prev.map((s) => (s.id === event.session.id ? { ...s, ...event.session } : s)));
						break;
					case "compaction":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "system", content: `Context compacted (${event.messagesCompacted} messages)` },
										],
									}
								: prev,
						);
						break;
					case "doom_loop":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{
												role: "warning",
												content: `Doom loop: ${event.tool} called ${event.attempts} times`,
											},
										],
									}
								: prev,
						);
						break;
					case "steering_injected":
					case "followup_injected": {
						// Promote streaming to history first, then show injected messages.
						{
							const prevStreaming = takeStreamingNow();
							setSession((prev) => {
								if (!prev) return prev;
								const msgs =
									prevStreaming.length > 0
										? [...prev.messages, { role: "assistant", blocks: prevStreaming }]
										: prev.messages;
								const injected = event.messages.map((m) => ({
									role: "user",
									content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
								}));
								return { ...prev, messages: [...msgs, ...injected] };
							});
						}
						if (event.type === "steering_injected") {
							setPendingSteers((p) => p.slice(event.messages.length));
						} else {
							setPendingQueue((p) => p.slice(event.messages.length));
						}
						break;
					}
					case "interrupt_reminder":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "warning", content: "Context restored after interrupt" },
										],
									}
								: prev,
						);
						break;
					case "date_rollover":
						setSession((prev) =>
							prev
								? {
										...prev,
										messages: [
											...prev.messages,
											{ role: "warning", content: `Date rolled over to ${event.date}` },
										],
									}
								: prev,
						);
						break;
					case "open_work_gate":
						addNotice(`Plan steps still open — continuing (attempt ${event.fires})`);
						break;
					case "open_work_gate_exhausted":
						addNotice("Plan steps still open — max retries reached, ending turn");
						break;
					case "session_closed":
						// Reached if this session was closed by another client/tab —
						// a self-initiated close clears the flag instead of toasting.
						if (selfClosingRef.current === activeId) {
							selfClosingRef.current = null;
						} else {
							showToast("This session was closed", "error");
						}
						break;
				}
			} catch {}
		};

		// The browser's native EventSource retries on its own for a connection
		// that drops after connecting fine — we just reflect that outage in the
		// UI until a fresh "open" fires. But readyState === CLOSED means it's
		// given up for good (the initial/reconnect request itself came back
		// non-2xx, e.g. this session id no longer exists after a backend
		// restart) and needs our own recovery loop instead.
		es.onerror = () => {
			setConnected(false);
			if (es.readyState === EventSource.CLOSED) {
				setSession((prev) =>
					prev
						? { ...prev, messages: [...prev.messages, { role: "warning", content: "Connection terminated" }] }
						: prev,
				);
				startReconnectLoop();
			}
		};

		return () => {
			es.close();
		};
	}, [activeId, reconnectNonce, startReconnectLoop, addNotice, loadDiff, showToast]);

	// Sidebar-wide SSE — independent of activeId, so message-count badges for
	// other/background threads update live instead of only on page reload.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop), same as the per-session SSE effect above.
	useEffect(() => {
		const es = new EventSource(`${window.location.origin}/api/sessions/events`);
		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				if (event.type === "session_update") {
					setSessions((prev) => prev.map((s) => (s.id === event.session.id ? { ...s, ...event.session } : s)));
				}
			} catch {}
		};
		return () => es.close();
	}, [reconnectNonce]);

	// Auto-scroll
	// biome-ignore lint/correctness/useExhaustiveDependencies: session?.messages/streaming aren't read in the body — they're the triggers to re-scroll whenever new content arrives, read indirectly via the DOM refs instead.
	useEffect(() => {
		if (autoScrollRef.current && messagesRef.current) {
			requestAnimationFrame(() => {
				messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
			});
		}
	}, [session?.messages, streaming]);

	const scrollToBottom = useCallback(() => {
		autoScrollRef.current = true;
		setAtBottom(true);
		if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
	}, []);

	// Fetches the next older batch (GET /api/sessions/:id/history) and
	// prepends it — turn-boundary safe server-side (getHistoryPage), so this
	// never splices in half a tool_calls/tool pair. Guarded against overlap
	// with a concurrent selectSession by checking prev.id === activeId in the
	// setSession updater, since the fetch is async and the user could switch
	// threads while it's in flight.
	const loadOlderMessages = useCallback(async () => {
		if (loadingOlderRef.current || !session?.hasMoreHistory || session.oldestSeq == null) return;
		const forId = activeId;
		loadingOlderRef.current = true;
		try {
			const res = await api("GET", `/api/sessions/${forId}/history?before=${session.oldestSeq}`);
			const cached = olderPagesCacheRef.current.get(forId);
			if (cached) {
				cached.messages = [...res.messages, ...cached.messages];
				cached.oldestSeq = res.oldestSeq;
				cached.hasMore = res.hasMoreHistory;
			}
			if (messagesRef.current) pendingScrollRestoreRef.current = messagesRef.current.scrollHeight;
			setSession((prev) =>
				prev && prev.id === forId
					? {
							...prev,
							messages: [...res.messages, ...prev.messages],
							oldestSeq: res.oldestSeq,
							hasMoreHistory: res.hasMoreHistory,
						}
					: prev,
			);
		} catch {
			// Best-effort — hasMoreHistory stays as-is, the next scroll-up retries.
		} finally {
			loadingOlderRef.current = false;
		}
	}, [session, activeId]);

	// Keeps the visible content stable when older messages get prepended
	// above it — without this the browser's default "preserve scrollTop"
	// behavior would make the view jump downward by the height of what just
	// got inserted, reading as the thread suddenly scrolling on its own.
	// biome-ignore lint/correctness/useExhaustiveDependencies: session?.messages isn't read in the body — it's the trigger, so this re-runs exactly when loadOlderMessages just prepended content (the only place pendingScrollRestoreRef gets set).
	useEffect(() => {
		const delta = pendingScrollRestoreRef.current;
		if (delta == null || !messagesRef.current) return;
		const el = messagesRef.current;
		el.scrollTop += el.scrollHeight - delta;
		pendingScrollRestoreRef.current = null;
	}, [session?.messages]);

	// Scroll detection
	const handleScroll = useCallback(() => {
		const el = messagesRef.current;
		if (!el) return;
		const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
		autoScrollRef.current = bottom;
		setAtBottom(bottom);
		// Near the top — fetch the next older batch. 400px gives it a head
		// start before the user actually hits the edge, so it doesn't feel
		// like a hard stop-and-wait while scrolling fast.
		if (el.scrollTop < 400) loadOlderMessages();
	}, [loadOlderMessages]);

	// Toggle diff — reset the selected file so switching sessions (or
	// reopening) doesn't leave a stale selection that no longer matches any
	// file in the freshly loaded list.
	useEffect(() => {
		if (diffOpen && activeId) {
			setDiffFile(null);
			loadDiff();
		}
	}, [diffOpen, activeId, loadDiff]);

	// Init
	// biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — initClientState's own identity can change across renders, and re-running the full bootstrap on that would fight startReconnectLoop's manual retries.
	useEffect(() => {
		initClientState().finally(() => setBootstrapping(false));
	}, []);

	// Reconnect on visibility change — when the tab comes back to
	// foreground after being backgrounded, the SSE connection may have
	// dropped silently. Force a reconnect to sync state.
	useEffect(() => {
		const onVisibilityChange = () => {
			if (document.visibilityState === "visible" && !connected) {
				startReconnectLoop();
			}
		};
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => document.removeEventListener("visibilitychange", onVisibilityChange);
	}, [connected, startReconnectLoop]);

	// Back/forward through browser history moves between sessions too, since
	// each one now has its own URL — don't push a new entry for this or
	// clicking back would just move forward again.
	useEffect(() => {
		const onPopState = () => {
			const id = sessionIdFromUrl();
			if (id) selectSession(id, { push: false });
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [selectSession]);

	// Global hotkeys
	useEffect(() => {
		const onKey = (e) => {
			if (e.key === "Escape" && hotkeysOpen) {
				setHotkeysOpen(false);
				return;
			}
			if (e.key === "Escape" && dirPickerOpen) {
				setDirPickerOpen(false);
				return;
			}

			// Ctrl/Cmd combos. Plain Ctrl+D/N/L are reserved by Chrome/Firefox
			// (bookmark, new window, focus address bar) and never reach page
			// JS at all, so those actions use Ctrl+Shift instead.
			const mod = e.ctrlKey || e.metaKey;
			if (mod && !e.shiftKey && e.key === "b") {
				e.preventDefault();
				setSidebarCollapsed((v) => !v);
				return;
			}
			if (mod && e.shiftKey && e.key === "D") {
				e.preventDefault();
				toggleDiff();
				return;
			}
			if (mod && e.shiftKey && e.key === "N") {
				e.preventDefault();
				const p = personas.find((x) => x.name === "coding") ?? personas[0];
				if (p) startDraft(p.name, cwd);
				return;
			}
			if (mod && e.shiftKey && e.key === "L") {
				e.preventDefault();
				if (activeId) submitMessage("/clear");
				return;
			}
			if (mod && !e.shiftKey && e.key === "/") {
				e.preventDefault();
				setHotkeysOpen((v) => !v);
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [hotkeysOpen, dirPickerOpen, activeId, personas, cwd, startDraft, submitMessage, toggleDiff]);

	const messages = session?.messages?.filter((m) => m.role !== "system") || [];
	// Each thread can run under a different persona — shown right above the
	// composer (not the header, which is shared chrome) so it's always clear
	// which role a message is about to go to, especially when switching
	// between sessions that don't share one.
	const activePersonaLabel = session
		? (personas.find((p) => p.name === session.persona)?.label ?? session.persona)
		: null;
	// The backend lists every persisted session (see bridge.ts), but a
	// closed one should stay out of view in this browser until re-opened by
	// URL/history — see dismiss()/undismiss() above.
	const visibleSessions = sessions.filter((s) => !dismissedIds.has(s.id));

	// Which meaning of the toggle applies depends on viewport (drawer on
	// mobile, collapsible column on desktop) — read at render time, same as
	// toggleSidebar's own check, so the chevron always matches the layout
	// it's about to flip.
	const sidebarVisible = typeof window !== "undefined" && window.innerWidth <= 768 ? sidebarOpen : !sidebarCollapsed;

	const appStyle = {};
	if (sidebarCollapsed) appStyle["--sidebar-col"] = "0px";
	if (diffOpen && diffWidth) appStyle["--diff-w"] = `${diffWidth}px`;

	// Hotkeys modal — rendered via dangerouslySetInnerHTML to avoid htm/h() issues.
	const hotkeysModalRef = useModalFocusTrap(hotkeysOpen);
	const hotkeysModal =
		hotkeysOpen &&
		html`
		<div class="modal-backdrop" onClick=${() => setHotkeysOpen(false)}>
			<div class="modal modal-hotkeys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabIndex="-1" ref=${hotkeysModalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Keyboard shortcuts</span>
					<button class="modal-close" onClick=${() => setHotkeysOpen(false)} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="hotkeys-list" dangerouslySetInnerHTML=${{ __html: hotkeysHtml }}></div>
			</div>
		</div>
	`;

	const closeConfirm = (result) => {
		confirmState?.resolve(result);
		setConfirmState(null);
	};
	const confirmModalRef = useModalFocusTrap(!!confirmState);
	const confirmModal =
		confirmState &&
		html`
		<div class="modal-backdrop" onClick=${() => closeConfirm(false)}>
			<div class="modal modal-confirm" role="alertdialog" aria-modal="true" aria-label="Confirm" tabIndex="-1" ref=${confirmModalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-confirm-body">${confirmState.message}</div>
				<div class="modal-footer">
					<button class="modal-btn" onClick=${() => closeConfirm(false)}>Cancel</button>
					<button class="modal-btn modal-btn-danger" onClick=${() => closeConfirm(true)}>Confirm</button>
				</div>
			</div>
		</div>
	`;

	return html`
		<div class="app${diffOpen ? " with-diff" : ""}${sidebarCollapsed ? " sidebar-collapsed" : ""}" style=${appStyle}>
			<!-- Toasts -->
			<div class="toast-stack">
				${toasts.map(
					(t) => html`
					<div key=${t.id} class="toast toast-${t.type}">${t.text}</div>
				`,
				)}
			</div>

			<!-- Header -->
			<header class="header">
				<button class="menu-toggle${sidebarVisible ? " active" : " collapsed"}" onClick=${toggleSidebar} aria-label=${sidebarVisible ? "Collapse sessions" : "Expand sessions"}>
					<${icons.chevronRight} class="chevron-icon" />
				</button>
				<span class="header-logo">
					<span class="status-dot ${backendUp ? (connected ? "connected" : "reconnecting") : "offline"}" />
				</span>
				<div class="header-right">
					${activeId && html`<${StatusPopover} activeId=${activeId} running=${running} />`}
					<button class="menu-toggle" onClick=${() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
						<${icons.settings} />
					</button>
					<button class="menu-toggle hotkeys-toggle" onClick=${() => setHotkeysOpen(true)} aria-label="Keyboard shortcuts" title=${`Shortcuts (${modKey}/)`}>
						<${icons.help} />
					</button>
					<button class="menu-toggle diff-toggle${diffOpen ? " active" : ""}" onClick=${toggleDiff} aria-label=${diffOpen ? "Close diff panel" : "Open diff panel"} title="Diff">
						<${icons.chevronLeft} class="chevron-icon" />
					</button>
				</div>
			</header>

			<!-- Sidebar backdrop (mobile) -->
			<div class="sidebar-backdrop${sidebarOpen ? " visible" : ""}" onClick=${() => setSidebarOpen(false)} />

			<${Sidebar}
				sessions=${visibleSessions}
				activeId=${activeId}
				personas=${personas}
				cwd=${cwd}
				defaultCwd=${defaultCwd}
				quickSessionPersona=${quickSessionPersona}
				onSelectSession=${selectSession}
				onCreateSession=${startDraft}
				onDeleteSession=${deleteSessionPermanently}
				onOpenDirPicker=${() => setDirPickerOpen(true)}
				onSetCwd=${setSelectedCwd}
				onRenameSession=${renameSession}
				onPinSession=${pinSession}
				onShareSession=${setShareModalSession}
				open=${sidebarOpen}
				confirm=${requestConfirm}
			/>

			<${ShareModal} session=${shareModalSession} onClose=${() => setShareModalSession(null)} />

			<!-- Directory picker — rendered here (not inside Sidebar) because
			     .sidebar gets a CSS transform for its mobile drawer slide, and a
			     transformed ancestor becomes the containing block for any
			     position:fixed descendant, trapping the modal inside the
			     sidebar's own box on narrow screens instead of centering over the
			     whole viewport. -->
			${
				dirPickerOpen &&
				html`
				<${DirectoryBrowser}
					initialPath=${cwd}
					onPick=${(p) => {
						setSelectedCwd(p);
						setDirPickerOpen(false);
					}}
					onClose=${() => setDirPickerOpen(false)}
					confirm=${requestConfirm}
				/>
			`
			}

			${hotkeysModal}

			${
				settingsOpen &&
				html`
				<${SettingsModal}
					activeId=${activeId}
					personas=${personas}
					onQuickSessionPersonaChange=${setQuickSessionPersona}
					themes=${themes}
					currentThemeId=${currentThemeId}
					onApplyTheme=${applyTheme}
					onThemeChange=${setCurrentThemeId}
					currentFontId=${currentFontId}
					currentFontScale=${currentFontScale}
					onPickFont=${(id) => {
						applyFont(id);
						setCurrentFontId(id);
					}}
					onPickScale=${(scale) => {
						applyFontScale(scale);
						setCurrentFontScale(scale);
					}}
					onClose=${() => setSettingsOpen(false)}
					confirm=${requestConfirm}
					onReload=${() => refreshCommands(activeId)}
				/>
			`
			}

			<!-- Rendered after SettingsModal (not before) so its backdrop paints
			     on top and actually receives clicks — the confirm prompt is only
			     ever triggered from inside a settings tab, so it must outrank it
			     in DOM/paint order. -->
			${confirmModal}

			<!-- Chat area -->
			<main class="chat-area">
				<div class="messages" ref=${messagesRef} onScroll=${handleScroll}>
					${
						bootstrapping &&
						!session &&
						html`
						<div class="empty-state">
							<div class="loading-spinner" />
						</div>
					`
					}
					${
						!bootstrapping &&
						messages.length === 0 &&
						streaming.length === 0 &&
						html`
						<div class="empty-state">
							<${CastLogo} class="empty-state-banner" />
							<p class="empty-state-title">Ready when you are</p>
							<p class="empty-state-hint">Send a message, or type <code>/</code> to see what this agent can do.</p>
						</div>
					`
					}
					${messages.map((msg) => html`<${Message} key=${keyForMessage(msg)} msg=${msg} />`)}
					<${StreamingBlocks} blocks=${streaming} />
					${
						!running &&
						turnMeta &&
						html`
						<div class="turn-meta">${turnMeta.provider} · ${turnMeta.model} · ${(turnMeta.totalMs / 1000).toFixed(1)}s</div>
					`
					}
				</div>
				${
					!atBottom &&
					html`
					<button class="scroll-bottom-btn" onClick=${scrollToBottom} aria-label="Scroll to latest">
						<${icons.chevronDown} />
					</button>
				`
				}
				${
					activePersonaLabel &&
					html`
					<div class="composer-role">
						<div class="composer-role-left">
							${activePersonaLabel}
							${session?.mode && session.mode !== "build" && html`<span class="composer-role-mode">${session.mode}</span>`}
						</div>
						<${ElapsedTimer} running=${running} activeId=${activeId} connected=${connected} turnStartRef=${turnStartRef} />
					</div>
				`
				}
				${
					(pendingSteers.length > 0 || pendingQueue.length > 0) &&
					html`
					<div class="pending-items">
						${pendingSteers.map(
							(text, i) => html`
							<div key=${`steer-${i}`} class="pending-item pending-steer">
								<span class="pending-label">Steer${pendingSteers.length > 1 ? ` (${i + 1}/${pendingSteers.length})` : ""}:</span> ${text}
							</div>
						`,
						)}
						${pendingQueue.map(
							(text, i) => html`
							<div key=${`queue-${i}`} class="pending-item pending-queue">
								<span class="pending-label">Queued${pendingQueue.length > 1 ? ` (${i + 1}/${pendingQueue.length})` : ""}:</span> ${text}
							</div>
						`,
						)}
					</div>
				`
				}
				<${Composer} running=${running} ready=${!!session} commands=${commands} personas=${personas} onSubmit=${submitMessage} onAbort=${abortRun} />
			</main>

			<!-- Diff — a wide right sidebar alongside the chat on desktop, a
			     full-screen overlay on mobile (see the max-width:768px rules).
			     Always mounted (like Sidebar) so the open/close is a pure CSS
			     class/transform transition instead of a mount with no "from"
			     state to animate out of — genuinely always, not just once
			     activeId exists: a draft session (nothing sent yet) used to
			     leave this unmounted entirely while still reserving its grid
			     column on open, which read as content shifting into an empty
			     void with no panel there to show for it. -->
			<${DiffPanel} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onResizeStart=${startDiffResize} open=${diffOpen} activeId=${activeId} tab=${diffTab} onTabChange=${setDiffTab} confirm=${requestConfirm} fsRefreshNonce=${fsRefreshNonce} bootstrapping=${bootstrapping} />
		</div>
	`;
}

// Code-block copy buttons — delegated on document since they live inside
// dangerouslySetInnerHTML markdown output, not real preact elements, so they
// can't take an onClick prop directly.
document.addEventListener("click", async (e) => {
	const btn = e.target.closest?.(".code-copy-btn");
	if (!btn) return;
	const code = btn.closest("pre")?.querySelector("code");
	if (!code) return;
	const text = code.textContent ?? "";
	try {
		if (navigator.clipboard) {
			await navigator.clipboard.writeText(text);
		} else {
			// HTTP fallback — Clipboard API unavailable outside secure contexts.
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.cssText = "position:fixed;opacity:0";
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			document.body.removeChild(ta);
		}
		btn.classList.add("copied");
		btn.innerHTML = CODE_COPY_ICON_CHECK_SVG;
		clearTimeout(btn._copyRevertTimer);
		btn._copyRevertTimer = setTimeout(() => {
			btn.classList.remove("copied");
			btn.innerHTML = CODE_COPY_ICON_SVG;
		}, 1200);
	} catch {
		// Best-effort — no toast wired up outside the App component's addNotice.
	}
});

// ── Shared (read-only, unauthenticated) thread view ─────────────────
// Served at /shared/<token> — see server.ts's isPublicShareRoute. No
// composer, no sidebar, no settings: this is the one page in the app a
// visitor can open with no cast credentials at all, so it only ever reads
// data through /api/shared/<token>, never the authenticated /api/sessions/*
// routes.
function SharedThreadView({ token }) {
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);

	useEffect(() => {
		api("GET", `/api/shared/${encodeURIComponent(token)}`)
			.then((d) => {
				if (!d) return;
				setData(d);
			})
			.catch((err) => setError(err.message));
	}, [token]);

	if (error) {
		return html`
			<div class="shared-view shared-view-error">
				<${CastLogo} class="empty-state-banner" />
				<p class="empty-state-title">Link not found</p>
				<p class="empty-state-hint">This shared link is invalid or was revoked.</p>
			</div>
		`;
	}
	if (!data) {
		return html`
			<div class="shared-view">
				<div class="loading-spinner" />
			</div>
		`;
	}

	return html`
		<div class="shared-view">
			<div class="shared-view-header">
				<${CastLogo} class="shared-view-logo" />
				<div class="shared-view-meta">
					<div class="shared-view-title">${data.title || "Shared thread"}</div>
					<div class="shared-view-sub">${data.persona} · ${data.model} · read-only</div>
				</div>
			</div>
			<div class="shared-view-messages">
				${data.messages.map((msg, i) => html`<${Message} key=${i} msg=${msg} />`)}
			</div>
		</div>
	`;
}

// ── Mount ────────────────────────────────────────────────────────────
const sharedToken = window.location.pathname.startsWith("/shared/")
	? decodeURIComponent(window.location.pathname.slice("/shared/".length))
	: null;
render(
	sharedToken ? html`<${SharedThreadView} token=${sharedToken} />` : html`<${App} />`,
	document.getElementById("app"),
);
