/**
 * cast server — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { CastLogo } from "./cast-logo.js";
import { Composer as ComposerModule } from "./composer.js";
import { Dashboard as DashboardModule } from "./dashboard.js";
import { DiffPanel as DiffPanelModule } from "./diff-panel.js";
import { DirectoryBrowser } from "./directory-browser.js";
import { ElapsedTimer } from "./elapsed-timer.js";
import { FileExplorer as FileExplorerModule } from "./file-explorer.js";
import { hotkeysHtml, modKey } from "./hotkeys.js";
import { icons } from "./icons.js";
import { InputsExplorer as InputsExplorerModule } from "./inputs-explorer.js";
import { MemoryExplorer as MemoryExplorerModule } from "./memory-explorer.js";
import { Message as MessageModule } from "./message.js";
import { submitMessage as submitMessageRequest } from "./message-submit.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { NewSessionModal } from "./new-session-modal.js?v=__NSM_HASH__";
import { PlanDecisionCard, QuestionCard } from "./plan-cards.js";
import { SettingsAppearance } from "./settings-appearance.js";
import { SettingsModal as SettingsModalModule } from "./settings-modal.js";
import { SettingsModel } from "./settings-model.js";
import {
	SettingsBash,
	SettingsHooks,
	SettingsMarketplace,
	SettingsMemory,
	SettingsMcp,
	SettingsPlugins,
	SettingsPersonas,
	SettingsProvider,
	SettingsQuickMode,
	SettingsServer,
	SettingsSkills,
	SettingsSkillssh,
	SettingsSsh,
	SettingsWeb,
} from "./settings-panels.js";
import { ShareModal } from "./share-modal.js";
import { Sidebar as SidebarModule } from "./sidebar.js";
import { closeSseConnection, openSseConnection } from "./sse-connection.js";
import { handleSseEvent } from "./sse-events.js";
import { StatusPopover } from "./status-popover.js";
import { LiveStreamingBlocks as LiveStreamingBlocksModule } from "./streaming-blocks.js";
import { usePanelResize } from "./use-panel-resize.js";
import { useSessionController } from "./use-session-controller.js";
import { useSessionState } from "./use-session-state.js";
import { useWorkspaceState } from "./use-workspace-state.js";

const TRAILING_NL_RE = /\n$/;
const TRAILING_PUNCTUATION_RE = /[.,!?;:]$/;
const NEWLINE_RUN_RE = /\n+/;
const MARKDOWN_LIST_MARKER_RE = /^[ \t]*[-*] /;
const NUMBERED_LIST_MARKER_RE = /^[ \t]*\d+\. /;
const TABLE_SEPARATOR_RE = /^\|\s*[-:]+[-| :]*$/;
const FRONTMATTER_LINE_RE = /^- (.+?): (.+)$/;

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
	// connection or a non-default theme.
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

const markdownCache = new Map();
const MARKDOWN_CACHE_LIMIT = 300;
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
// Dedicated SPA routes: /settings and /dashboard get their own paths (served
// as index.html server-side) so each is navigable and survives back/forward,
// while the chat view below them stays mounted — the session's SSE stream and
// live turn are untouched by navigation. The ?session= query rides along on
// every route so a dashboard/settings link keeps its session context.
function viewFromPath() {
	const p = window.location.pathname;
	if (p === "/settings") return "settings";
	if (p === "/dashboard") return "dashboard";
	return "chat";
}
// ── Components ───────────────────────────────────────────────────────

// for why they live in a global, session-scoped directory instead of inside
// the project's own cwd. No tree/search/rename like FileExplorer below:
// attachments aren't expected to have subdirectories, so there's nothing to
// expand or navigate, only a list to download/preview/remove from.
// Read/download/delete view of the session's actual working directory — the
// Changes tab above only shows uncommitted git diffs, which is empty (or
// wrong) the moment something's been committed, or the cwd isn't a git repo
// at all. This reads the real filesystem directly, so it works regardless.
// Lazily loads one directory at a time (no .gitignore filtering, so an eager
// full walk could mean tens of thousands of node_modules entries) and always
// hides .git itself.

// The small "i" description popover and the "book" full-content viewer
// (readUrl — currently only SKILL.md, always markdown) are different enough
// in scale that they get different chrome: a short description stays a
// small anchored popover, but a whole document reuses the exact same
// modal-preview treatment (size, markdown rendering) as the Files panel's
// file preview, so "read the full skill" looks the same wherever it's
// triggered from instead of being its own smaller, plain-text-only thing.

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
	const incomingClientIds = new Set(incoming.map((message) => message.clientMessageId).filter(Boolean));
	const pending = previous.filter(
		(message) => message.pending === true && !incomingClientIds.has(message.clientMessageId),
	);
	if (incoming.length === 0) return pending;
	const firstSeq = incoming.find((message) => typeof message.seq === "number")?.seq;
	const before =
		typeof firstSeq === "number"
			? previous.filter((message) => typeof message.seq === "number" && message.seq < firstSeq)
			: [];
	const existing = new Map(
		previous.filter((message) => typeof message.seq === "number").map((message) => [message.seq, message]),
	);
	return [...before, ...incoming.map((message) => existing.get(message.seq) ?? message), ...pending];
}

function HistoryBoundary({ status, atEnd, onRetry }) {
	if (status === "loading") {
		return h(
			"div",
			{ class: "history-boundary history-boundary-loading", role: "status", "aria-live": "polite" },
			h("span", { class: "history-boundary-spinner", "aria-hidden": "true" }),
			h("span", null, "Loading older messages…"),
		);
	}
	if (status === "error") {
		return h(
			"div",
			{ class: "history-boundary history-boundary-loading", role: "status", "aria-live": "polite" },
			h("button", { class: "history-boundary-retry", onClick: onRetry }, "Retry loading older messages"),
		);
	}
	if (atEnd) {
		return h("div", { class: "history-boundary", role: "status", "aria-live": "polite" }, "Beginning of thread");
	}
	return null;
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
	const {
		sessions,
		setSessions,
		sessionsLoaded,
		setSessionsLoaded,
		defaultModel,
		setDefaultModel,
		activeId,
		setActiveId,
		session,
		setSession,
		activeSessionIdRef,
		personas,
		setPersonas,
		commands,
		setCommands,
		running,
		setRunning,
		pendingSteers,
		setPendingSteers,
		pendingQueue,
		setPendingQueue,
		planTransition,
		setPlanTransition,
		pendingPlanSignalRef,
		planRefineArmedRef,
	} = useSessionState();
	// Earliest send time among in-flight (pending) user messages — lets the
	// composer timer start the moment the user hits send, before the daemon's
	// status:running round-trip (no "sending…" label in the transcript).
	const pendingSince = (session?.messages ?? []).reduce(
		(acc, m) => (m.role === "user" && m.pending && typeof m.pendingAt === "number" ? Math.min(acc, m.pendingAt) : acc),
		Infinity,
	);
	const pendingSinceMs = Number.isFinite(pendingSince) ? pendingSince : undefined;
	// Re-fetched per active session (not just once at boot) because the list
	// now includes one live slash-command entry per loaded, enabled skill —
	// those vary by session cwd and change after /reload, so a stale one-shot
	// fetch would leave the palette missing/showing skills that no longer
	// match reality.
	const refreshCommands = useCallback(
		async (id) => {
			const c = await api("GET", `/api/commands${id ? `?session=${encodeURIComponent(id)}` : ""}`).catch(() => null);
			if (c) setCommands(c);
		},
		[setCommands],
	);
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
	// /reasoning-display toggle — reasoning models (MiniMax-M3, etc.) stream a
	// lot of auxiliary thinking that just clutters the chat. Persisted to
	// localStorage so the choice survives reloads; the web UI opens a single
	// chat at a time, so this toggle spans whichever session is active. The
	// default is off — explicit opt-in via the toggle (or the Appearance
	// panel's Reasoning section).
	const [showReasoning, setShowReasoning] = useState(() => {
		try {
			return localStorage.getItem("cast:showReasoning") === "1";
		} catch {
			return false;
		}
	});
	// Sync the initial value from settings.json (written by /rd in TUI). The
	// localStorage above gives a synchronous first render; the fetch corrects
	// it if TUI and web diverged. Empty-dep effect — runs once on mount.
	useEffect(() => {
		fetch("/api/settings/appearance")
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (data && typeof data.showReasoning === "boolean") {
					setShowReasoning(data.showReasoning);
					try {
						localStorage.setItem("cast:showReasoning", data.showReasoning ? "1" : "0");
					} catch {}
				}
			})
			.catch(() => {
				/* offline / no-server — keep localStorage value */
			});
	}, []);
	const toggleShowReasoning = useCallback(() => {
		setShowReasoning((prev) => {
			const next = !prev;
			try {
				localStorage.setItem("cast:showReasoning", next ? "1" : "0");
			} catch {
				// localStorage may be unavailable (private mode, quota); the
				// toggle still applies in-memory, just won't persist.
			}
			// Persist to settings.json so TUI picks it up on next launch.
			fetch("/api/settings/appearance", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ showReasoning: next }),
			}).catch(() => {
				/* fire-and-forget, toggle still applies */
			});
			return next;
		});
	}, []);
	// Streaming state lives in LiveStreamingBlocks, so token commits never
	// reconcile the sidebar or full settled transcript.
	const streamingControllerRef = useRef(null);
	const streamingEventVersionRef = useRef(0);
	const updateStreaming = useCallback((event) => {
		streamingEventVersionRef.current += 1;
		streamingControllerRef.current?.reduce(event);
	}, []);
	const resetStreamingNow = useCallback(() => streamingControllerRef.current?.reset(), []);
	const takeStreamingNow = useCallback(() => streamingControllerRef.current?.take() ?? [], []);
	const hydrateStreamingNow = useCallback((blocks) => streamingControllerRef.current?.hydrate(blocks), []);
	// Open/closed and which tab, like theme/font below, survive a page
	// reload via localStorage — losing "I had Files open" on every refresh
	// (or worse, having to reload while it was mid-task) was just annoying.
	const {
		diffOpen,
		setDiffOpen,
		diffData,
		setDiffData,
		diffRequestVersionRef,
		diffRefreshRafRef,
		diffFile,
		setDiffFile,
		diffTab,
		setDiffTab,
		fsRefreshNonce,
		setFsRefreshNonce,
		inputsRefreshNonce,
		setInputsRefreshNonce,
		sidebarOpen,
		setSidebarOpen,
		sidebarCollapsed,
		setSidebarCollapsed,
		sidebarWidth,
		setSidebarWidth,
		diffWidth,
		setDiffWidth,
		toasts,
		setToasts,
		connected,
		setConnected,
		backendUp,
		setBackendUp,
		bootstrapping,
		setBootstrapping,
		atBottom,
		setAtBottom,
		defaultCwd,
		setDefaultCwd,
		quickSessionPersona,
		setQuickSessionPersona,
		memoryEnabled,
		setMemoryEnabled,
		selectedCwd,
		setSelectedCwd,
		dirPickerOpen,
		setDirPickerOpen,
		hotkeysOpen,
		setHotkeysOpen,
		settingsOpen,
		setSettingsOpen,
		confirmState,
		setConfirmState,
	} = useWorkspaceState();
	// Dashboard is a local toggle (not persisted) — a separate full-screen
	// analytics view swapped in place of the chat area. Settings and the
	// dashboard are now dedicated routes (/settings, /dashboard); the open
	// flags are derived from the current path so navigation and browser
	// back/forward stay in sync with what's shown.
	const [dashboardOpen, setDashboardOpen] = useState(false);
	const applyView = useCallback(
		(next) => {
			setDashboardOpen(next === "dashboard");
			setSettingsOpen(next === "settings");
		},
		[setDashboardOpen, setSettingsOpen],
	);
	const navigate = useCallback(
		(path) => {
			if (window.location.pathname + window.location.search === path) return;
			window.history.pushState(null, "", path);
			applyView(viewFromPath());
		},
		[applyView],
	);
	const goHome = useCallback(() => {
		navigate("/" + (activeId ? `?session=${activeId}` : ""));
	}, [navigate, activeId]);
	useEffect(() => {
		applyView(viewFromPath());
		const onPop = () => applyView(viewFromPath());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, [applyView]);
	const requestConfirm = useCallback(
		(message) => new Promise((resolve) => setConfirmState({ message, resolve })),
		[setConfirmState],
	);
	const cwd = selectedCwd ?? defaultCwd ?? "";
	useEffect(() => {
		if (!memoryEnabled && diffTab === "memory") setDiffTab("changes");
	}, [memoryEnabled, diffTab, setDiffTab]);

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
	// A draft becomes a real session and can submit its first message before
	// the active-session effect has opened EventSource. Keep a small waiter so
	// message-submit can close that gap without blocking forever if the backend
	// is temporarily unavailable.
	const sessionStreamWaitersRef = useRef(new Map());
	const messagesRef = useRef(null);
	const _scrollStreamingFrame = useCallback(() => {
		requestAnimationFrame(() => {
			if (autoScrollRef.current && messagesRef.current)
				messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		});
	}, []);
	const autoScrollRef = useRef(true);
	const selfClosingRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const staticResourcesLoadedRef = useRef(false);
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
	// Outgoing chat is kept here until the daemon acknowledges the request. A
	// ref avoids making reconnect bookkeeping itself re-render the whole app.
	const pendingOutgoingRef = useRef(new Map());
	const loadingOlderRef = useRef(false);
	const [olderHistoryStatus, setOlderHistoryStatus] = useState(null);
	const olderHistoryStatusForSession =
		olderHistoryStatus?.sessionId === activeId ? olderHistoryStatus.status : null;
	useEffect(() => {
		setOlderHistoryStatus(null);
	}, [activeId]);
	useEffect(() => {
		if (olderHistoryStatusForSession === "end" && session?.hasMoreHistory) setOlderHistoryStatus(null);
	}, [olderHistoryStatusForSession, session?.hasMoreHistory]);
	// Set right before prepending older messages, to the scroll container's
	// current scrollHeight — the restore effect below uses it to keep the
	// same content visually in place instead of the view jumping as new
	// (taller) content gets inserted above what's on screen.
	const pendingScrollRestoreRef = useRef(null);

	// Toast helper — stacks; each entry removes itself after 4s.
	const showToast = useCallback(
		(text, type = "info") => {
			const id = `${Date.now()}-${Math.random()}`;
			setToasts((prev) => [...prev, { id, text, type }]);
			setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
		},
		[setToasts],
	);

	// Command feedback belongs in the permanent transcript, not a 4-second
	// toast — role "warning" (not "system") since the real system-prompt
	// message at messages[0] is role:"system" and gets filtered from view.
	const addNotice = useCallback(
		(text, role = "warning") => {
			setSession((prev) => (prev ? { ...prev, messages: [...prev.messages, { role, content: text }] } : prev));
		},
		[setSession],
	);
	const settleSessionStreamWaiter = useCallback((id, ready) => {
		const waiter = sessionStreamWaitersRef.current.get(id);
		if (!waiter) return;
		clearTimeout(waiter.timer);
		sessionStreamWaitersRef.current.delete(id);
		waiter.resolve(ready);
	}, []);
	const waitForSessionStream = useCallback((id) => {
		if (!connected || !backendUp) return Promise.resolve(false);
		if (activeSessionIdRef.current === id && esRef.current?.readyState === EventSource.OPEN) return Promise.resolve(true);
		const existing = sessionStreamWaitersRef.current.get(id);
		if (existing) return existing.promise;
		let resolveWaiter;
		const promise = new Promise((resolve) => {
			resolveWaiter = resolve;
		});
		const timer = setTimeout(() => {
			sessionStreamWaitersRef.current.delete(id);
			resolveWaiter(false);
		}, 400);
		sessionStreamWaitersRef.current.set(id, { promise, resolve: resolveWaiter, timer });
		return promise;
	}, [activeSessionIdRef, connected, backendUp]);
	const {
		loadSessions,
		selectSession,
		selectingId,
		commitSession,
		startDraft,
		forkSession,
		initClientState,
		startReconnectLoop,
		retryPendingOutgoing,
	} =
		useSessionController({
			setSessions,
			setSessionsLoaded,
			setSession,
			pendingOutgoingRef,
			setActiveId,
			setRunning,
			setSidebarOpen,
			sessionsLoadVersionRef,
			sessionViewVersionRef,
			draftVersionRef,
			draftCommitsRef,
			olderPagesCacheRef,
			resetStreamingNow,
			hydrateStreamingNow,
			wasRunningRef,
			undismiss,
			showToast,
			esRef,
			staticResourcesLoadedRef,
			personasRef,
			reconnectTimerRef,
			setPersonas,
			setCommands,
			setThemes,
			setDefaultCwd,
			setDefaultModel,
			setQuickSessionPersona,
			setMemoryEnabled,
			setReconnectNonce,
			setBackendUp,
			applyTheme,
		});

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
		[
			sessions,
			activeId,
			personas,
			selectSession,
			startDraft,
			showToast,
			dismissedIds,
			resetStreamingNow,
			setActiveId,
			setSession,
			setSessions,
		],
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
		[activeId, showToast, setSession, setSessions],
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
		[showToast, setSessions],
	);

	// Holds the session the Share modal is open for — null when closed.
	const [shareModalSession, setShareModalSession] = useState(null);

	// "New session" modal — the sidebar's main `+ New session` button opens
	// this instead of the old inline persona+dir picker, so the worktree
	// toggle has a real home next to the directory controls. The quick-session
	// bolt button still bypasses the modal (one click → fresh sandbox session)
	// because asking for a worktree on a throwaway would be noise. On submit
	// the modal hands persona+cwd+worktree back to startDraft; the worktree
	// actually gets created on the server at first message via commitSession
	// (see use-session-controller.js).
	const [newSessionOpen, setNewSessionOpen] = useState(false);
	// Forwarded into NewSessionModal so the modal can show server-side
	// errors (notably worktree-creation failures) without having to close
	// itself preemptively.
	const [newSessionError, setNewSessionError] = useState(null);
	void newSessionError;
	const onCreateNewSession = async (payload) => {
		// Stage the draft first so the user sees the new session immediately,
		// but keep the modal open until commitSession actually succeeds —
		// worktree creation happens server-side at POST /api/sessions, so a
		// failure here is invisible to startDraft and must surface in the
		// modal's error slot.
		startDraft(payload.persona, payload.cwd, { worktree: payload.worktree });
		try {
			await commitSession(payload.persona, payload.cwd, { push: false, worktree: payload.worktree });
			setNewSessionError(null);
			setNewSessionOpen(false);
		} catch (err) {
			setNewSessionError(err?.message ?? String(err));
		}
	};

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
	}, [setDiffOpen, setSidebarCollapsed, setSidebarOpen]);

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
	}, [setDiffOpen, setSidebarCollapsed, setSidebarOpen]);
	const { startDiffResize, startSidebarResize } = usePanelResize({
		diffOpen,
		diffWidth,
		setDiffWidth,
		sidebarWidth,
		setSidebarWidth,
	});

	// Diff panel drag-to-resize — pointer events so mouse and touch both work.
	// Submit message
	const submitMessage = useCallback(
		(text, images, pendingDocs) =>
			submitMessageRequest(text, images, pendingDocs, {
				planRefineArmedRef,
				session,
				draftVersionRef,
				activeId,
				commitSession,
				showToast,
				addNotice,
				toggleDiff,
				olderPagesCacheRef,
				setSession,
				loadSessions,
				selectSession,
				setDefaultModel,
				applyTheme,
				setCurrentThemeId,
				setPendingSteers,
				setPendingQueue,
				setInputsRefreshNonce,
				waitForSessionStream,
				pendingOutgoingRef,
				setRunning,
				canSend: () => Boolean(session && connected && backendUp),
		}),
		[
			planRefineArmedRef,
			session,
			activeId,
			commitSession,
			showToast,
			addNotice,
			toggleDiff,
			setSession,
			loadSessions,
			selectSession,
			setDefaultModel,
			setPendingSteers,
			setPendingQueue,
			setInputsRefreshNonce,
			waitForSessionStream,
			pendingOutgoingRef,
			setRunning,
			connected,
			backendUp,
		],
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
					await recordChoice("Plan: continue planning — add feedback below");
					planRefineArmedRef.current = true;
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
		[
			activeId,
			planTransition,
			session?.planTransition,
			submitMessage,
			addNotice,
			showToast,
			planRefineArmedRef,
			setPlanTransition,
			setSession,
		],
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
		[activeId, session?.question, showToast, setSession],
	);

	// Abort — immediate visual feedback, debounce double-clicks, keep
	// transcript in sync even if SSE is slow.
	const [aborting, setAborting] = useState(false);
	const abortRun = useCallback(async () => {
		if (!activeId || aborting) return;
		setAborting(true);
		try {
			await api("POST", `/api/sessions/${activeId}/abort`);
			setSession((prev) =>
				prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: "Run aborted" }] } : prev,
			);
		} catch (err) {
			showToast(err.message, "error");
		} finally {
			// Keep spinner visible for at least 400ms so the click is perceived,
			// even if the server responded instantly.
			setTimeout(() => setAborting(false), 400);
		}
	}, [activeId, aborting, setSession, showToast]);

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
		} catch (error) {
			if (version === diffRequestVersionRef.current && activeSessionIdRef.current === sessionId)
				setDiffData({ files: [], error: error instanceof Error ? error.message : "Unable to load diff" });
		}
	}, [activeId, diffRequestVersionRef, setDiffData, activeSessionIdRef.current]);
	const queueDiffRefresh = useCallback(() => {
		if (!diffOpenRef.current || diffRefreshRafRef.current != null) return;
		diffRefreshRafRef.current = requestAnimationFrame(() => {
			diffRefreshRafRef.current = null;
			loadDiff();
			setFsRefreshNonce((n) => n + 1);
		});
	}, [loadDiff, diffRefreshRafRef, setFsRefreshNonce]);

	// SSE
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop). diffOpen is deliberately not a dependency — see diffOpenRef above; making it one would tear down and reopen the EventSource (full refetch, full message remount) on every diff-panel toggle.
	useEffect(() => {
		if (!activeId) return;
		closeSseConnection(esRef.current);

		const streamSessionId = activeId;
		const es = openSseConnection(`${window.location.origin}/api/sessions/${streamSessionId}/events`);
		esRef.current = es;
		setConnected(false);
		const isCurrent = () => esRef.current === es && activeSessionIdRef.current === streamSessionId;

		es.onopen = () => {
			if (!isCurrent()) return;
			setConnected(true);
			resetStreamingNow();
			const hydrationVersion = streamingEventVersionRef.current;
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
					if (hydrationVersion === streamingEventVersionRef.current) hydrateStreamingNow(data.streaming);
					setPendingSteers([]);
					setPendingQueue([]);
					// Scroll to bottom after reconnect — user wants to see
					// the latest messages, not where they were before disconnect.
					autoScrollRef.current = true;
					setAtBottom(true);
					void retryPendingOutgoing(streamSessionId);
			})
			.catch(() => {})
			.finally(() => settleSessionStreamWaiter(streamSessionId, true));
		};

		es.onmessage = (e) => {
			try {
				handleSseEvent(JSON.parse(e.data), {
					streamSessionId,
					setSession,
					setSessions,
					setRunning,
					setPendingSteers,
					setPendingQueue,
					setPlanTransition,
					pendingPlanSignalRef,
					selfClosingRef,
					activeId,
					wasRunningRef,
					updateStreaming,
					resetStreamingNow,
					hydrateStreamingNow,
					takeStreamingNow,
					diffOpenRef,
					queueDiffRefresh,
					setFsRefreshNonce,
					addNotice,
					showToast,
					api,
					isCurrent,
					mergeHistoryPage,
				});
			} catch (error) {
				console.error("[cast] SSE event handling failed", error);
			}
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
				settleSessionStreamWaiter(streamSessionId, false);
				setSession((prev) =>
					prev
						? { ...prev, messages: [...prev.messages, { role: "warning", content: "Connection terminated" }] }
						: prev,
				);
				startReconnectLoop();
			}
		};

		return () => {
			settleSessionStreamWaiter(streamSessionId, false);
			closeSseConnection(es);
		};
	}, [activeId, reconnectNonce, startReconnectLoop, addNotice, queueDiffRefresh, showToast, settleSessionStreamWaiter, retryPendingOutgoing]);

	// Sidebar-wide SSE — independent of activeId, so message-count badges for
	// other/background threads update live instead of only on page reload.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectNonce isn't read in the body — bumping it is what forces this effect to re-subscribe after a backend restart (see startReconnectLoop), same as the per-session SSE effect above.
	useEffect(() => {
		const es = openSseConnection(`${window.location.origin}/api/sessions/events`);
		es.onmessage = (e) => {
			try {
				const event = JSON.parse(e.data);
				if (event.type === "session_update") {
					setSessions((prev) => prev.map((s) => (s.id === event.session.id ? { ...s, ...event.session } : s)));
				}
			} catch {}
		};
		return () => closeSseConnection(es);
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
	// A pending question is rendered outside the settled message list, so the
	// message-based auto-scroll above does not run when its picker appears.
	// Keep the newly opened decision card in view; the user must be able to see
	// every option and the Continue button without discovering a hidden scroll.
	useEffect(() => {
		if (!session?.question || !messagesRef.current) return;
		requestAnimationFrame(() => {
			if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
		});
	}, [session?.question]);

	const scrollToBottom = useCallback(() => {
		autoScrollRef.current = true;
		setAtBottom(true);
		if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
	}, [setAtBottom]);

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
		setOlderHistoryStatus({ sessionId: forId, status: "loading" });
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
			setOlderHistoryStatus({ sessionId: forId, status: res.hasMoreHistory ? null : "end" });
		} catch {
			setOlderHistoryStatus({ sessionId: forId, status: "error" });
		} finally {
			loadingOlderRef.current = false;
		}
	}, [session, activeId, setSession, setOlderHistoryStatus]);

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

	// Scroll detection — coalesced via rAF so a fast fling doesn't queue
	// dozens of setAtBottom/loadOlderMessages calls per frame.
	const scrollRafRef = useRef(null);
	const handleScroll = useCallback(() => {
		if (scrollRafRef.current != null) return;
		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = null;
			const el = messagesRef.current;
			if (!el) return;
			const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
			autoScrollRef.current = bottom;
			setAtBottom(bottom);
			if (el.scrollTop < 400) loadOlderMessages();
		});
	}, [loadOlderMessages, setAtBottom]);
	useEffect(() => () => { if (scrollRafRef.current != null) cancelAnimationFrame(scrollRafRef.current); }, []);

	// Toggle diff — reset the selected file so switching sessions (or
	// reopening) doesn't leave a stale selection that no longer matches any
	// file in the freshly loaded list.
	useEffect(() => {
		if (diffOpen && activeId) {
			setDiffFile(null);
			loadDiff();
		}
	}, [diffOpen, activeId, loadDiff, setDiffFile]);

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
	}, [
		hotkeysOpen,
		dirPickerOpen,
		activeId,
		personas,
		cwd,
		startDraft,
		submitMessage,
		toggleDiff,
		setDirPickerOpen,
		setHotkeysOpen,
		setSidebarCollapsed,
	]);

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
						const fileMatch = line.match(FRONTMATTER_LINE_RE);
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
					const fm = line.match(FRONTMATTER_LINE_RE);
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
	// Default persona for a fresh draft — "senior" if installed, else whatever
	// the server sent first. Same picker the delete-last-session path uses
	// below (see deleteSessionPermanently); one shared source of truth so the
	// modal and the auto-fallback can't disagree on what "default" means.
	const defaultP = personas.find((x) => x.name === "senior") ?? personas[0];

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
					<button class="menu-toggle${dashboardOpen ? " active" : ""}" onClick=${() => navigate("/dashboard" + (activeId ? `?session=${activeId}` : ""))} aria-label="Dashboard" title="Dashboard">
						<${icons.chartBar} />
					</button>
					<button class="menu-toggle${settingsOpen ? " active" : ""}" onClick=${() => navigate("/settings" + (activeId ? `?session=${activeId}` : ""))} aria-label="Settings" title="Settings">
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

			<${SidebarModule}
				sessions=${visibleSessions}
				activeId=${activeId}
				selectingId=${selectingId}
				personas=${personas}
				cwd=${cwd}
				defaultCwd=${defaultCwd}
				quickSessionPersona=${quickSessionPersona}
				onSelectSession=${selectSession}
				onCreateSession=${startDraft}
				onOpenNewSession=${() => setNewSessionOpen(true)}
				onDeleteSession=${deleteSessionPermanently}
				onOpenDirPicker=${() => setDirPickerOpen(true)}
				onSetCwd=${setSelectedCwd}
				onRenameSession=${renameSession}
				onPinSession=${pinSession}
				onShareSession=${setShareModalSession}
				onForkSession=${forkSession}
				onLogout=${async () => {
					await fetch("/api/auth/logout", { method: "POST" });
					window.location.assign("/login");
				}}
				open=${sidebarOpen}
				sessionsLoaded=${sessionsLoaded}
				defaultModel=${defaultModel}
				defaultModelLoaded=${staticResourcesLoadedRef.current}
				onResizeStart=${startSidebarResize}
				confirm=${requestConfirm}
			/>

			<${ShareModal} session=${shareModalSession} onClose=${() => setShareModalSession(null)} />

			<${NewSessionModal}
				open=${newSessionOpen}
				personas=${personas}
				defaultPersona=${defaultP}
				cwd=${cwd}
				defaultCwd=${defaultCwd}
				defaultModel=${defaultModel}
				onSetCwd=${setSelectedCwd}
				onOpenDirPicker=${() => setDirPickerOpen(true)}
				onCreate=${onCreateNewSession}
				onClose=${() => setNewSessionOpen(false)}
			/>

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
				dashboardOpen &&
				html`
				<${DashboardModule} onClose=${goHome} />
			`
			}

			${
				settingsOpen &&
				html`
				<${SettingsModalModule}
					panels=${{ SettingsAppearance, SettingsModel, SettingsBash, SettingsWeb, SettingsMemory, SettingsPersonas, SettingsQuickMode, SettingsServer, SettingsHooks, SettingsMcp, SettingsSkills, SettingsPlugins, SettingsMarketplace, SettingsSkillssh, SettingsProvider, SettingsSsh }}
					fontOptions=${FONT_OPTIONS}
					fontScales=${FONT_SCALE_OPTIONS}
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
					onClose=${goHome}
					confirm=${requestConfirm}
					onReload=${() => refreshCommands(activeId)}
					onModelChange=${setDefaultModel}
					onMemoryChange=${setMemoryEnabled}
					showReasoning=${showReasoning}
					onToggleShowReasoning=${toggleShowReasoning}
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
							<p class="settings-loading">Loading…</p>
						</div>
					`
					}
					${
						// Switching to a different thread while a /api/sessions/:id
						// fetch is still in flight. Clicking the *currently
						// active* thread doesn't trigger this (the fetch is
						// there to refresh data, not to switch — the messages
						// are still accurate, so showing a loader would just
						// be visual noise). The user gets a static "Loading…"
						// centered in the same .empty-state slot the initial
						// bootstrap uses for its spinner, same visual language
						// as .settings-loading — "we got it, working on it".
						// Replaces the previous thread's messages rather than
						// overlaying them: the user just said "I want to look
						// at something else", keeping the old scroll position
						// and its plan/question cards under the loader would
						// both look broken ("why is the loading spinner for
						// thread B sitting on top of thread A's plan card?")
						// and feel laggy (you'd watch thread A's content
						// slowly shrink as the loader pushes it down).
						!bootstrapping &&
						selectingId &&
						selectingId !== activeId &&
						html`
						<div class="empty-state">
							<p class="settings-loading">Loading…</p>
						</div>
					`
					}
					${
						!bootstrapping &&
						!selectingId &&
						messages.length === 0 &&
						html`
						<div class="empty-state">
							<${CastLogo} class="empty-state-banner" />
							<p class="empty-state-title">Ready when you are</p>
							<p class="empty-state-hint">Send a message, or type <code>/</code> to see what this agent can do.</p>
						</div>
					`
					}
					${
						// Everything below here is the previous thread's state —
						// don't render any of it while we're switching (see the
						// comment on the loader block above).
						!(selectingId && selectingId !== activeId) &&
						html`
							${
								activeId &&
								messages.length > 0 &&
								h(HistoryBoundary, {
									status: olderHistoryStatusForSession,
									atEnd:
										olderHistoryStatusForSession === "end" ||
										(olderHistoryStatusForSession == null && session?.hasMoreHistory === false),
									onRetry: loadOlderMessages,
								})
							}
							${messages.map((msg) => html`<${MessageModule} key=${keyForMessage(msg)} msg=${msg} renderMarkdown=${renderMarkdown} escapeHtml=${escapeHtml} showReasoning=${showReasoning} />`)}
							<${LiveStreamingBlocksModule} controllerRef=${streamingControllerRef} onFrame=${_scrollStreamingFrame} renderMarkdown=${renderMarkdown} showReasoning=${showReasoning} />
							${
								!running &&
								html`
									<${PlanDecisionCard} transition=${session?.planTransition ?? planTransition} onChoose=${handlePlanTransition} />
									${session?.question && html`<${QuestionCard} question=${session.question} onChoose=${answerQuestion} />`}
								`
							}
						`
					}
				</div>
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
				<div class="composer-container">
					${
						!atBottom &&
						html`
						<button class="scroll-bottom-btn" onClick=${scrollToBottom} aria-label="Scroll to latest">
							<${icons.chevronDown} />
						</button>
					`
					}
					<${ComposerModule} running=${running} aborting=${aborting} ready=${!!session} sendReady=${Boolean(session && connected && backendUp)} activeId=${activeId} commands=${commands} personas=${personas} onSubmit=${submitMessage} onAbort=${abortRun} onDocUploaded=${() => setInputsRefreshNonce((n) => n + 1)} />
				</div>
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
			<${DiffPanelModule} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onResizeStart=${startDiffResize} open=${diffOpen} activeId=${activeId} tab=${diffTab} onTabChange=${setDiffTab} memoryEnabled=${memoryEnabled} confirm=${requestConfirm} fsRefreshNonce=${fsRefreshNonce} inputsRefreshNonce=${inputsRefreshNonce} bootstrapping=${bootstrapping} InputsExplorer=${InputsExplorerModule} FileExplorer=${FileExplorerModule} MemoryExplorer=${MemoryExplorerModule} />
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
	const [liveStatus, setLiveStatus] = useState(null);
	const streamingControllerRef = useRef(null);
	const loadStatic = useCallback(
		() =>
			api("GET", `/api/shared/${encodeURIComponent(token)}`)
				.then((d) => {
					if (d) setData(d);
				})
				.catch((err) => setError(err.message)),
		[token],
	);

	useEffect(() => {
		loadStatic();
		// Live read-only relay: watch the agent work in real time. The relay
		// only ever sends display events, so this stays read-only — there is
		// no input path on the shared view at all.
		const es = new EventSource(`/api/shared/${encodeURIComponent(token)}/events`);
		es.onmessage = (m) => {
			if (m.data === "live-unavailable") {
				es.close();
				return;
			}
			let event;
			try {
				event = JSON.parse(m.data);
			} catch {
				return;
			}
			switch (event.type) {
				case "status":
					setLiveStatus(event.status);
					if (event.status === "idle" || event.status === "error") {
						// Turn finished — refresh the committed transcript and
						// drop the live tail.
						streamingControllerRef.current?.reset();
						loadStatic();
					}
					break;
				case "token":
					streamingControllerRef.current?.reduce({ type: "content", text: event.text });
					break;
				case "thinking":
					streamingControllerRef.current?.reduce({ type: "thinking", text: event.text });
					break;
				case "tool_start":
					streamingControllerRef.current?.reduce({
						type: "tool_start",
						call: { id: event.id, name: event.name, args: event.args, status: event.status },
					});
					break;
				case "tool_end":
					streamingControllerRef.current?.reduce({
						type: "tool_end",
						id: event.id,
						status: event.status,
						result: event.result,
					});
					break;
				case "assistant_message":
					streamingControllerRef.current?.reset();
					loadStatic();
					break;
				default:
					break;
			}
		};
		return () => es.close();
	}, [token, loadStatic]);

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
					<p class="settings-loading">Loading…</p>
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
					<div class="shared-view-sub">${data.persona} · ${data.model} · read-only${liveStatus === "running" ? " · live" : ""}</div>
				</div>
			</div>
			<div class="shared-view-messages">
				${data.messages.map((msg, i) => html`<${MessageModule} key=${i} msg=${msg} renderMarkdown=${renderMarkdown} escapeHtml=${escapeHtml} />`)}
				<${LiveStreamingBlocksModule} controllerRef=${streamingControllerRef} onFrame=${() => {}} renderMarkdown=${renderMarkdown} showReasoning=${true} />
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
