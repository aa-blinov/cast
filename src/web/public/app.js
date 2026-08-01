/**
 * cast web — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { CastLogo } from "./cast-logo.js";
import { DirectoryBrowser } from "./directory-browser.js";
import { ElapsedTimer } from "./elapsed-timer.js";
import { FilePreviewModal } from "./file-preview.js";
import { hotkeysHtml, modKey } from "./hotkeys.js";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { PlanDecisionCard, QuestionCard } from "./plan-cards.js";
import { collapseMidWordBoundaries, mergeMidWordBoundary } from "./reasoning-split.js";
import { ShareModal } from "./share-modal.js";
import {
	SANDBOX_CWD,
	groupSessionsByDirectory,
	isSandboxSessionCwd,
	sessionDirectoryName,
	sortSessionsByActivity,
} from "./sidebar-utils.js";
import { SidebarSessionItem } from "./sidebar-session-item.js";
import { blocksFromAssistantCompletion, reduceStreamEvent } from "./stream-blocks.js";

const html = htm.bind(h);

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
	if (colors.bg) root.setProperty("--bg", colors.bg);
	if (colors.bgSurface) root.setProperty("--bg-surface", colors.bgSurface);
	if (colors.bgRaised) root.setProperty("--bg-raised", colors.bgRaised);
	if (colors.bgHover) root.setProperty("--bg-hover", colors.bgHover);
	if (colors.border) root.setProperty("--border", colors.border);
	if (colors.borderActive) root.setProperty("--border-active", colors.borderActive);
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

// ── Custom tooltips ──────────────────────────────────────────────────
// Replaces native title tooltips (slow, unstyled) with themed bubbles.
// On any element with a title attribute, copies it to data-tooltip and
// suppresses the native tooltip by clearing title on mouseenter (restored
// on mouseleave for accessibility). Runs once + observes DOM for new nodes.

// Hover-intent: a tooltip should only appear after the pointer has
// been still on the element long enough to suggest a real read, not
// on every accidental fly-by while moving the cursor across the
// screen. A 500ms delay matches the de-facto OS standard (also
// what GitHub, GitLab, Linear, VSCode use). The mousemove cancel
// is the second half: it suppresses the popup if the user is
// still actively moving the cursor even after the delay, which
// is what makes tooltips feel "snappy" instead of "triggered by
// whatever I last passed over". Keyboard focus (tab) skips the
// timer entirely — a focused element is an intentional navigation
// target, not a fly-by.
//
// Returns {hide} so callers (e.g. App opening a modal over a still-
// hovered button) can dismiss any in-flight tooltip without waiting
// for the next mousemove. Without that, hovering the Reload button
// in the settings header and then opening the modal would leave
// the "Reload resources" bubble floating on top of the dialog.
function initTooltips() {
	const tip = document.createElement("div");
	tip.className = "cast-tooltip";
	tip.style.cssText = "position:fixed;pointer-events:none;opacity:0;z-index:9999;transition:opacity .1s ease;";
	document.body.appendChild(tip);
	// Minimum gap between the tooltip bubble and the viewport edge. Used
	// when clamping x so the bubble doesn't bleed off-screen on narrow
	// viewports (a long status bar tooltip on a 600px-wide window is the
	// usual trigger). Was missing entirely when the tooltip code was
	// refactored into a shared module — every setup() call hit
	// "ReferenceError: PAD is not defined" and the whole observer was
	// torn down, which is why no native OR themed tooltips rendered at all
	// until the user reloaded the page and the inline title attr briefly
	// survived the observer's failure.
	const PAD = 8;

	function show(el) {
		const text = el.getAttribute("data-tooltip") || "";
		tip.textContent = text;
		// Force layout so we can measure the tooltip width
		tip.style.opacity = "0";
		tip.style.transition = "none";
		// `tw` (tooltip width) measured below in the clamp step.
		const r = el.getBoundingClientRect();
		const above = r.top > 60;
		let x = r.left + r.width / 2;
		const y = above ? r.top - 8 : r.bottom + 8;
		const tw = tip.getBoundingClientRect().width;
		const half = tw / 2;
		if (x - half < PAD) x = half + PAD;
		else if (x + half > window.innerWidth - PAD) x = window.innerWidth - half - PAD;

		tip.style.left = `${x}px`;
		tip.style.top = `${y}px`;
		tip.style.transform = `translate(-50%, ${above ? "-100%" : "0"})`;
		tip.style.opacity = "1";
	}
	function hide(el) {
		tip.style.opacity = "0";
		el.setAttribute("title", el.getAttribute("data-tooltip") || "");
	}
	const HOVER_DELAY_MS = 500;
	const pendingShows = new WeakMap(); // el → timer id

	function cancelPending(el) {
		const t = pendingShows.get(el);
		if (t !== undefined) {
			clearTimeout(t);
			pendingShows.delete(el);
		}
	}

	function scheduleShow(el) {
		cancelPending(el);
		const t = setTimeout(() => {
			pendingShows.delete(el);
			show(el);
		}, HOVER_DELAY_MS);
		pendingShows.set(el, t);
	}

	function setup(el) {
		if (!el.hasAttribute("title") || el.hasAttribute("data-tooltip")) return;
		el.setAttribute("data-tooltip", el.getAttribute("title"));
		el.addEventListener("mouseenter", () => scheduleShow(el));
		// Strip the native title attribute as soon as the cursor
		// enters the element — before the browser's own ~500ms
		// hover-delay tooltip can fire. Without this, the native
		// OS/Chrome bubble and our themed one appear in lockstep
		// (both at the same ~500ms mark) and stack on top of each
		// other. Removing title in the show() callback (the
		// previous wiring) was too late — by the time the timer
		// fired, the browser had already grabbed the title text
		// for its own bubble.
		el.addEventListener("mouseenter", () => el.removeAttribute("title"));
		el.addEventListener("mouseleave", () => {
			cancelPending(el);
			hide(el);
		});
		// Note: no active-motion cancel on this element. Every real
		// cursor micro-movement (mouse jitter, breathing) would
		// fire mousemove and cancel the pending show, so the
		// bubble would never appear. The 500ms delay alone is
		// enough to filter fly-bys — a user has to hold the
		// anything, which is the hover-intent.
		el.addEventListener("focus", () => {
			cancelPending(el);
			show(el);
		});
		el.addEventListener("blur", () => hide(el));
	}
	document.querySelectorAll("[title]").forEach(setup);
	new MutationObserver((mutations) => {
		for (const m of mutations) {
			for (const node of m.addedNodes) {
				if (node.nodeType === 1) {
					if (node.hasAttribute?.("title")) setup(node);
					node.querySelectorAll?.("[title]").forEach(setup);
				}
			}
		}
	}).observe(document.body, { childList: true, subtree: true });

	return {
		// Dismiss any in-flight tooltip immediately. Callers use this
		// when they open a modal/dropdown over a still-hovered button,
		// so the bubble doesn't outlive the thing that triggered it.
		hide() {
			tip.style.opacity = "0";
		},
	};
}

// ── Font ─────────────────────────────────────────────────────────────
// A compact gallery of proven coding/UI fonts. Their regular faces are served
// locally so the picker always shows genuine samples without a network-driven
// reflow; extra weights load only after a user selects a font.
// index.html's inline bootstrap script keeps its own copy of each family
// string (it runs before this module does, same reasoning as applyTheme's
// cache) — update both if a family or id here changes.
// Alphabetical by label within each group — same convention as SETTINGS_TABS
// and SettingsTheme's swatch grid, so the picker order isn't just "however
// they were added". `mono: true` fonts apply to both --font and --font-mono
// (see applyFont) — a sans pick only ever touches --font, since --font-mono
// backs code blocks, tool-arg dumps, tables, and the ASCII banner, all of
// which depend on real monospace character alignment to not look broken.
// Google family IDs below provide only the heavier weights after selection.
const FONT_OPTIONS = [
	// ── Monospace ──
	{
		id: "fira-code",
		label: "Fira Code",
		mono: true,
		family: "'Fira Code', 'JetBrains Mono', monospace",
		google: "Fira+Code:wght@500;600;700",
	},
	{
		id: "ibm-plex-mono",
		label: "IBM Plex Mono",
		mono: true,
		family: "'IBM Plex Mono', monospace",
		google: "IBM+Plex+Mono:wght@500;600;700",
	},
	{
		id: "jetbrains-mono",
		label: "JetBrains Mono",
		mono: true,
		family: "'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace",
		google: "JetBrains+Mono:wght@500;600;700",
	},
	// ── Sans-serif (--font only; --font-mono stays whatever mono font is active) ──
	{
		id: "ibm-plex-sans",
		label: "IBM Plex Sans",
		mono: false,
		family: "'IBM Plex Sans', sans-serif",
		google: "IBM+Plex+Sans:wght@500;600;700",
	},
	{ id: "inter", label: "Inter", mono: false, family: "'Inter', sans-serif", google: "Inter:wght@500;600;700" },
	{
		id: "work-sans",
		label: "Work Sans",
		mono: false,
		family: "'Work Sans', sans-serif",
		google: "Work+Sans:wght@500;600;700",
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

// Tool providers often return JSON text rather than a structured object. A
// parsed value restores Unicode escapes before it reaches Preact's text node;
// otherwise a Playwright result such as `{"text":"\\u041f"}` shows its
// transport encoding to the user instead of the actual character.
function formatToolResult(name, result) {
	if (name === "todo_write") {
		try {
			return formatValue(JSON.parse(result), "");
		} catch {
			return result;
		}
	}
	if (!/\\u[\dA-Fa-f]{4}/.test(result)) return result;
	let value = result;
	for (let depth = 0; depth < 2; depth++) {
		try {
			const parsed = JSON.parse(value);
			if (typeof parsed !== "string") return formatValue(parsed, "");
			value = parsed;
		} catch {
			return value;
		}
	}
	return value;
}

function ToolCard({ call }) {
	// The header always shows the request (name + full input params) and a
	// status dot, so the terminal-like default view stays a quick "what's it
	// doing / is it still alive" scan. The result body — including any image
	// a `read` on a photo returned — is collapsed by default and rendered
	// lazily on first expand — unlike the TUI, the web UI has room (and a
	// scrollable DOM) to show it on demand without cluttering the log.
	const [open, setOpen] = useState(false);
	const [previewSrc, setPreviewSrc] = useState(null);
	const statusClass = call.status || "running";
	const args = formatArgsFull(call.args);
	const mcp = isMcpTool(call.name);
	const hasResult = Boolean(call.result) || Boolean(call.images?.length);
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
				call.images?.length &&
				html`
				<div class="message-content message-images tool-card-images">
					${call.images.map(
						(src, i) =>
							html`<img key=${i} src=${src} class="message-image" onClick=${() => setPreviewSrc(src)} />`,
					)}
				</div>
			`
			}
			${
				previewSrc &&
				html`<${FilePreviewModal}
					path="image.jpg"
					downloadHref=${previewSrc}
					previewHref=${previewSrc}
					onClose=${() => setPreviewSrc(null)}
				/>`
			}
			${
				open &&
				call.result &&
				(mcp
					? // MCP servers commonly format their own results as markdown (headers,
						// code fences, tables) — worth actually rendering, unlike a built-in
						// tool's result, which has a fixed non-markdown shape (e.g. read's
						// hashline anchors) that markdown rendering would corrupt.
						html`<div class="tool-card-result" dangerouslySetInnerHTML=${{ __html: renderMarkdown(formatToolResult(call.name, call.result)) }}></div>`
					: html`<div class="tool-card-result">${formatToolResult(call.name, call.result)}</div>`)
			}
		</div>
	`;
}
// Small gray "provider · model · Ns" line under a finished agent reply —
// per-message (persisted server-side, see core/session.ts's SessionState.turnMeta)
// rather than a single page-level "last turn" value, so every past reply in
// a thread shows its own footer on reload, not just whichever one happened
// to be most recent when the page loaded.
function TurnMetaLine({ turnMeta }) {
	if (!turnMeta || turnMeta.totalMs == null) return null;
	return html`<div class="turn-meta">${turnMeta.provider} · ${turnMeta.model} · ${(turnMeta.totalMs / 1000).toFixed(1)}s</div>`;
}

function Message({ msg }) {
	const role = msg.role || "assistant";
	// Only used by the legacy floating image-result branch below (pre
	// castToolCallId sessions) — declared unconditionally so hook order stays
	// stable across renders regardless of which branch a given msg takes.
	const [previewSrc, setPreviewSrc] = useState(null);
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
		// When the parser splits the model output mid-word (e.g. </think>
		// landed inside "Сейчас" so the reasoning ends "...Сей" and the
		// content starts "час уточню..."), glue the boundary back together
		// before rendering. See reasoning-split.js's mergeMidWordBoundary.
		const collapsed = collapseMidWordBoundaries(msg.blocks);
		// Settled-message blocks render without the `message-entering`
		// class — the entrance rise keyframe is reserved for blocks
		// that appear *during* a stream (a new reasoning chunk, a new
		// tool card, etc.) where it visually marks "the model just
		// emitted this". On settled messages the rise was the source of
		// the "blink on submit" / "blink on final chunk" flicker: the
		// user message mounted on send and the assistant message
		// remounted when the stream settled both ran the 150ms fade-up,
		// which read as a UI stutter on a quiet chat. The settled
		// Message subtree is keyed by msg object identity, so a
		// re-render of the same history row reuses the same DOM and
		// wouldn't replay the animation anyway — but the *first* mount
		// of every new settled msg (the user just clicked send, the
		// assistant just finished) was the visible one. Now silent.
		return html`
			<div class="message-group">
				${collapsed.map((block, i) => html`<${BlockView} key=${block.kind === "tool" ? block.call.id : i} block=${block} />`)}
					<${TurnMetaLine} turnMeta=${msg.turnMeta} />
			</div>
		`;
	}

	// content is `null` for a tool-call-only turn (see core/loop.ts) — treat
	// that as "no text", not the literal string "null" JSON.stringify gives it.
	let content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);

	if (role === "assistant") {
		let visibleThinking = msg.thinking;
		// The parser may have split the model's output mid-word (e.g.
		// </think> landed inside "Сейчас" — observed on MiniMax-M3) so
		// msg.thinking ends "...Сей" and content starts "час уточню...".
		// Glide the boundary back together so the user sees the model-intended
		// continuous word, not two halves separated across blocks.
		if (visibleThinking && content) {
			const merged = mergeMidWordBoundary(visibleThinking, content);
			if (merged.thinkingText !== visibleThinking) {
				visibleThinking = merged.thinkingText;
				content = merged.contentText;
			}
		}
		return html`
			<div class="message-group">
				${
					visibleThinking &&
					html`
					<div class="message message-reasoning">
						<div class="message-label">reasoning</div>
						<div class="message-content">${visibleThinking}</div>
					</div>
				`
				}
				${
					content &&
					html`
					<div class="message message-assistant">
						<div class="message-label">agent</div>
						<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }} />
					</div>
				`
				}
				${msg.toolCalls?.map((tc) => html`<${ToolCard} key=${tc.id} call=${tc} />`)}
					<${TurnMetaLine} turnMeta=${msg.turnMeta} />
			</div>
		`;
	}

	if (msg.images?.length) {
		// Array `content` on a role:"user" message is either a real send with
		// an attached photo (a text part is always present, even empty — see
		// bridge.ts's buildUserContent, and toDisplayMessages preserves that
		// as content:"" vs content:null) or a `read` on an image file: wire
		// role is "user" too (only role that can carry image_url content per
		// the OpenAI-compatible API — see loop.ts), but the person didn't
		// send that one, the read tool did. Only the latter case is reached
		// for sessions saved before castToolCallId existed — newer ones show
		// inside their ToolCard instead.
		const isRealSend = msg.content !== null;
		return html`
		<div class="message ${isRealSend ? "message-user" : "message-image-result"}">
			<div class="message-label">${isRealSend ? "you" : "image (read)"}</div>
			${content && html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: escapeHtml(content) }} />`}
			<div class="message-content message-images">
				${msg.images.map(
					(src, i) => html`<img key=${i} src=${src} class="message-image" onClick=${() => setPreviewSrc(src)} />`,
				)}
			</div>
			${
				previewSrc &&
				html`<${FilePreviewModal}
					path="image.jpg"
					downloadHref=${previewSrc}
					previewHref=${previewSrc}
					onClose=${() => setPreviewSrc(null)}
				/>`
			}
		</div>
	`;
	}

	return html`
	<div class="message message-${role}">
		<div class="message-label">${labelMap[role] ?? role}</div>
		<div class="message-content" dangerouslySetInnerHTML=${{ __html: role === "user" ? escapeHtml(content) : renderMarkdown(content) }} />
		${
			msg.attachments?.length > 0 &&
			html`
			<div class="message-attachments">
				${msg.attachments.map(
					(a) => html`
					<span key=${a.name} class="message-attachment-chip" title=${a.path}>
						<${icons.docFile} /><span class="message-attachment-name">${a.name}</span>
					</span>
				`,
				)}
			</div>
			`
		}
	</div>
`;
}

// Renders a streaming text block (content or reasoning) into a single,
// stable text node. The previous implementation used
// `dangerouslySetInnerHTML` with the full `renderMarkdown(text)` result on
// every RAF commit, which destroyed the entire DOM subtree under
// `.message-content` and rebuilt it from the new HTML string — for a 4KB
// reply streaming over 20s, that's hundreds of full subtree teardowns
// while the user is just trying to read the words appearing. By
// contrast, mutating `node.data` on a single text node is O(1) and
// leaves the surrounding DOM, including any markdown formatting that
// has already been laid out, completely untouched. The trade-off is
// that the block shows as raw text (so partial `**bold**` boundaries
// are visible as the literal characters) until it settles — at which
// point the settled `Message` component takes over and renders the
// full markdown. This is the same trade-off ChatGPT and Claude.ai make
// for their live-typing view; the eye reads tokens as they arrive, not
// as formatted text, and the 100-200ms where the text becomes "real"
// happens between turns when the user is already looking at the
// finished block.
function StreamingText({ text, className }) {
	const ref = useRef(null);
	// Stable ref to the text node we own. Preact's keyed reconciliation
	// reuses this same DOM element across renders (the parent
	// <StreamingBlocks> keys each block by its array index), so the
	// text node persists — we just mutate its `.data` on every
	// streaming commit, the cheapest possible DOM update (no parse,
	// no subtree walk, no relayout unless the new string is longer,
	// which an append always is).
	const textNodeRef = useRef(null);
	// First commit: the ref callback fires while Preact is still
	// assembling the DOM, so we can append the text node synchronously
	// and avoid the empty→populated flash a useLayoutEffect would
	// cause (the first frame would otherwise render an empty div).
	const setRef = (el) => {
		ref.current = el;
		if (el && !textNodeRef.current) {
			textNodeRef.current = document.createTextNode(text);
			el.appendChild(textNodeRef.current);
		}
	};
	useLayoutEffect(() => {
		// Subsequent commits (text grew): just rewrite the existing
		// text node's data. The layout effect runs synchronously after
		// the DOM update but before paint, so the user sees the new
		// length in the same frame the state changed.
		if (textNodeRef.current) textNodeRef.current.data = text;
	}, [text]);
	return html`<div ref=${setRef} class=${className ?? "message-content"}></div>`;
}

function BlockView({ block, streaming = false }) {
	if (block.kind === "tool") return html`<${ToolCard} call=${block.call} />`;
	if (!block.text.trim()) return null;
	const kind = block.kind === "thinking" ? "reasoning" : "assistant";
	const className = `message message-${kind}${streaming ? " message-entering" : ""}`;
	return html`
		<div class=${className}>
			<div class="message-label">${block.kind === "thinking" ? "reasoning" : "agent"}</div>
			${
				streaming
					? html`<${StreamingText} text=${block.text} />`
					: block.kind === "thinking"
						? html`<div class="message-content">${block.text}</div>`
						: html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />`
			}
		</div>
	`;
}

function StreamingBlocks({ blocks }) {
	if (!blocks || blocks.length === 0) return null;
	// Same mid-word boundary collapse as the settled `Message` path — the
	// parser may have split the model's `<think>...</think>` boundary inside
	// a word (observed on MiniMax-M3 emitting `</think>` mid-Cyrillic), in
	// which case the visible reasoning and content blocks are at the same
	// word. Glide them back together at render time.
	const collapsed = collapseMidWordBoundaries(blocks);
	// Every block DOM element here is keyed by its index in the array, so
	// a block at the same index across renders reuses the same DOM node
	// and therefore does NOT replay the `rise` animation on subsequent
	// renders — CSS `animation` is bound to the element, not the
	// re-render, and only plays on initial mount. A *new* index (new
	// content block after a tool, a new tool card, etc.) creates a new
	// DOM element and the rise plays once. Streaming-token updates on
	// the same block stay still.
	// All streaming blocks carry their role label from the start of the
	// stream — the previous version rendered just `<div class="message">
	// <div class="message-content">…</div></div>` with no label, then
	// `case "message"` swapped the whole subtree for a settled version
	// that included `<div class="message-label">agent</div>`. That swap
	// read as "text grew → then the word 'agent' appeared above it" at
	// the end of every reply. Keeping the label in the streaming DOM
	// from the first render means the final settled transition is
	// content-only (markdown rendering kicks in for `agent` blocks,
	// since raw text during the stream is the `StreamingText` plain-
	// text node), not a structural change.
	return html`
		<div class="message-group">
			${collapsed.map((block, i) => html`<${BlockView} key=${block.kind === "tool" ? block.call.id : i} block=${block} streaming />`)}
		</div>
	`;
}

function LiveStreamingBlocks({ controllerRef, onFrame }) {
	const [stream, setStream] = useState({ blocks: [] });
	const streamRef = useRef({ blocks: [] });
	const rafRef = useRef(null);
	const flush = useCallback(() => {
		rafRef.current = null;
		setStream(streamRef.current);
		onFrame();
	}, [onFrame]);
	const reduce = useCallback(
		(event) => {
			streamRef.current = reduceStreamEvent(streamRef.current, event);
			if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
		},
		[flush],
	);
	const reset = useCallback(() => {
		if (rafRef.current != null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
	}, []);
	const take = useCallback(() => {
		if (rafRef.current != null) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		const snapshot = streamRef.current.blocks;
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
		return snapshot;
	}, []);
	controllerRef.current = { reduce, reset, take };
	useEffect(
		() => () => {
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			if (controllerRef.current?.reset === reset) controllerRef.current = null;
		},
		[controllerRef, reset],
	);
	return html`<${StreamingBlocks} blocks=${stream.blocks} />`;
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

// Downscales+re-encodes a pasted/dropped/picked image before it ever leaves
// the browser — a real incident (see docs/changelog.md) had 8 unresized
// photos in one turn's history get a bare, undebuggable 400 from the
// provider; MiniMax's own docs recommend keeping images to ~1024px. Encodes
// as JPEG regardless of source format (simplest way to bound size — a lossy
// re-encode of a screenshot/photo is an acceptable tradeoff here).
const IMAGE_MAX_DIMENSION = 1568;
const IMAGE_JPEG_QUALITY = 0.85;
function resizeImageToDataUrl(file) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const objectUrl = URL.createObjectURL(file);
		img.onload = () => {
			URL.revokeObjectURL(objectUrl);
			const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(img.width, img.height));
			const w = Math.max(1, Math.round(img.width * scale));
			const h = Math.max(1, Math.round(img.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			ctx.drawImage(img, 0, 0, w, h);
			resolve(canvas.toDataURL("image/jpeg", IMAGE_JPEG_QUALITY));
		};
		img.onerror = () => {
			URL.revokeObjectURL(objectUrl);
			reject(new Error("Could not load image"));
		};
		img.src = objectUrl;
	});
}

// Same blocklist as inputs.ts (server-side, authoritative) — duplicated here
// only so a blocked file gets an instant, no-round-trip rejection instead of
// waiting on an upload + 400 response. The server re-checks regardless; this
// is UX polish, not the actual boundary.
const BLOCKED_ATTACHMENT_EXTENSIONS = new Set([
	"exe",
	"msi",
	"dll",
	"so",
	"dylib",
	"bin",
	"com",
	"bat",
	"cmd",
	"scr",
	"vbs",
	"vbe",
	"ps1",
	"psm1",
	"jar",
	"app",
	"deb",
	"rpm",
	"apk",
	"run",
	"out",
	"elf",
	"cpl",
	"gadget",
	"wsf",
	"wsh",
	"ocx",
	"sys",
	"action",
	"workflow",
	"command",
]);

function isBlockedAttachmentName(name) {
	const idx = name.lastIndexOf(".");
	const ext = idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
	return BLOCKED_ATTACHMENT_EXTENSIONS.has(ext);
}

function partitionFiles(fileList) {
	const files = Array.from(fileList ?? []);
	return {
		images: files.filter((f) => f.type.startsWith("image/")),
		docs: files.filter((f) => !f.type.startsWith("image/")),
	};
}

function readFileAsDataUrl(file) {
	return new Promise((resolvePromise, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolvePromise(reader.result);
		reader.onerror = () => reject(new Error("Could not read file"));
		reader.readAsDataURL(file);
	});
}

function Composer({ running, ready, activeId, commands, personas, onSubmit, onAbort, onDocUploaded }) {
	const [value, setValue] = useState("");
	const [cmdVisible, setCmdVisible] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [images, setImages] = useState([]);
	// Non-image attachments — unlike images (embedded as image_url content
	// parts on send), these upload to ~/.cast/inputs/<session-id>/ the moment
	// they're attached (see inputs.ts / server.ts's upload route), so the
	// composer just tracks {id, name, path, uploading, error} for each and
	// references the already-on-disk path via a <system-reminder> at send time.
	const [docs, setDocs] = useState([]);
	const [dragOver, setDragOver] = useState(false);
	const textareaRef = useRef(null);
	const pickerRef = useRef(null);
	const fileInputRef = useRef(null);

	// Docs and images are per-session — switching sessions must drop
	// any attachments the user added while viewing a different session.
	// biome-ignore lint/correctness/useExhaustiveDependencies: activeId is a prop that changes on session switch
	useEffect(() => {
		setDocs([]);
		setImages([]);
	}, [activeId]);

	const addImageFiles = useCallback(async (files) => {
		if (files.length === 0) return;
		const resized = await Promise.all(files.map((f) => resizeImageToDataUrl(f).catch(() => null)));
		setImages((prev) => [...prev, ...resized.filter(Boolean)]);
	}, []);

	const addDocFiles = useCallback(
		async (files) => {
			if (files.length === 0) return;
			for (const file of files) {
				const id = `${file.name}-${Date.now()}-${Math.random()}`;
				if (isBlockedAttachmentName(file.name)) {
					setDocs((prev) => [
						...prev,
						{ id, name: file.name, error: "Executable/binary files aren't accepted as attachments" },
					]);
					continue;
				}
				// Draft sessions have no server-side session yet — defer the
				// actual upload until the compose sends (submitMessage handles
				// it after commitSession creates the real session). Store the
				// dataUrl so the composer can show the file is ready.
				if (!activeId) {
					try {
						const dataUrl = await readFileAsDataUrl(file);
						setDocs((prev) => [...prev, { id, name: file.name, dataUrl, pending: true }]);
					} catch (err) {
						setDocs((prev) => [...prev, { id, name: file.name, error: err.message }]);
					}
					continue;
				}
				setDocs((prev) => [...prev, { id, name: file.name, uploading: true }]);
				try {
					const dataUrl = await readFileAsDataUrl(file);
					const result = await api("POST", `/api/sessions/${activeId}/inputs/upload`, {
						name: file.name,
						dataUrl,
					});
					setDocs((prev) =>
						prev.map((d) => (d.id === id ? { id, name: result.name, path: result.path, size: result.size } : d)),
					);
					onDocUploaded?.();
				} catch (err) {
					setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, uploading: false, error: err.message } : d)));
				}
			}
		},
		[activeId, onDocUploaded],
	);

	const removeDoc = useCallback(
		(doc) => {
			setDocs((prev) => prev.filter((d) => d.id !== doc.id));
			// A pending doc (draft session) was never uploaded — nothing to
			// clean up server-side. Only DELETE real, already-on-disk files.
			if (activeId && doc.path) {
				api("DELETE", `/api/sessions/${activeId}/inputs?path=${encodeURIComponent(doc.name)}`).catch(() => {});
			}
		},
		[activeId],
	);

	const handlePaste = useCallback(
		(e) => {
			const files = Array.from(e.clipboardData?.items ?? [])
				.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
				.map((item) => item.getAsFile())
				.filter(Boolean);
			if (files.length === 0) return; // let normal text paste proceed
			e.preventDefault();
			addImageFiles(files);
		},
		[addImageFiles],
	);

	const handleDrop = useCallback(
		(e) => {
			e.preventDefault();
			setDragOver(false);
			const { images: imageFiles, docs: docFiles } = partitionFiles(e.dataTransfer?.files);
			addImageFiles(imageFiles);
			addDocFiles(docFiles);
		},
		[addImageFiles, addDocFiles],
	);

	const handleFilePick = useCallback(
		(e) => {
			const { images: imageFiles, docs: docFiles } = partitionFiles(e.target.files);
			addImageFiles(imageFiles);
			addDocFiles(docFiles);
			e.target.value = ""; // same file picked twice in a row must still fire onChange
		},
		[addImageFiles, addDocFiles],
	);

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
		const readyDocs = docs.filter((d) => (d.path || d.pending) && !d.uploading && !d.error);
		const pendingDocs = docs.filter((d) => d.pending && d.dataUrl);
		// A caption-less image/document send is allowed — an attachment alone
		// is a complete message, same as any chat app.
		if (!trimmed && images.length === 0 && readyDocs.length === 0) return;
		// Invisible to the user (toDisplayMessages strips <system-reminder>
		// blocks and shows them as a separate "[system] ..." notice instead of
		// leaving them in the message bubble) — the model gets the absolute
		// path so it can `read`/`bash` (or a format-specific skill) the file
		// itself; nothing here parses the attachment's actual content.
		const text =
			readyDocs.length > 0
				? `${trimmed}\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n${readyDocs.map((d) => `- ${d.name}: ${d.path ?? `(pending — will be uploaded on send)`}`).join("\n")}\n</system-reminder>`
				: trimmed;
		onSubmit(text, images, pendingDocs.length > 0 ? pendingDocs : undefined);
		setValue("");
		setImages([]);
		setDocs([]);
		setCmdVisible(false);
		if (textareaRef.current) textareaRef.current.style.height = "auto";
	}, [value, images, docs, onSubmit]);

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
			${
				images.length > 0 &&
				html`
				<div class="composer-images">
					${images.map(
						(src, i) => html`
						<div key=${i} class="composer-image-thumb">
							<img src=${src} />
							<button
								type="button"
								class="composer-image-remove"
								onClick=${() => setImages((prev) => prev.filter((_, j) => j !== i))}
								aria-label="Remove image"
							><${icons.xMark} /></button>
						</div>
					`,
					)}
				</div>
			`
			}
			${
				docs.length > 0 &&
				html`
				<div class="composer-docs">
					${docs.map(
						(d) => html`
						<div key=${d.id} class="composer-doc-chip${d.error ? " composer-doc-chip-error" : ""}" title=${d.error ?? d.name}>
							<span class="composer-doc-name">${d.uploading ? "Uploading… " : ""}${d.name}</span>
							<button
								type="button"
								class="composer-doc-remove"
								onClick=${() => removeDoc(d)}
								aria-label="Remove ${d.name}"
							><${icons.xMark} /></button>
						</div>
					`,
					)}
				</div>
			`
			}
			<div
				class="composer${dragOver ? " composer-drag-over" : ""}"
				onDragOver=${(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave=${() => setDragOver(false)}
				onDrop=${handleDrop}
			>
				<input
					ref=${fileInputRef}
					type="file"
					multiple
					style="display:none"
					onChange=${handleFilePick}
				/>
				<button
					type="button"
					class="composer-attach"
					onClick=${() => fileInputRef.current?.click()}
					disabled=${!ready}
					aria-label="Attach image or file"
					title="Attach image or file"
				><${icons.paperclip} /></button>
				<textarea
					ref=${textareaRef}
					class="composer-input"
					placeholder=${!ready ? "Connecting…" : pickerItems.length > 0 ? "↑↓ to navigate, Enter to pick" : "Type a message or / for commands..."}
					rows="1"
					disabled=${!ready}
					value=${value}
					onInput=${handleInput}
					onKeyDown=${handleKeyDown}
					onPaste=${handlePaste}
				/>
				${
					running
						? html`<button class="composer-abort" onClick=${onAbort} aria-label="Abort"><${icons.stop} /></button>`
						: html`<button class="composer-send" onClick=${handleSubmit} disabled=${!ready || (!value.trim() && images.length === 0)} aria-label="Send"><${icons.send} /></button>`
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
	inputsRefreshNonce,
	bootstrapping,
}) {
	const openClass = open ? " open" : "";

	const header = html`
		<div class="diff-header">
			<div class="diff-tabs">
				<button class="diff-tab${tab === "inputs" ? " active" : ""}" onClick=${() => onTabChange("inputs")}>Inputs</button>
				<button class="diff-tab${tab === "fs" ? " active" : ""}" onClick=${() => onTabChange("fs")}>Files</button>
				<button class="diff-tab${tab === "changes" ? " active" : ""}" onClick=${() => onTabChange("changes")}>Changes</button>
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

	if (tab === "inputs") {
		return html`
			<aside class="diff-panel${openClass}">
				<div class="diff-resize-handle" onPointerDown=${onResizeStart} />
				${header}
				<${InputsExplorer} activeId=${activeId} confirm=${confirm} refreshNonce=${inputsRefreshNonce} />
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

function humanSize(bytes) {
	if (bytes == null) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Flat list of a session's attached (non-image) documents — see inputs.ts
// for why they live in a global, session-scoped directory instead of inside
// the project's own cwd. No tree/search/rename like FileExplorer below:
// attachments aren't expected to have subdirectories, so there's nothing to
// expand or navigate, only a list to download/preview/remove from.
function InputsExplorer({ activeId, confirm, refreshNonce }) {
	const [entries, setEntries] = useState([]);
	const [error, setError] = useState(null);
	const [busyName, setBusyName] = useState(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		if (!activeId) return;
		setLoading(true);
		try {
			const data = await api("GET", `/api/sessions/${activeId}/inputs`);
			setEntries(data?.entries ?? []);
			setError(null);
		} catch (err) {
			setError(err.message);
		} finally {
			setLoading(false);
		}
	}, [activeId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshNonce prop triggers reload when docs uploaded
	useEffect(() => {
		setError(null);
		setLoading(false);
		load();
	}, [load, refreshNonce]);

	const downloadHref = (name) => `/api/sessions/${activeId}/inputs/download?path=${encodeURIComponent(name)}`;
	const previewHref = (name) => `${downloadHref(name)}&inline=1`;

	const doDelete = async (name) => {
		if (!(await confirm(`Remove attached file "${name}"? This can't be undone.`))) return;
		setBusyName(name);
		try {
			await api("DELETE", `/api/sessions/${activeId}/inputs?path=${encodeURIComponent(name)}`);
			await load();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusyName(null);
		}
	};

	if (loading) {
		return html`
			<div class="fs-explorer">
				<div class="diff-empty">Loading…</div>
			</div>
		`;
	}

	return html`
		<div class="fs-explorer">
			${error && html`<div class="diff-empty diff-empty-error">${error}</div>`}
			${
				!error && entries.length === 0
					? html`
					<div class="diff-empty diff-empty-hint">
						<div>
							<p class="diff-empty-title">No files attached</p>
							<p>Attach a document from the composer's paperclip button — it'll show up here.</p>
						</div>
					</div>
				`
					: html`
					<div class="fs-tree">
						${entries.map(
							(e) => html`
							<div key=${e.name} class="fs-row">
								<div class="fs-row-main" onClick=${() => window.open(previewHref(e.name), "_blank", "noopener")}>
									<span class="fs-icon"><${icons.docFile} /></span>
									<span class="fs-name">${e.name}</span>
									${e.size != null ? html`<span class="fs-size">${humanSize(e.size)}</span>` : null}
								</div>
								<div class="fs-row-actions">
									<a
										class="fs-action"
										href=${downloadHref(e.name)}
										download
										title="Download"
										onClick=${(ev) => ev.stopPropagation()}
									><${icons.arrowDownTray} /></a>
									<button
										class="fs-action"
										disabled=${busyName === e.name}
										title="Remove"
										onClick=${(ev) => {
											ev.stopPropagation();
											doDelete(e.name);
										}}
									><${icons.trash} /></button>
								</div>
							</div>
						`,
						)}
					</div>
				`
			}
		</div>
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

	// Shared between the tree view and the flat search-results list — a name
	// cell that swaps to an inline rename input, and an actions cell with
	// download/rename/delete — so the two render paths don't drift apart.
	const renderName = (fullPath, name) =>
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
			: html`<span class="fs-name" title=${fullPath}>${name}</span>`;

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
					<div class="fs-row-main" style=${{ paddingLeft: `${depth * 16}px` }} onClick=${() => (isDir ? toggleDir(fullPath) : setPreviewPath(fullPath))}>
						${
							isDir
								? html`<span class="fs-chevron${isOpen ? " open" : ""}"><${icons.chevronRight} /></span>`
								: html`<span class="fs-chevron-spacer"></span>`
						}
						<span class="fs-icon">${isDir ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
						${renderName(fullPath, entry.name)}
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
											<div class="fs-row-main" onClick=${() => r.type !== "dir" && setPreviewPath(r.path)}>
												<span class="fs-chevron-spacer"></span>
												<span class="fs-icon">${r.type === "dir" ? html`<${icons.folder} />` : html`<${icons.docFile} />`}</span>
												${renderName(r.path, r.path)}
											</div>
											${renderActions(r.path, baseName, r.type, isBusy)}
										</div>
									`;
									})
						: tree[""]
							? tree[""].length > 0
								? tree[""].map((entry) => renderEntry("", entry, 0))
								: html`<div class="diff-empty">No files yet</div>`
							: loadingDirs.has("")
								? html`<div class="diff-empty">Loading…</div>`
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

const SETTINGS_TABS = [
	{ id: "appearance", label: "Appearance" },
	{ id: "bash", label: "Bash" },
	{ id: "hooks", label: "Hooks" },
	{ id: "marketplace", label: "Marketplace" },
	{ id: "mcp", label: "MCP" },
	{ id: "model", label: "Model" },
	{ id: "plugins", label: "Plugins" },
	{ id: "provider", label: "Provider" },
	{ id: "skillssh", label: "Skills.sh" },
	{ id: "quick-mode", label: "Quick Mode" },
	{ id: "skills", label: "Skills" },
	{ id: "ssh", label: "SSH" },
	{ id: "web", label: "Web" },
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
	onModelChange,
}) {
	const [tab, setTab] = useState(SETTINGS_TABS[0].id);
	const [data, setData] = useState({});
	const [errors, setErrors] = useState({});
	const [busy, setBusy] = useState(false);
	const loadVersions = useRef(new Map());

	const run = useCallback(
		async (command) => {
			try {
				const endpoint = activeId ? `/api/sessions/${activeId}/command` : "/api/settings/command";
				return await api("POST", endpoint, { command });
			} catch (err) {
				return { ok: false, error: err.message };
			}
		},
		[activeId],
	);

	const load = useCallback(
		async (t) => {
			// Initial preloading and post-mutation refreshes race by design. Only
			// the newest request for a resource may update its visible state.
			const version = (loadVersions.current.get(t) || 0) + 1;
			loadVersions.current.set(t, version);
			const isCurrent = () => loadVersions.current.get(t) === version;
			const commit = (update) => {
				if (isCurrent()) setData(update);
			};
			const setLoadError = (error) => {
				if (isCurrent()) setErrors((e) => ({ ...e, [t]: error }));
			};
			setErrors((e) => ({ ...e, [t]: null }));
			if (t === "model") {
				const [models, reasoning, current, providers] = await Promise.all([
					api("GET", "/api/models/cached").catch(() => null),
					api(
						"GET",
						activeId ? `/api/sessions/${activeId}/reasoning-options` : "/api/settings/reasoning-options",
					).catch(() => null),
					run("/current"),
					run("/provider list"),
				]);
				commit((d) => ({
					...d,
					model: {
						models: models?.models ?? [],
						reasoningOptions: reasoning?.options ?? [],
						current: current?.result,
						providers: providers?.result ?? [],
					},
				}));
			} else if (t === "bash") {
				const permissions = await run("/permissions");
				commit((d) => ({ ...d, bash: { permissions: permissions?.result } }));
			} else if (t === "web") {
				const [webTools, searchProvider, fetchProvider] = await Promise.all([
					run("/web"),
					run("/web-search-provider"),
					run("/web-fetch-provider"),
				]);
				commit((d) => ({
					...d,
					web: {
						webTools: webTools?.result,
						searchProvider: searchProvider?.result,
						fetchProvider: fetchProvider?.result,
					},
				}));
			} else if (t === "quick-mode") {
				const quickSessionPersona = await run("/quick-session-persona");
				commit((d) => ({ ...d, "quick-mode": { quickSessionPersona: quickSessionPersona?.result } }));
			} else if (t === "hooks") {
				const res = await run("/hooks");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, hooks: res.result }));
			} else if (t === "mcp") {
				const res = await run("/mcp list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, mcp: res.result }));
			} else if (t === "skills") {
				const res = await run("/skills list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, skills: res.result }));
			} else if (t === "skillssh") {
				// Reuses the same data as the Skills tab — Skills.sh skills are
				// already loaded from ~/.config/agents/skills/ as part of the
				// agentsGlobalDirs list.
				const res = await run("/skills list");
				commit((d) => ({ ...d, skills: res?.result ?? [], skillssh: true }));
			} else if (t === "plugins") {
				const res = await run("/plugin list");
				commit((d) => ({
					...d,
					plugins: {
						plugins: res?.result ?? [],
					},
				}));
			} else if (t === "marketplace") {
				const [marketplaces, catalog] = await Promise.all([
					run("/plugin marketplace list"),
					run("/plugin marketplace catalog"),
				]);
				commit((d) => ({
					...d,
					marketplace: {
						marketplaces: marketplaces?.result ?? [],
						catalog: catalog?.result ?? [],
					},
				}));
			} else if (t === "provider") {
				const res = await run("/provider list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, provider: res.result }));
			} else if (t === "ssh") {
				const res = await run("/ssh list");
				if (!res.ok) {
					setLoadError(res.error);
					return;
				}
				commit((d) => ({ ...d, ssh: res.result }));
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
			const actionTab = tab;
			setBusy(true);
			setErrors((e) => ({ ...e, [actionTab]: null }));
			try {
				const res = await run(command);
				if (!res.ok) setErrors((e) => ({ ...e, [tab]: res.error ?? "Failed" }));
				// Always refresh the Model tab too: a /provider Switch changes the
				// active provider, which the Model picker's model list depends on.
				await Promise.all([load(actionTab), actionTab === "model" ? Promise.resolve() : load("model")]);
				// /reload and any /skills mutation can change which skills are
				// loaded/enabled — those show up as native /<skill-id> slash commands,
				// so the composer's palette needs to catch up too.
				// Same for /plugin install/uninstall/enable/disable — they change
				// which hooks appear in the Hooks tab.
				if (res.ok) {
					if (command.startsWith("/model ") && typeof res.result?.model === "string") {
						onModelChange?.(res.result.model);
					}
					if (command === "/reload" || command.startsWith("/skills ")) onReload?.();
					if (
						command === "/reload" ||
						command.startsWith("/plugin ") ||
						command.startsWith("/mcp ") ||
						command.startsWith("/skills-sh ")
					) {
						await Promise.all([load("hooks"), load("mcp"), load("skills")]);
					}
				}
				return res;
			} catch (err) {
				// A failure anywhere above (e.g. a tab reload throwing) must not
				// leave `busy` stuck true forever — every button in the modal
				// would stay disabled until it's closed and reopened.
				const message = err instanceof Error ? err.message : String(err);
				setErrors((e) => ({ ...e, [actionTab]: message }));
				return { ok: false, error: message };
			} finally {
				setBusy(false);
			}
		},
		[run, load, tab, onReload, onModelChange],
	);

	// theme's data comes from the `themes` prop (fetched once at app boot,
	// always present already) rather than the per-tab preload above.
	// theme and font both come from props/local state (fetched once at app
	// boot, or never fetched at all for font — see applyFont) rather than the
	// per-tab preload above.
	const hasData = tab === "appearance" || data[tab] !== undefined;

	return html`
		<div class="modal-backdrop" onClick=${onClose}>
			<div class="modal settings-modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Settings</span>
					<div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
						<button class="modal-btn" disabled=${busy} onClick=${() => act("/reload")} title="Re-scan .cast/ directories for skills, rules, MCP servers, and personas from disk">Reload resources</button>
						<button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
					</div>
				</div>
				<div class="settings-body">
					<div class="settings-tabs">
						${SETTINGS_TABS.map(
							(t) => html`
							<button key=${t.id} class="settings-tab${tab === t.id ? " active" : ""}" disabled=${busy} onClick=${() => setTab(t.id)}>${t.label}</button>
						`,
						)}
					</div>
					<div class="settings-pane">
						${errors[tab] && html`<div class="settings-error">${errors[tab]}</div>`}
						${
							!hasData
								? html`<div class="settings-loading">Loading…</div>`
								: tab === "appearance"
									? html`<${SettingsAppearance} themes=${themes} currentThemeId=${currentThemeId} onPickTheme=${async (
											id,
										) => {
											const res = await act(`/theme ${id}`);
											if (res.ok && res.result?.colors) onApplyTheme(res.result.colors);
											if (res.ok && res.result?.theme) onThemeChange(res.result.theme);
										}} currentFontId=${currentFontId} currentFontScale=${currentFontScale} onPickFont=${onPickFont} onPickScale=${onPickScale} />`
									: tab === "model"
										? html`<${SettingsModel} data=${data.model} busy=${busy} act=${act} />`
										: tab === "bash"
											? html`<${SettingsBash} data=${data.bash} busy=${busy} act=${act} />`
											: tab === "web"
												? html`<${SettingsWeb} data=${data.web} busy=${busy} act=${act} />`
												: tab === "quick-mode"
													? html`<${SettingsQuickMode} data=${data["quick-mode"]} busy=${busy} act=${act} personas=${personas} onQuickSessionPersonaChange=${onQuickSessionPersonaChange} />`
													: tab === "hooks"
														? html`<${SettingsHooks} data=${data.hooks} busy=${busy} act=${act} />`
														: tab === "mcp"
															? html`<${SettingsMcp} data=${data.mcp} busy=${busy} act=${act} confirm=${confirm} />`
															: tab === "skills"
																? html`<${SettingsSkills} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
																: tab === "plugins"
																	? html`<${SettingsPlugins} data=${data.plugins} busy=${busy} act=${act} confirm=${confirm} />`
																	: tab === "marketplace"
																		? html`<${SettingsMarketplace} data=${data.marketplace} busy=${busy} act=${act} confirm=${confirm} />`
																		: tab === "skillssh"
																			? html`<${SettingsSkillssh} data=${data.skills} busy=${busy} act=${act} confirm=${confirm} />`
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
 * /v1/models list is fetched and shown in the model dropdown. The "Set"
 * button applies the provider and model. "Reset" is one atomic command that
 * returns a secondary slot to the main model and provider.
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
	const modelRequestVersion = useRef(0);

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
		const version = ++modelRequestVersion.current;
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
				if (!cancelled && version === modelRequestVersion.current) setModels(res?.models ?? []);
			} catch {
				if (!cancelled && version === modelRequestVersion.current) setModels([]);
			}
			if (!cancelled && version === modelRequestVersion.current) setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [initialProvider, activeProviderName]);

	// Fetch models when provider changes.
	const onProviderChange = useCallback(async (name) => {
		const version = ++modelRequestVersion.current;
		setProviderValue(name);
		setModelValue("");
		setLoading(true);
		try {
			const qs = name ? `?provider=${encodeURIComponent(name)}` : "";
			const res = await api("GET", `/api/models${qs}`);
			if (version === modelRequestVersion.current) setModels(res?.models ?? []);
		} catch {
			if (version === modelRequestVersion.current) setModels([]);
		}
		if (version === modelRequestVersion.current) setLoading(false);
	}, []);

	const doSet = useCallback(async () => {
		if (providerValue) await act(`${providerCommand} ${providerValue}`);
		if (modelValue && models.some((m) => m.id === modelValue)) await act(`${modelCommand} ${modelValue}`);
	}, [providerValue, modelValue, models, act, providerCommand, modelCommand]);

	const doReset = useCallback(async () => {
		await act(`${modelCommand} reset`);
		setProviderValue("");
		setModelValue("");
		setModels([]);
	}, [act, modelCommand]);

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
			${!isMainSlot && hasOverride ? html`<button class="modal-btn icon-btn" title="Use the main model and provider" disabled=${busy} onClick=${doReset}><${icons.arrowUturnLeft} /></button>` : null}
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
			<p class="settings-hint">Pick a provider first — its dropdown populates with that provider's models. Pick a model and click Apply.</p>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${activeProviderName} currentModel=${c.model} providerCommand="/provider" modelCommand="/model" isMainSlot=${true} initialModels=${data.models} />
			<div class="settings-section-title">Reasoning — current: ${c.reasoningLevel ?? "off"}</div>
			${
				data.reasoningOptions.length === 0
					? html`<div class="settings-hint">This model exposes no reasoning controls.</div>`
					: html`
					<p class="settings-hint">Controls how much internal thinking the model does before answering. Higher levels use more tokens but can improve complex task performance.</p>
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
			<p class="settings-hint">Model used for task subagents — inherits the main model unless overridden here. Use ↩ to return to inheritance.</p>
			<${SlotModelPicker} busy=${busy} act=${act} providers=${providers} activeProviderName=${activeProviderName} currentProvider=${c.subagentModelProvider} currentModel=${c.subagentModel} fallbackModel=${c.model} providerCommand="/subagent-model-provider" modelCommand="/subagent-model" initialModels=${data.models} />
			<div class="settings-section-title">Plan-mode model${c.planModelProvider ? ` — @ ${c.planModelProvider}` : ""}</div>
			<p class="settings-hint">Model used when the agent enters plan mode — inherits the main model unless overridden here.</p>
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

function SettingsAppearance({
	themes,
	currentThemeId,
	onPickTheme,
	currentFontId,
	currentFontScale,
	onPickFont,
	onPickScale,
}) {
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Theme</div>
			<${SettingsTheme} themes=${themes} currentThemeId=${currentThemeId} onPick=${onPickTheme} />
			<div class="settings-section-title">Font</div>
			<${SettingsFont} currentFontId=${currentFontId} currentFontScale=${currentFontScale} onPickFont=${onPickFont} onPickScale=${onPickScale} />
		</div>
	`;
}

// Client-only (localStorage) — unlike SettingsTheme, picking here never
// round-trips through `act`/`/command`, so it applies the instant it's
// clicked/dragged. The local regular faces are already ready for every tile.
function SettingsFont({ currentFontId, currentFontScale, onPickFont, onPickScale }) {
	return html`
		<div class="settings-font-settings">
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
			<div class="settings-row-label">Monospace</div>
			<div class="settings-font-grid">
			${FONT_OPTIONS.filter((f) => f.mono).map(
				(f) => html`
				<button key=${f.id} class="settings-font-swatch${f.id === currentFontId ? " active" : ""}" style=${{ fontFamily: f.family }} onClick=${() => onPickFont(f.id)}>
					${f.label}
				</button>
			`,
			)}
			</div>
			<div class="settings-row-label">Sans-serif</div>
			<div class="settings-font-grid">
			${FONT_OPTIONS.filter((f) => !f.mono).map(
				(f) => html`
				<button key=${f.id} class="settings-font-swatch${f.id === currentFontId ? " active" : ""}" style=${{ fontFamily: f.family }} onClick=${() => onPickFont(f.id)}>
					${f.label}
				</button>
			`,
			)}
			</div>
		</div>
	`;
}

// The small "i" description popover and the "book" full-content viewer
// (readUrl — currently only SKILL.md, always markdown) are different enough
// in scale that they get different chrome: a short description stays a
// small anchored popover, but a whole document reuses the exact same
// modal-preview treatment (size, markdown rendering) as the Files panel's
// file preview, so "read the full skill" looks the same wherever it's
// triggered from instead of being its own smaller, plain-text-only thing.
function InfoPopover({ text, readUrl }) {
	const [infoOpen, setInfoOpen] = useState(false);
	const [bookOpen, setBookOpen] = useState(false);
	const [fullContent, setFullContent] = useState(null);
	// Same anti-flicker discipline as FilePreviewModal: stays null (renders
	// "Loading…") through marked's async load+parse instead of flashing the
	// raw markdown source first — see that component's comment for why.
	const [renderedHtml, setRenderedHtml] = useState(null);
	const [renderFailed, setRenderFailed] = useState(false);
	useEffect(() => {
		if (!infoOpen) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setInfoOpen(false);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [infoOpen]);
	useEffect(() => {
		if (!bookOpen) return;
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setBookOpen(false);
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [bookOpen]);
	const modalRef = useModalFocusTrap(bookOpen);
	const loadFull = async () => {
		setBookOpen(true);
		setFullContent(null);
		setRenderedHtml(null);
		setRenderFailed(false);
		let content;
		try {
			const res = await api("GET", readUrl);
			content = res?.content || res?.error || "No content";
		} catch {
			content = "Failed to load";
		}
		setFullContent(content);
		try {
			const { marked } = await loadMarked();
			setRenderedHtml(marked.parse(content));
		} catch {
			setRenderFailed(true);
		}
	};
	if (!text && !readUrl) return null;
	return [
		html`<span class="info-popover-wrap" style=${{ display: "inline-flex", gap: "2px" }}>
			${
				text
					? html`<button class="modal-btn icon-btn" title="Description" onClick=${(e) => {
							e.stopPropagation();
							setInfoOpen(true);
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
		infoOpen && html`<div class="info-popover-backdrop" onClick=${() => setInfoOpen(false)} />`,
		infoOpen &&
			html`<div class="info-popover" onClick=${(e) => e.stopPropagation()}>
			<div class="info-popover-header"><button class="modal-btn icon-btn" onClick=${() => setInfoOpen(false)}><${icons.xMark} /></button></div>
			<div class="info-popover-text">${text}</div>
		</div>`,
		bookOpen &&
			html`<div class="modal-backdrop" onClick=${() => setBookOpen(false)}>
			<div class="modal modal-preview" role="dialog" aria-modal="true" aria-label="Skill content" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
				<div class="modal-header">
					<span>Skill content</span>
					<button class="modal-close" onClick=${() => setBookOpen(false)} aria-label="Close"><${icons.xMark} /></button>
				</div>
				<div class="fs-preview-body">
					${
						fullContent == null || (renderedHtml == null && !renderFailed)
							? html`<div class="diff-empty">Loading…</div>`
							: renderFailed
								? html`<pre class="fs-preview-text">${fullContent}</pre>`
								: html`<div class="fs-preview-markdown message-content" dangerouslySetInnerHTML=${{ __html: renderedHtml }} />`
					}
				</div>
			</div>
		</div>`,
	];
}

function SettingsBash({ data, busy, act }) {
	if (!data) return null;
	const perm = data.permissions || {};
	return html`
		<div class="settings-rows">
			<div class="settings-section-title">Bash confirmation mode</div>
			<p class="settings-hint">Default asks before running potentially dangerous shell commands. Bypass skips all confirmation prompts.</p>
			<div class="settings-form-row">
				<button class="modal-btn${perm.permissionMode === "default" ? " modal-btn-primary" : ""}" title="Confirm dangerous commands" disabled=${busy} onClick=${() => act("/permissions default")}>Default</button>
				<button class="modal-btn${perm.permissionMode === "bypass" ? " modal-btn-primary" : ""}" title="Skip confirmation prompts" disabled=${busy} onClick=${() => act("/permissions bypass")}>Bypass</button>
			</div>
		</div>
	`;
}

function SettingsWeb({ data, busy, act }) {
	const [tavilyKey, setTavilyKey] = useState("");
	const [braveKey, setBraveKey] = useState("");
	const [pendingSearchProvider, setPendingSearchProvider] = useState("");
	if (!data) return null;
	const webTools = data.webTools || {};
	const search = data.searchProvider || {};
	const fetchProvider = data.fetchProvider || {};
	const webOn = webTools.webTools;
	const provider = search.searchProvider || "ddg";
	const selectedSearchProvider = pendingSearchProvider || provider;
	const tKey = tavilyKey || search.tavilyApiKey || "";
	const bKey = braveKey || search.braveApiKey || "";
	const fetchBackend = fetchProvider.webFetchProvider || "jina";
	const selectSearchProvider = async (nextProvider) => {
		setPendingSearchProvider(nextProvider);
		if (nextProvider !== "ddg") return;
		const result = await act("/web-search-provider ddg");
		if (result.ok) setPendingSearchProvider("");
	};
	const saveSearchProvider = async () => {
		const key = selectedSearchProvider === "tavily" ? tKey : bKey;
		if (!key) return;
		const result = await act(`/web-search-provider ${selectedSearchProvider} ${key}`);
		if (result.ok) setPendingSearchProvider("");
	};
	return html`
		<div class="settings-compact-list">
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Web tools</span><span>Lets the agent search the web and read pages.</span></div>
				<button class="settings-toggle" role="switch" aria-checked=${webOn ? "true" : "false"} disabled=${busy} onClick=${() => act(`/web ${webOn ? "off" : "on"}`)}><span class="settings-toggle-thumb" />${webOn ? "Enabled" : "Disabled"}</button>
			</div>
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Search</span><span>DuckDuckGo is free but rate-limited; Tavily and Brave need a key.</span></div>
				<select disabled=${busy} value=${selectedSearchProvider} onChange=${(e) => selectSearchProvider(e.target.value)}>
					<option value="ddg">DuckDuckGo</option>
					<option value="tavily">Tavily</option>
					<option value="brave">Brave Search</option>
				</select>
			</div>
			${
				selectedSearchProvider !== "ddg"
					? html`<div class="settings-compact-detail"><input type="password" autocomplete="off" placeholder=${selectedSearchProvider === "tavily" ? "Tavily API key (tvly-...)" : "Brave Search API key (BSA...)"} value=${selectedSearchProvider === "tavily" ? tKey : bKey} onInput=${(e) => (selectedSearchProvider === "tavily" ? setTavilyKey(e.target.value) : setBraveKey(e.target.value))} /><button class="modal-btn" disabled=${busy || !(selectedSearchProvider === "tavily" ? tKey : bKey)} onClick=${saveSearchProvider}>Save</button></div>`
					: null
			}
			<div class="settings-compact-row">
				<div class="settings-compact-copy"><span class="settings-compact-title">Fetch pages</span><span>${fetchBackend === "jina" ? "Handles JavaScript pages and PDFs; URLs go through Jina Reader." : "Fetches directly from this machine; no third party receives the URL."}</span></div>
				<div class="settings-segmented"><button class="modal-btn${fetchBackend === "jina" ? " modal-btn-primary" : ""}" disabled=${busy} onClick=${() => act("/web-fetch-provider jina")}>Jina</button><button class="modal-btn${fetchBackend === "local" ? " modal-btn-primary" : ""}" disabled=${busy} onClick=${() => act("/web-fetch-provider local")}>Local</button></div>
			</div>
		</div>
	`;
}

function SettingsQuickMode({ data, busy, act, personas, onQuickSessionPersonaChange }) {
	const [quickPersonaValue, setQuickPersonaValue] = useState("");
	if (!data) return null;
	const quickPersona = data.quickSessionPersona?.quickSessionPersona ?? "senior";
	return html`
		<div class="settings-rows">
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
			<p class="settings-intro"><span>Background processes that give the agent extra tools. Configured in <code>.cast/mcp.json</code> (project) or <code>~/.cast/mcp.json</code> (global).</span></p>
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
			<p class="settings-intro"><span>On-demand instruction sets — "expertise plugins" the agent picks up when a task matches, or you invoke with <code>/skill-name</code>. Click ℹ to preview one.</span></p>
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
		</div>
	`;
}

function SettingsHooks({ data, busy, act }) {
	const hooks = data?.entries || [];
	const diagnostics = data?.diagnostics || [];
	// Group plugins by pluginId — each plugin gets its own collapsible subsection.
	// Global/project stay flat since they have no pluginId.
	const globalHooks = hooks.filter((h) => h.source === "global");
	const projectHooks = hooks.filter((h) => h.source === "project");
	const pluginGroups = new Map();
	for (const h of hooks.filter((h) => h.source === "plugin")) {
		const key = h.pluginId ?? "(unknown plugin)";
		if (!pluginGroups.has(key)) pluginGroups.set(key, []);
		pluginGroups.get(key).push(h);
	}
	const renderHook = (h, showPlugin = false) => html`
		<div key=${h.id} class="settings-item-row settings-item-row-stack">
			<div class="settings-item-header">
				<span class="settings-item-status ${h.enabled ? "ok" : "off"}" />
				<span class="settings-item-name">${h.event}${h.matcher ? html` <span style=${{ opacity: 0.6 }}>(${h.matcher})</span>` : ""}</span>
				${showPlugin && h.pluginId ? html`<span class="settings-item-meta">${h.pluginId}</span>` : ""}
				<div class="settings-item-actions">
					<button class="modal-btn icon-btn" title=${h.enabled ? "Disable" : "Enable"} disabled=${busy} onClick=${() => act(`/hooks ${h.enabled ? "disable" : "enable"} ${h.id}`)}>${h.enabled ? html`<${icons.pause} />` : html`<${icons.play} />`}</button>
				</div>
			</div>
			${
				h.commands?.length > 0 &&
				html`
				<div class="settings-item-body">
					${h.commands.map(
						(c) => html`
						<div class="settings-item-cmd">
							<span class="settings-item-cmd-type">${c.type ?? "command"}</span>
							<code>${c.type === "http" ? c.url : c.command}</code>
							${c.if ? html`<span class="settings-item-cmd-if">if: ${c.if}</span>` : ""}
							${c.timeout ? html`<span class="settings-item-cmd-timeout">${c.timeout}s</span>` : ""}
						</div>
					`,
					)}
				</div>
			`
			}
		</div>
	`;
	const renderGroup = (label, items, opts = {}) => {
		if (items.length === 0) return null;
		return html`
			<div key=${opts.key ?? label} class="settings-group">
				<div class="settings-section-title">${label}</div>
				${[...items].sort((a, b) => a.event.localeCompare(b.event)).map((h) => renderHook(h, opts.showPlugin ?? false))}
			</div>
		`;
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Shell (or HTTP) commands that fire on lifecycle events — validate/block a tool call, log activity, or force the agent to keep working before it stops. Configure in <code>.cast/hooks.json</code> (project) or <code>~/.cast/hooks.json</code> (global). Plugin-contributed hooks are grouped under their plugin; uninstall the plugin to remove all its hooks.</span></p>
			${
				diagnostics.length > 0 &&
				html`<div class="settings-error">
					${diagnostics.map((d) => html`<div key=${d.path}>Failed to parse <code>${d.path}</code>: ${d.message}</div>`)}
				</div>`
			}
			${renderGroup("Global", globalHooks, { key: "global" })}
			${renderGroup("Project", projectHooks, { key: "project" })}
			${[...pluginGroups.entries()]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([pluginId, items]) => html`
					<div key=${pluginId} class="settings-group">
						<div class="settings-section-title settings-section-title-plugin">
							<span class="settings-section-title-name">${pluginId}</span>
							<span class="settings-section-title-count">${items.length} hook${items.length === 1 ? "" : "s"}</span>
						</div>
						${[...items].sort((a, b) => a.event.localeCompare(b.event)).map((h) => renderHook(h, false))}
					</div>
				`,
				)}
			${hooks.length === 0 && html`<div class="settings-hint">No hooks configured.</div>`}
		</div>
	`;
}

function SettingsSkillssh({ data, busy, act, confirm }) {
	const [installArgs, setInstallArgs] = useState("");
	const [installing, setInstalling] = useState(false);
	const allSkills = data || [];
	// Filter to skills installed via npx skills add (flagged by the bridge)
	const shSkills = allSkills.filter((s) => s.skillssh);
	const install = async () => {
		if (!installArgs || busy || installing) return;
		setInstalling(true);
		try {
			const res = await act(`/skills-sh install ${installArgs}`);
			if (res.ok) setInstallArgs("");
		} finally {
			setInstalling(false);
		}
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span><a href="https://skills.sh" target="_blank" rel="noopener">skills.sh</a> is the open agent-skills ecosystem (70+ agents, 27k stars) — browse it there for a package name, then install below. Cast already loads anything in <code>~/.agents/skills/</code> automatically.</span></p>

			<div class="settings-section-title">Install a skill</div>
			<div class="settings-form-row">
				<input type="text" placeholder="owner/repo --skill name (or paste skills.sh's npx command)" value=${installArgs} disabled=${installing} onInput=${(e) => setInstallArgs(e.target.value)} onKeyDown=${(
					e,
				) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void install();
					}
				}} />
				<button class="modal-btn icon-btn" title=${installing ? "Installing skill" : "Run npx skills add -g"} aria-busy=${installing} disabled=${busy || installing || !installArgs} onClick=${install}>${installing ? html`<span class="settings-inline-loader" aria-label="Installing" />` : html`<${icons.arrowDownTray} />`}</button>
			</div>
			${installing && html`<div class="settings-install-status" role="status">Installing skill… this can take a minute.</div>`}

			<div class="settings-section-title">Installed via skills.sh (${shSkills.length})</div>
			${shSkills.length === 0 && html`<div class="settings-hint">No skills installed via skills.sh yet. Install one above.</div>`}
			${[...shSkills]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(s) => html`
				<div key=${s.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${s.name}</span>
						<span class="settings-item-meta">${s.skillsshSource || ""}</span>
						<${InfoPopover} text=${s.description} readUrl=${`/api/skill-content?name=${encodeURIComponent(s.name)}`} />
					</div>
					<div class="settings-item-actions">
						<button class="modal-btn icon-btn modal-btn-danger" title="Uninstall" disabled=${busy} onClick=${async () => {
							if (await confirm(`Uninstall skill "${s.name}" (via npx skills rm)?`))
								act(`/skills-sh uninstall ${s.name}`);
						}}><${icons.trash} /></button>
					</div>
				</div>
			`,
				)}
		</div>
	`;
}

function SettingsPlugins({ data, busy, act, confirm }) {
	if (!data) return null;
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Plugins installed on this machine. Each plugin can ship skills, hooks, and MCP servers. To browse and install more, see the <strong>Marketplace</strong> tab.</span></p>
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
			${data.plugins.length === 0 && html`<div class="settings-hint">No plugins installed. Browse the Marketplace tab to add some.</div>`}
		</div>
	`;
}

function SettingsMarketplace({ data, busy, act, confirm }) {
	const [mpSource, setMpSource] = useState("");
	const [mpQuery, setMpQuery] = useState("");
	const [addStatus, setAddStatus] = useState("");
	if (!data) return null;
	const catalog = data.catalog || [];
	const sortedCatalog = [...catalog].sort((a, b) => a.name.localeCompare(b.name));
	const installedNames = new Set(data.plugins?.map?.((p) => p.plugin || p.id) ?? []);
	const installedIds = new Set(data.plugins?.map?.((p) => p.id) ?? []);
	const renderInstallable = (mp, p) => {
		const pkg = p.package || p.name;
		const name = p.name || pkg;
		const id = `${name}@${mp.name}`;
		const installed = installedNames.has(name) || installedIds.has(id);
		return html`
			<div key=${`${mp.name}:${name}`} class="plugin-catalog-item">
				<div class="plugin-catalog-header">
					<span class="settings-item-name">${name}</span>
					<span class="settings-item-meta">${mp.name}</span>
					${
						installed
							? html`<span class="plugin-installed-label">installed</span>`
							: html`<button class="modal-btn icon-btn" title="Install" disabled=${busy} onClick=${() => act(`/plugin install ${id}`)}><${icons.arrowDownTray} /></button>`
					}
				</div>
				${p.description && html`<div class="plugin-catalog-desc">${p.description}</div>`}
			</div>
		`;
	};
	// Every marketplace's plugins merged into one flat list (already loaded
	// in memory — no network round trip) instead of a per-marketplace tab,
	// filtered live by the search box.
	const query = mpQuery.trim().toLowerCase();
	const allPlugins = sortedCatalog
		.filter((mp) => !mp.error)
		.flatMap((mp) =>
			(mp.plugins || [])
				.filter((p) => {
					if (!query) return true;
					const name = (p.name || p.package || "").toLowerCase();
					const desc = (p.description || "").toLowerCase();
					return name.includes(query) || desc.includes(query);
				})
				.map((p) => ({ mp, p })),
		);
	const erroredMarketplaces = sortedCatalog.filter((mp) => mp.error);
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Browse plugin catalogs from configured marketplaces, and manage which marketplaces cast knows about. Plugins you install from here will appear in the <strong>Plugins</strong> tab.</span></p>

			<div class="settings-section-title">Browse marketplaces (${allPlugins.length})</div>
			<div class="settings-form-row">
				<input type="text" placeholder="search all marketplaces (e.g. testing)" value=${mpQuery} onInput=${(e) => setMpQuery(e.target.value)} />
				${
					mpQuery &&
					html`<button class="modal-btn icon-btn" title="Clear search" onClick=${() => setMpQuery("")}><${icons.xMark} /></button>`
				}
			</div>
			${
				catalog.length === 0
					? html`<div class="settings-hint">Loading catalog…</div>`
					: html`
					<div class="plugin-catalog-list">
						${
							allPlugins.length === 0
								? html`<div class="settings-hint">${query ? `No plugins match "${mpQuery}".` : "No plugins found."}</div>`
								: allPlugins
										.sort((a, b) =>
											(a.p.name || a.p.package || "").localeCompare(b.p.name || b.p.package || ""),
										)
										.map(({ mp, p }) => renderInstallable(mp, p))
						}
					</div>
				`
			}
			${
				erroredMarketplaces.length > 0 &&
				html`<div class="settings-hint">Failed to load catalog for: ${erroredMarketplaces.map((mp) => mp.name).join(", ")}.</div>`
			}

			<div class="settings-section-title">Marketplaces</div>
				<div class="settings-rows">
					${[...data.marketplaces]
						.sort((a, b) => a.name.localeCompare(b.name))
						.map(
							(mp) => html`
						<div key=${mp.name} class="settings-item-row">
							<div class="settings-item-info">
								<span class="settings-item-name">${mp.name}</span>
								<span class="settings-item-meta" title=${mp.source}>${mp.isDefault ? "built-in" : shortPath(mp.source)}</span>
							</div>
							<div class="settings-item-actions">
								<button class="modal-btn icon-btn" title="Update" disabled=${busy} onClick=${() => act(`/plugin marketplace update ${mp.name}`)}><${icons.arrowPath} /></button>
								${
									!mp.isDefault &&
									html`<button class="modal-btn icon-btn modal-btn-danger" title="Remove" disabled=${busy} onClick=${async () => {
										if (await confirm(`Remove marketplace "${mp.name}"?`))
											act(`/plugin marketplace remove ${mp.name}`);
									}}><${icons.trash} /></button>`
								}
							</div>
						</div>
					`,
						)}
					${data.marketplaces.length === 0 && html`<div class="settings-hint">No marketplaces added.</div>`}
					<div class="settings-hint" style="margin-bottom:6px">Any git repo with a <code>marketplace.json</code> catalog works. Add by <code>owner/repo</code>, URL, or path.</div>
					<div class="settings-form-row">
						<input type="text" placeholder="owner/repo, URL, or path" value=${mpSource} onInput=${(e) => {
							setMpSource(e.target.value);
							setAddStatus("");
						}} />
						<button class="modal-btn icon-btn" title="Add marketplace" disabled=${busy || !mpSource} onClick=${async () => {
							const res = await act(`/plugin marketplace add ${mpSource}`);
							if (res.ok) {
								setAddStatus(typeof res.result === "string" ? res.result : "Marketplace added");
								setMpSource("");
							}
						}}><${icons.plus} /></button>
					</div>
					${addStatus && html`<div class="settings-ok" role="status">${addStatus}</div>`}
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
	const [verifying, setVerifying] = useState(false);
	const verifyVersion = useRef(0);
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
		const version = ++verifyVersion.current;
		setVerifying(true);
		setVerifyState({ ok: null, msg: "Verifying…" });
		try {
			const res = await api("POST", "/api/provider/verify", { url, apiKey });
			if (version !== verifyVersion.current) return;
			if (res?.ok) setVerifyState({ ok: true, msg: "Provider reachable" });
			else setVerifyState({ ok: false, msg: res?.error || "Verification failed" });
		} catch (_e) {
			if (version === verifyVersion.current) setVerifyState({ ok: false, msg: "Verification request failed" });
		} finally {
			if (version === verifyVersion.current) setVerifying(false);
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
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<input type="text" placeholder="base URL" value=${url} onInput=${(e) => {
					setUrl(e.target.value);
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<input type="password" placeholder="API key" value=${apiKey} onInput=${(e) => {
					setApiKey(e.target.value);
					verifyVersion.current++;
					setVerifyState(null);
				}} />
				<button class="modal-btn icon-btn" title="Verify credentials" disabled=${busy || saving || verifying || !url || !apiKey} onClick=${doVerify}><${icons.arrowPath} /></button>
				<button class="modal-btn icon-btn" title=${editing ? "Save changes" : "Add provider"} disabled=${busy || saving || verifying || !name || !url || !apiKey} onClick=${saveProvider}><${icons.check} /></button>
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
	const [authMode, setAuthMode] = useState("agent");
	const [password, setPassword] = useState("");
	const [keyContent, setKeyContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [formStatus, setFormStatus] = useState(null);
	const addHost = async () => {
		const parsedPort = port ? Number(port) : undefined;
		if (port && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
			setFormStatus({ ok: false, message: "Port must be a number from 1 to 65535" });
			return;
		}
		if (authMode === "key" && !keyContent.trim()) {
			setFormStatus({ ok: false, message: "Paste a private key or choose SSH agent" });
			return;
		}
		if (authMode === "password" && !password) {
			setFormStatus({ ok: false, message: "Enter a password or choose another sign-in method" });
			return;
		}
		setSaving(true);
		setFormStatus(null);
		try {
			let keyPath;
			if (authMode === "key") {
				const keyResult = await api("POST", "/api/ssh/key", { name, key: keyContent.trim() });
				if (!keyResult?.ok) {
					setFormStatus({ ok: false, message: keyResult?.error || "Could not save the private key" });
					return;
				}
				keyPath = keyResult.path;
			}
			const result = await api("POST", "/api/ssh/add", {
				name,
				host,
				username: username || undefined,
				port: parsedPort,
				keyPath,
				password: authMode === "password" ? password : undefined,
			});
			if (!result?.ok) {
				setFormStatus({ ok: false, message: result?.error || "Could not add the host" });
				return;
			}
			setName("");
			setHost("");
			setUsername("");
			setPort("");
			setAuthMode("agent");
			setPassword("");
			setKeyContent("");
			setFormStatus({ ok: true, message: `Added ${name}` });
			await act("/ssh list");
		} catch (err) {
			setFormStatus({ ok: false, message: err instanceof Error ? err.message : "Could not add the host" });
		} finally {
			setSaving(false);
		}
	};
	return html`
		<div class="settings-rows">
			<p class="settings-intro"><span>Remote machines the agent can run commands on via the <code>ssh</code> tool — deploy code, inspect logs, and more.</span></p>
			${[...(data || [])]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(
					(h) => html`
				<div key=${h.name} class="settings-item-row">
					<div class="settings-item-info">
						<span class="settings-item-name">${h.name}</span>
						<span class="settings-item-meta">${h.username ? `${h.username}@` : ""}${h.host}${h.port ? `:${h.port}` : ""} · ${h.keyPath ? "private key" : h.password ? "password" : "SSH agent"}</span>
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
					<input type="text" placeholder="Name (e.g. production)" value=${name} disabled=${saving} onInput=${(e) => setName(e.target.value)} />
					<input type="text" placeholder="Host or IP" value=${host} disabled=${saving} onInput=${(e) => setHost(e.target.value)} />
				</div>
				<div class="settings-form-row">
					<input type="text" autocomplete="username" placeholder="Username (optional)" value=${username} disabled=${saving} onInput=${(e) => setUsername(e.target.value)} />
					<input type="text" inputMode="numeric" placeholder="Port (22)" value=${port} disabled=${saving} style=${{ maxWidth: "100px" }} onInput=${(e) => setPort(e.target.value)} />
				</div>
				<div class="settings-row-label">Sign in with</div>
				<div class="settings-form-row">
					<button class="modal-btn${authMode === "agent" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("agent")}>SSH agent</button>
					<button class="modal-btn${authMode === "key" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("key")}>Private key</button>
					<button class="modal-btn${authMode === "password" ? " modal-btn-primary" : ""}" disabled=${saving} onClick=${() => setAuthMode("password")}>Password</button>
				</div>
				${authMode === "agent" ? html`<div class="settings-hint">Uses your system SSH configuration and agent. No credential is stored by cast.</div>` : null}
				${authMode === "key" ? html`<textarea class="settings-textarea" autocomplete="off" placeholder="Paste private key" value=${keyContent} disabled=${saving} onInput=${(e) => setKeyContent(e.target.value)} rows="4" />` : null}
				${
					authMode === "password"
						? html`<div class="settings-form-row"><input type="password" autocomplete="off" placeholder="Password (requires sshpass on this machine)" value=${password} disabled=${saving} onInput=${(e) => setPassword(e.target.value)} /></div>`
						: null
				}
				${formStatus ? html`<div class="settings-hint ${formStatus.ok ? "settings-ok" : "settings-error"}" role="status">${formStatus.message}</div>` : null}
				<div class="settings-form-row" style=${{ justifyContent: "flex-end" }}>
					<button class="modal-btn modal-btn-primary" disabled=${busy || saving || !name || !host} onClick=${addHost}>${saving ? "Adding…" : "Add host"}</button>
				</div>
			</div>
		</div>
	`;
}

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
	onLogout,
	open,
	confirm,
	sessionsLoaded,
	defaultModel,
	onResizeStart,
}) {
	const [personaOpen, setPersonaOpen] = useState(false);
	const [search, setSearch] = useState("");
	// null when there's no active search (show `sessions` as-is); an array
	// once a query has resolved, already filtered and ranked server-side by
	// GET /api/sessions?q= (core/session.ts's searchSessionSummaries — SQLite
	// FTS over full message history, not just title/persona/model). Debounced
	// the same way the in-session file search above it is (300ms).
	const [searchResults, setSearchResults] = useState(null);
	const searchTimerRef = useRef(null);
	useEffect(() => {
		clearTimeout(searchTimerRef.current);
		const q = search.trim();
		if (!q) {
			setSearchResults(null);
			return;
		}
		// clearTimeout above only cancels a timer that hasn't fired yet — once
		// a fetch is in flight (typing continued past the 300ms debounce while
		// a slower request from an earlier keystroke was still pending),
		// there's nothing to abort it. A slow response for a stale query could
		// otherwise land after a faster response for the current one and
		// silently overwrite it with results for text that's no longer in the
		// box. `cancelled` (closed over per effect run, flipped by cleanup the
		// moment `search` changes again) makes a stale response a no-op.
		let cancelled = false;
		searchTimerRef.current = setTimeout(() => {
			api("GET", `/api/sessions?q=${encodeURIComponent(q)}`)
				.then((data) => {
					if (!cancelled) setSearchResults(Array.isArray(data) ? data : []);
				})
				.catch(() => {
					if (!cancelled) setSearchResults([]);
				});
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(searchTimerRef.current);
		};
	}, [search]);
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
	// Search results already come back relevance-ranked from the server —
	// respect that order (don't re-sort into the pinned/running/date groups
	// below, which only make sense for "here's everything" browsing, not "did
	// you mean this specific session").
	const isSearching = search.trim().length > 0;
	const searching = isSearching && searchResults === null;
	const filtered = isSearching ? (searchResults ?? []) : sessions;
	const sessionGroups = isSearching ? [] : groupSessionsByDirectory(filtered);
	const isSandbox = cwd === SANDBOX_CWD;

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

	const renderItem = (s) => html`<${SidebarSessionItem}
		session=${s}
		activeId=${activeId}
		onSelect=${onSelectSession}
		onPin=${onPinSession}
		onDelete=${doDelete}
		onShare=${onShareSession}
		editingId=${editingId}
		editInputRef=${editInputRef}
		editValue=${editValue}
		setEditValue=${setEditValue}
		commitEdit=${commitEdit}
		cancelEdit=${() => setEditingId(null)}
		startEdit=${startEdit}
		menuFor=${menuFor}
		menuUpward=${menuUpward}
		openMenu=${openMenu}
		setMenuFor=${setMenuFor}
	/>`;
	const renderGroup = ([key, group]) => {
		const groupSessions = [...group.sessions].sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			return sortSessionsByActivity(a, b);
		});
		const fullPaths = [...group.paths].filter(Boolean);
		return html`
			<div key=${key} class="sidebar-session-group">
				<div class="sidebar-group-label" title=${fullPaths.join("\n")}>${group.label}</div>
				${groupSessions.map(renderItem)}
			</div>
		`;
	};

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
					${isSearching ? filtered.map(renderItem) : sessionGroups.map(renderGroup)}
					${!sessionsLoaded && html`<div class="sidebar-empty">Loading sessions…</div>`}
					${sessionsLoaded && searching && html`<div class="sidebar-empty">Searching…</div>`}
					${sessionsLoaded && !searching && sessionGroups.length === 0 && html`<div class="sidebar-empty">No sessions match "${search}"</div>`}
				</div>
			</div>
			<div class="sidebar-footer" title=${defaultModel || "No model selected"}>
				<span class="sidebar-footer-model">${defaultModel || "No model selected"}</span>
				<button class="sidebar-logout" onClick=${onLogout} aria-label="Log out" title="Log out">
					<${icons.arrowLeftOnRectangle} />
				</button>
			</div>
			<div class="sidebar-resize-handle" onPointerDown=${onResizeStart} aria-hidden="true" />
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
	if (typeof msg.seq === "number") return `seq:${msg.seq}`;
	let k = messageKeys.get(msg);
	if (k === undefined) {
		k = ++nextMessageKey;
		messageKeys.set(msg, k);
	}
	return k;
}

function mergeHistoryPage(previous, incoming) {
	if (!Array.isArray(incoming)) return previous;
	if (incoming.length === 0) return [];
	const firstSeq = incoming.find((message) => typeof message.seq === "number")?.seq;
	const before =
		typeof firstSeq === "number"
			? previous.filter((message) => typeof message.seq === "number" && message.seq < firstSeq)
			: [];
	const existing = new Map(
		previous.filter((message) => typeof message.seq === "number").map((message) => [message.seq, message]),
	);
	return [...before, ...incoming.map((message) => existing.get(message.seq) ?? message)];
}

// The "first-paint" animation for messages is handled entirely in CSS
// via the `.message-entering` class — the entrance `rise` keyframe
// fires on initial DOM mount and never again. Correct because every
// message and every streaming block is keyed by a stable identity (msg
// object identity via keyForMessage's WeakMap for settled messages,
// array index for streaming blocks), so a re-render reuses the same
// DOM node; the class is re-applied on each render but the browser
// only triggers the animation on the first mount. No JS-side tracking
// needed — the previous implementation put `animation: rise` on every
// `.message`/`.message-group` by default, which meant a streaming
// content block — whose parent re-renders on every RAF commit —
// replayed the fade-in on every commit, reading as a low-amplitude
// shimmer on the whole reply.

function App() {
	const [sessions, setSessions] = useState([]);
	const [sessionsLoaded, setSessionsLoaded] = useState(false);
	const [defaultModel, setDefaultModel] = useState("");
	const [activeId, setActiveId] = useState(null);
	const [session, setSession] = useState(null);
	const activeSessionIdRef = useRef(null);
	activeSessionIdRef.current = activeId;
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
	// Streaming state lives in LiveStreamingBlocks, so token commits never
	// reconcile the sidebar or full settled transcript.
	const streamingControllerRef = useRef(null);
	const updateStreaming = useCallback((event) => streamingControllerRef.current?.reduce(event), []);
	const resetStreamingNow = useCallback(() => streamingControllerRef.current?.reset(), []);
	const takeStreamingNow = useCallback(() => streamingControllerRef.current?.take() ?? [], []);
	const [running, setRunning] = useState(false);
	const [pendingSteers, setPendingSteers] = useState([]);
	const [pendingQueue, setPendingQueue] = useState([]);
	const [planTransition, setPlanTransition] = useState(null);
	const pendingPlanSignalRef = useRef(null);
	const planRefineArmedRef = useRef(false);
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
	const diffRequestVersionRef = useRef(0);
	const diffRefreshRafRef = useRef(null);
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
	const [inputsRefreshNonce, setInputsRefreshNonce] = useState(0);
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
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		try {
			const saved = Number(localStorage.getItem("cast:sidebarWidth"));
			return saved >= 272 && saved <= 420 ? saved : null;
		} catch {
			return null;
		}
	});
	useEffect(() => {
		if (!sidebarWidth) return;
		try {
			localStorage.setItem("cast:sidebarWidth", String(sidebarWidth));
		} catch {}
	}, [sidebarWidth]);
	// Dragged width, same persistence as diffOpen/diffTab above — otherwise
	// every reload snaps a manually-widened panel back to the CSS default.
	const [diffWidth, setDiffWidth] = useState(() => {
		try {
			const saved = Number(localStorage.getItem("cast:diffWidth"));
			return saved > 0 ? saved : null;
		} catch {
			return null;
		}
	});
	useEffect(() => {
		if (!diffWidth) return;
		try {
			localStorage.setItem("cast:diffWidth", String(diffWidth));
		} catch {}
	}, [diffWidth]);
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
	// Settings > Tools, defaults to "senior" server-side when never set.
	const [quickSessionPersona, setQuickSessionPersona] = useState("senior");
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
	// Any modal opening over a still-hovered header button would leave
	// that button's tooltip floating on top of the dialog — visually
	// confusing (a phantom label hovering over unrelated content) and
	// the only thing the user can do about it is jiggle the mouse, which
	// they may not do if they're moving the cursor toward a click target.
	// Closing any modal also fires this (back to null/false) — the
	// mouseleave the user produces by moving the cursor onto the modal
	// already hid the bubble, but the cleanup is harmless and the
	// intent is symmetric.
	useEffect(() => {
		if (settingsOpen || hotkeysOpen || dirPickerOpen || confirmState) tooltips.hide();
	}, [settingsOpen, hotkeysOpen, dirPickerOpen, confirmState]);
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
	const scrollStreamingFrame = useCallback(() => {
		requestAnimationFrame(() => {
			if (autoScrollRef.current && messagesRef.current)
				messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		});
	}, []);
	const autoScrollRef = useRef(true);
	const selfClosingRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const wasRunningRef = useRef(false);
	const sessionViewVersionRef = useRef(0);
	const draftVersionRef = useRef(0);
	const draftCommitsRef = useRef(new Map());
	const sessionsLoadVersionRef = useRef(0);
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
		const version = ++sessionsLoadVersionRef.current;
		try {
			const data = await api("GET", "/api/sessions");
			if (version === sessionsLoadVersionRef.current) setSessions(data);
		} catch {}
		if (version === sessionsLoadVersionRef.current) setSessionsLoaded(true);
	}, []);

	// Select session — `push` controls whether this lands as a new browser
	// history entry (a real click) or just replaces the current URL
	// (programmatic: initial bootstrap, reconnect recovery, popstate).
	const selectSession = useCallback(
		async (id, { push = true, prefetch = null } = {}) => {
			const version = ++sessionViewVersionRef.current;
			++draftVersionRef.current;
			try {
				// initClientState may already have this in flight — kicked off
				// alongside (not after) the personas/session-list calls when the
				// URL names a session up front, saving a full round trip on a
				// reload landing on ?session=<id>. Falls through to a normal fetch
				// for every other caller (sidebar clicks, popstate, ...).
				const data = prefetch ? await prefetch : await api("GET", `/api/sessions/${id}`);
				if (!data) throw new Error("Not found");
				if (version !== sessionViewVersionRef.current) return;
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
				setRunning(data.status === "running");
				wasRunningRef.current = data.status === "running";
				setSidebarOpen(false);
				try {
					localStorage.setItem("cast:lastSessionId", id);
				} catch {}
				setUrlSessionId(id, { push });
				undismiss(id);
			} catch (err) {
				if (version === sessionViewVersionRef.current) showToast(err.message, "error");
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
		async (persona, cwd, { push = true, draftVersion } = {}) => {
			const create = async () => api("POST", "/api/sessions", { persona, cwd });
			const pending = draftVersion == null ? create() : (draftCommitsRef.current.get(draftVersion) ?? create());
			if (draftVersion != null) draftCommitsRef.current.set(draftVersion, pending);
			let data;
			try {
				data = await pending;
			} finally {
				if (draftVersion != null && draftCommitsRef.current.get(draftVersion) === pending) {
					draftCommitsRef.current.delete(draftVersion);
				}
			}
			if (draftVersion != null && draftVersion !== draftVersionRef.current) return data.id;
			++sessionViewVersionRef.current;
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
			void loadSessions();
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
			++sessionViewVersionRef.current;
			const draftVersion = ++draftVersionRef.current;
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
				draftVersion,
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
				personasRef.current = sortedPersonas;
				api("GET", "/api/commands")
					.then((c) => c && setCommands(c))
					.catch(() => {});
				Promise.all([api("GET", "/api/themes"), api("GET", "/api/config")])
					.then(([t, cfg]) => {
						// The model belongs to app config, not the theme request. Keep
						// it available for the new-session footer independently.
						if (cfg) {
							setDefaultCwd(cfg.cwd ?? "");
							setDefaultModel(cfg.model ?? "");
							if (cfg.quickSessionPersona) setQuickSessionPersona(cfg.quickSessionPersona);
						}
						if (!t) return;
						setThemes(t);
						const current = t.find((x) => x.id === cfg?.theme) ?? t.find((x) => x.id === "cast");
						if (current) {
							applyTheme(current.colors);
							setCurrentThemeId(current.id);
						}
					})
					.catch(() => {});
				staticResourcesLoadedRef.current = true;
			}

			const s = await api("GET", "/api/sessions");
			if (!s) return false;
			setSessions(s);
			setSessionsLoaded(true);
			if (urlId && s.find((x) => x.id === urlId)) {
				// A session is restored only when the URL explicitly names it. The
				// bare root is a deliberate fresh draft, never an implicit return to
				// a previous agent's cwd, model, or conversation.
				await selectSession(urlId, { push: false, prefetch: sessionPrefetch });
			} else {
				if (urlId) showToast("Session not found — started a new session", "error");
				const current = personasRef.current;
				const defaultP = current.find((x) => x.name === "senior") ?? current[0];
				if (defaultP) startDraft(defaultP.name, undefined);
			}
			return true;
		} catch {
			return false;
		}
	}, [selectSession, showToast, startDraft]);

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
			const defaultP = personas.find((x) => x.name === "senior") ?? personas[0];
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
		const sidebarWidthNow = document.querySelector(".sidebar")?.getBoundingClientRect().width ?? 0;
		const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
		const maxWidth = Math.max(
			320,
			Math.min(Math.round(window.innerWidth * 0.85), window.innerWidth - sidebarWidthNow - minChatWidth),
		);
		const next = Math.min(Math.max(st.startWidth + delta, 320), maxWidth);
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

	// Sidebar drag-to-resize mirrors the diff panel: desktop-only, bounded so
	// the chat remains usable, and persisted independently of the collapsed
	// state so reopening restores the user's chosen width.
	const sidebarDragStateRef = useRef(null);
	const onSidebarResizeMove = useCallback(
		(e) => {
			const st = sidebarDragStateRef.current;
			if (!st) return;
			const diffWidthNow = diffOpen
				? (document.querySelector(".diff-panel")?.getBoundingClientRect().width ?? 0)
				: 0;
			const minChatWidth = window.innerWidth <= 1100 ? 280 : 320;
			const maxWidth = Math.max(
				272,
				Math.min(420, Math.round(window.innerWidth * 0.45), window.innerWidth - diffWidthNow - minChatWidth),
			);
			setSidebarWidth(Math.min(Math.max(st.startWidth + e.clientX - st.startX, 272), maxWidth));
		},
		[diffOpen],
	);
	const onSidebarResizeEnd = useCallback(() => {
		sidebarDragStateRef.current = null;
		document.body.classList.remove("resizing-sidebar");
		window.removeEventListener("pointermove", onSidebarResizeMove);
	}, [onSidebarResizeMove]);
	const startSidebarResize = useCallback(
		(e) => {
			if (window.innerWidth <= 768) return;
			e.preventDefault();
			const sidebar = document.querySelector(".sidebar");
			sidebarDragStateRef.current = {
				startX: e.clientX,
				startWidth: sidebar?.getBoundingClientRect().width ?? sidebarWidth ?? 272,
			};
			document.body.classList.add("resizing-sidebar");
			window.addEventListener("pointermove", onSidebarResizeMove);
			window.addEventListener("pointerup", onSidebarResizeEnd, { once: true });
		},
		[sidebarWidth, onSidebarResizeMove, onSidebarResizeEnd],
	);

	// Submit message
	const submitMessage = useCallback(
		async (text, images, pendingDocs) => {
			if (planRefineArmedRef.current && !text.trim().startsWith("/")) {
				planRefineArmedRef.current = false;
				text = `The user wants to refine the plan. Update it using this feedback:\n\n${text}`;
			}
			const draftVersion = session?.isDraft ? session.draftVersion : null;
			const isCurrentDraft = () => draftVersion == null || draftVersion === draftVersionRef.current;
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

			// Deferred documents from a draft session — upload them now that we
			// have (or are about to create) a real session id.
			let finalText = text;
			let id = activeId;
			if (pendingDocs && pendingDocs.length > 0) {
				// Must commit the session before uploading — the server needs a
				// real session id for the inputs directory.
				if (!id) {
					if (session?.isDraft) {
						try {
							id = await commitSession(session.persona, session.cwd, { push: true, draftVersion });
						} catch (err) {
							showToast(err.message, "error");
							return;
						}
					} else {
						showToast("Still connecting — try again in a moment", "error");
						return;
					}
				}
				const paths = [];
				for (const doc of pendingDocs) {
					try {
						const result = await api("POST", `/api/sessions/${id}/inputs/upload`, {
							name: doc.name,
							dataUrl: doc.dataUrl,
						});
						paths.push({ name: result.name, path: result.path });
					} catch (err) {
						showToast(`Failed to upload ${doc.name}: ${err.message}`, "error");
						// Still send the message without the failed file
					}
				}
				// Rebuild the system-reminder with real server-side paths —
				// replaces the placeholder text the composer stashed.
				if (paths.length > 0) {
					const userText = text.replace(/\n\n<system-reminder>[\s\S]*<\/system-reminder>/, "").trim();
					finalText =
						userText +
						`\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n` +
						paths.map((p) => `- ${p.name}: ${p.path}`).join("\n") +
						`\n</system-reminder>`;
				}
				// Refresh the Inputs panel now that files are on disk
				setInputsRefreshNonce((n) => n + 1);
			}

			// The composer is enabled for a local-only draft (see startDraft) as
			// well as a real session — this is the one place a draft ever turns
			// into an actual backend session, exactly when it gets its first
			// real content, same as ChatGPT's "new chat" only existing once you
			// send something into it.
			if (!id) {
				if (session?.isDraft) {
					try {
						id = await commitSession(session.persona, session.cwd, { push: true, draftVersion });
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
			if (finalText.startsWith("/")) {
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
						setDefaultModel(result.result.model);
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
			// though the round trip to localhost is fast. Rendered the same shape
			// toDisplayMessages produces (content: text, images: [...]) so a page
			// reload looks identical to what was just shown live.
			setSession((prev) =>
				prev?.id === id && isCurrentDraft()
					? {
							...prev,
							messages: [
								...prev.messages,
								{ role: "user", content: finalText, ...(images?.length ? { images } : {}) },
							],
						}
					: prev,
			);
			try {
				await api(
					"POST",
					`/api/sessions/${id}/chat`,
					images?.length ? { text: finalText, images } : { text: finalText },
				);
				// Picks up the auto-derived title after a session's first message
				// (and keeps the sidebar's message counts from drifting stale).
				loadSessions();
			} catch (err) {
				if (isCurrentDraft()) showToast(err.message, "error");
			}
		},
		[activeId, session, commitSession, loadSessions, selectSession, showToast, toggleDiff, addNotice],
	);

	const handlePlanTransition = useCallback(
		async (choice) => {
			const transition = planTransition ?? session?.planTransition;
			const transitionSessionId = transition?.sessionId ?? activeId;
			if (!transition || !transitionSessionId) return;
			if (choice === "cancel") {
				if (transition.kind === "done") addNotice("Staying in plan mode — describe what to change");
				return;
			}
			const recordChoice = async (text) => {
				await api("POST", `/api/sessions/${transitionSessionId}/command`, { command: `/plan-note ${text}` });
			};
			try {
				await api("POST", `/api/sessions/${transitionSessionId}/plan-transition`, { kind: transition.kind });
				setPlanTransition(null);
				setSession((prev) => (prev ? { ...prev, planTransition: undefined } : prev));
				if (choice === "continue") {
					await recordChoice("Plan: continue planning");
					planRefineArmedRef.current = true;
					addNotice("Plan: keep planning — add feedback below");
					return;
				}
				let originalTask;
				if (choice === "clean") {
					const result = await api("POST", `/api/sessions/${transitionSessionId}/clean-context`);
					originalTask = result.originalTask;
				}
				await api("POST", `/api/sessions/${transitionSessionId}/command`, { command: "/build" });
				setSession((prev) => (prev?.id === transitionSessionId ? { ...prev, mode: "build" } : prev));
				if (choice !== "clean") await recordChoice("Plan: approved — implement in Build");
				await submitMessage(
					choice === "clean"
						? `<system-reminder>Clean build context. Original task: ${originalTask ?? "Use the approved plan as the task definition."}</system-reminder>\n\nThe plan is approved. Implement it step by step.`
						: "<system-reminder>Plan: approved — start implementation in Build.</system-reminder>\n\nImplement it step by step.",
				);
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, planTransition, session?.planTransition, submitMessage, addNotice, showToast],
	);

	const answerQuestion = useCallback(
		async (values) => {
			if (!activeId || !session?.question) return;
			try {
				await api("POST", `/api/sessions/${activeId}/question`, { values });
				setSession((prev) => (prev ? { ...prev, question: undefined } : prev));
			} catch (err) {
				showToast(err.message, "error");
			}
		},
		[activeId, session?.question, showToast],
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
		const sessionId = activeId;
		const version = ++diffRequestVersionRef.current;
		try {
			const data = await api("GET", `/api/sessions/${sessionId}/diff`);
			if (version === diffRequestVersionRef.current && activeSessionIdRef.current === sessionId) setDiffData(data);
		} catch {
			if (version === diffRequestVersionRef.current && activeSessionIdRef.current === sessionId)
				setDiffData({ files: [] });
		}
	}, [activeId]);
	const queueDiffRefresh = useCallback(() => {
		if (!diffOpenRef.current || diffRefreshRafRef.current != null) return;
		diffRefreshRafRef.current = requestAnimationFrame(() => {
			diffRefreshRafRef.current = null;
			loadDiff();
			setFsRefreshNonce((n) => n + 1);
		});
	}, [loadDiff]);

	// SSE
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop). diffOpen is deliberately not a dependency — see diffOpenRef above; making it one would tear down and reopen the EventSource (full refetch, full message remount) on every diff-panel toggle.
	useEffect(() => {
		if (!activeId) return;
		if (esRef.current) esRef.current.close();

		const streamSessionId = activeId;
		const es = new EventSource(`${window.location.origin}/api/sessions/${streamSessionId}/events`);
		esRef.current = es;
		setConnected(true);
		const isCurrent = () => esRef.current === es && activeSessionIdRef.current === streamSessionId;

		es.onopen = () => {
			if (!isCurrent()) return;
			setConnected(true);
			// Refetch session state on reconnect — the server may have
			// advanced while we were disconnected (e.g. mobile tab was
			// backgrounded). This catches messages missed between the last
			// SSE event we received and the reconnect.
			api("GET", `/api/sessions/${streamSessionId}`)
				.then((data) => {
					if (!data || !isCurrent()) return;
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
						if (prev.id !== data.id) return prev;
						return {
							...data,
							messages: mergeHistoryPage(prev.messages, data.messages || []),
						};
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
			if (!isCurrent()) return;
			try {
				const event = JSON.parse(e.data);
				switch (event.type) {
					case "user_message": {
						// Another tab sent a user message — add it to our local state.
						// The wire event's content is the raw send shape (a string, or
						// an array with a text part + image_url parts when images were
						// attached — see bridge.ts's buildUserContent); the optimistic
						// local append below instead uses the toDisplayMessages shape
						// (content: text, images: [...]). Normalize both before
						// comparing so a caption+photo send doesn't fail this dedup
						// check (array !== string) and land twice in the sending tab.
						const normalize = (content) => {
							if (typeof content === "string") return { text: content, images: [] };
							if (Array.isArray(content)) {
								return {
									text: content.find((p) => p.type === "text")?.text ?? "",
									images: content.filter((p) => p.type === "image_url").map((p) => p.image_url.url),
								};
							}
							return { text: "", images: [] };
						};
						setSession((prev) => {
							if (!prev) return prev;
							const msgs = prev.messages;
							const last = msgs[msgs.length - 1];
							if (last && last.role === "user") {
								const a = { text: last.content, images: last.images ?? [] };
								const b = normalize(event.message.content);
								if (a.text === b.text && a.images.length === b.images.length) return prev;
							}
							const evt = normalize(event.message.content);
							return {
								...prev,
								messages: [
									...msgs,
									{ role: "user", content: evt.text, ...(evt.images.length ? { images: evt.images } : {}) },
								],
							};
						});
						break;
					}
					case "status": {
						const isRunning = event.status === "running";
						setRunning(isRunning);
						setSession((prev) =>
							prev
								? {
										...prev,
										status: event.status,
										turnStartedAt: isRunning ? (event.startedAt ?? prev.turnStartedAt) : null,
									}
								: prev,
						);
						// If the run ended between our initial GET and the SSE
						// connect, we missed the `end` event. The `session_end`
						// event (which follows `status: idle`) carries usage and
						// messageCount — it handles the refetch when counts diverge.
						wasRunningRef.current = isRunning;
						break;
					}
					case "token":
						updateStreaming({ type: "content", text: event.text });
						break;
					case "thinking":
						updateStreaming({ type: "thinking", text: event.text });
						break;
					case "tool_start":
						updateStreaming({
							type: "tool_start",
							call: { id: event.id, name: event.name, args: event.args, status: event.status },
						});
						break;
					case "tool_end":
						updateStreaming({
							type: "tool_end",
							id: event.id,
							status: event.status,
							result: event.result?.content ?? "",
							...(event.result?.imageDataUrl ? { images: [event.result.imageDataUrl] } : {}),
						});
						if (diffOpenRef.current) {
							queueDiffRefresh();
						}
						if (!event.result?.isError && event.name === "plan_done") {
							const transition = {
								kind: "done",
								sessionId: streamSessionId,
							};
							pendingPlanSignalRef.current = transition;
							setSession((prev) => (prev ? { ...prev, planTransition: transition } : prev));
						}
						if (!event.result?.isError && event.name === "question") {
							try {
								const question = JSON.parse(event.result.content);
								if (question.question) {
									setSession((prev) => (prev ? { ...prev, question } : prev));
								}
							} catch {
								// A malformed tool result stays visible in the transcript; it cannot open a picker.
							}
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
							if (prevStreaming.length > 0) {
								return { ...prev, messages: [...prev.messages, { role: "assistant", blocks: prevStreaming }] };
							}
							const blocks = blocksFromAssistantCompletion(event);
							if (blocks.length === 0) return prev;
							return { ...prev, messages: [...prev.messages, { role: "assistant", blocks }] };
						});
						break;
					}
					case "end":
						resetStreamingNow();
						setRunning(false);
						setSession((prev) => (prev ? { ...prev, status: "idle" } : prev));
						setPendingSteers([]);
						setPendingQueue([]);
						if (pendingPlanSignalRef.current?.sessionId === streamSessionId) {
							setPlanTransition(pendingPlanSignalRef.current);
							pendingPlanSignalRef.current = null;
						}
						break;
					case "turn_meta":
						// Fires once, right after the "assistant_message" event that
						// pushed this turn's concluding reply — attach to that (now
						// last) message so it's per-reply, persisted, and correct on
						// reload, instead of a page-level "last turn" singleton.
						setSession((prev) => {
							if (!prev || prev.messages.length === 0) return prev;
							const messages = prev.messages.slice();
							const i = messages.length - 1;
							messages[i] = {
								...messages[i],
								turnMeta: { provider: event.provider, model: event.model, totalMs: event.totalMs },
							};
							return { ...prev, messages };
						});
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
							api("GET", `/api/sessions/${streamSessionId}`)
								.then((d) => {
									if (!d || !isCurrent()) return;
									setSession((inner) => {
										if (!inner || inner.id !== streamSessionId) return inner;
										return {
											...inner,
											messages: mergeHistoryPage(inner.messages, d.messages || []),
											usage: d.usage,
											updatedAt: d.updatedAt,
										};
									});
								})
								.catch(() => {});
							return { ...prev, usage: event.usage };
						});
						break;
					case "plan_decision":
						setSession((prev) =>
							prev
								? { ...prev, messages: [...prev.messages, { role: "warning", content: event.content }] }
								: prev,
						);
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
			if (!isCurrent()) return;
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
	}, [activeId, reconnectNonce, startReconnectLoop, addNotice, queueDiffRefresh, showToast]);

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
	}, [session?.messages]);

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
				const p = personas.find((x) => x.name === "senior") ?? personas[0];
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

	const messages = useMemo(() => {
		const raw = session?.messages?.filter((m) => m.role !== "system") || [];
		const processed = [];
		let pendingAttachments = null;
		for (const m of raw) {
			if (m.role === "user") {
				const content = typeof m.content === "string" ? m.content : "";
				const reminderRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
				const attachments = [...(pendingAttachments ?? [])];
				// History loaded via REST may still carry inline <system-reminder>
				// (the bridge strips them only for SSE, not for the REST API).
				// Also extract from the warning the server split off — those
				// arrive as a separate "warning" message right before the user
				// message. We stash them in pendingAttachments and attach here.
				let cleaned = content;
				let match = reminderRe.exec(content);
				while (match !== null) {
					for (const line of match[1].split("\n")) {
						const fileMatch = line.match(/^- (.+?): (.+)$/);
						if (fileMatch) attachments.push({ name: fileMatch[1], path: fileMatch[2] });
					}
					cleaned = cleaned.replace(match[0], "");
					match = reminderRe.exec(content);
				}
				cleaned = cleaned.trim();
				pendingAttachments = null;
				processed.push({
					...m,
					content: cleaned,
					attachments: attachments.length > 0 ? attachments : undefined,
				});
			} else if (
				m.role === "warning" &&
				typeof m.content === "string" &&
				m.content.includes("The user attached the following file(s)")
			) {
				// Extract file names from the warning and stash them for the
				// next user message — the server splits these out before the
				// user message, so we carry them forward instead of showing
				// a redundant "[system]" notice in the chat.
				const lines = m.content.split("\n");
				const files = [];
				for (const line of lines) {
					const fm = line.match(/^- (.+?): (.+)$/);
					if (fm) files.push({ name: fm[1], path: fm[2] });
				}
				if (files.length > 0) pendingAttachments = files;
			} else {
				pendingAttachments = null;
				processed.push(m);
			}
		}
		return processed;
	}, [session?.messages]);
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
	const minChatWidth = typeof window !== "undefined" && window.innerWidth <= 1100 ? 280 : 320;
	const diffMaxWidth =
		typeof window === "undefined"
			? null
			: Math.max(
					320,
					Math.min(
						Math.round(window.innerWidth * 0.85),
						window.innerWidth - (sidebarCollapsed ? 0 : (sidebarWidth ?? 272)) - minChatWidth,
					),
				);
	const boundedDiffWidth = diffWidth && diffMaxWidth ? Math.min(diffWidth, diffMaxWidth) : diffWidth;
	const sidebarMaxWidth =
		typeof window === "undefined"
			? 420
			: Math.max(
					272,
					Math.min(
						420,
						Math.round(window.innerWidth * 0.45),
						window.innerWidth - (diffOpen ? (boundedDiffWidth ?? 0) : 0) - minChatWidth,
					),
				);
	if (sidebarCollapsed) appStyle["--sidebar-col"] = "0px";
	else if (sidebarWidth) appStyle["--sidebar-col"] = `${Math.min(sidebarWidth, sidebarMaxWidth)}px`;
	if (diffOpen && boundedDiffWidth) appStyle["--diff-w"] = `${boundedDiffWidth}px`;

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
						<${icons.keyboard} />
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
				onLogout=${async () => {
					await fetch("/api/auth/logout", { method: "POST" });
					window.location.assign("/login");
				}}
				open=${sidebarOpen}
				sessionsLoaded=${sessionsLoaded}
				defaultModel=${defaultModel}
				onResizeStart=${startSidebarResize}
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
					onModelChange=${setDefaultModel}
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
						html`
						<div class="empty-state">
							<${CastLogo} class="empty-state-banner" />
							<p class="empty-state-title">Ready when you are</p>
							<p class="empty-state-hint">Send a message, or type <code>/</code> to see what this agent can do.</p>
						</div>
					`
					}
					${messages.map((msg) => html`<${Message} key=${keyForMessage(msg)} msg=${msg} />`)}
					<${LiveStreamingBlocks} controllerRef=${streamingControllerRef} onFrame=${scrollStreamingFrame} />
					${
						!running &&
						html`
							<${PlanDecisionCard} transition=${session?.planTransition ?? planTransition} onChoose=${handlePlanTransition} />
							${session?.question && html`<${QuestionCard} question=${session.question} onChoose=${answerQuestion} />`}
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
						<${ElapsedTimer} key=${activeId} running=${running} connected=${connected} turnStartedAt=${session?.turnStartedAt} />
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
				<${Composer} running=${running} ready=${!!session} activeId=${activeId} commands=${commands} personas=${personas} onSubmit=${submitMessage} onAbort=${abortRun} onDocUploaded=${() => setInputsRefreshNonce((n) => n + 1)} />
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
			<${DiffPanel} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onResizeStart=${startDiffResize} open=${diffOpen} activeId=${activeId} tab=${diffTab} onTabChange=${setDiffTab} confirm=${requestConfirm} fsRefreshNonce=${fsRefreshNonce} inputsRefreshNonce=${inputsRefreshNonce} bootstrapping=${bootstrapping} />
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
				<div class="shared-view-loading">
					<div class="loading-spinner" />
				</div>
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
const tooltips = initTooltips();
render(
	sharedToken ? html`<${SharedThreadView} token=${sharedToken} />` : html`<${App} />`,
	document.getElementById("app"),
);
