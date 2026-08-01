/**
 * cast web — Preact + htm client application.
 * No build step: importmap loads preact and htm from esm.sh CDN.
 */

import htm from "htm";
import { h, render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "./api.js";
import { CastLogo } from "./cast-logo.js";
import { Composer as ComposerModule } from "./composer.js";
import { DiffPanel as DiffPanelModule } from "./diff-panel.js";
import { DirectoryBrowser } from "./directory-browser.js";
import { ElapsedTimer } from "./elapsed-timer.js";
import { FileExplorer as FileExplorerModule } from "./file-explorer.js";
import { hotkeysHtml, modKey } from "./hotkeys.js";
import { icons } from "./icons.js";
import { InputsExplorer as InputsExplorerModule } from "./inputs-explorer.js";
import { Message as MessageModule } from "./message.js";
import { useModalFocusTrap } from "./modal-focus.js";
import { PlanDecisionCard, QuestionCard } from "./plan-cards.js";
import { SettingsAppearance } from "./settings-appearance.js";
import { SettingsModal as SettingsModalModule } from "./settings-modal.js";
import { SettingsModel } from "./settings-model.js";
import { ShareModal } from "./share-modal.js";
import { Sidebar as SidebarModule } from "./sidebar.js";
import { SANDBOX_CWD, shortPath } from "./sidebar-utils.js";
import { closeSseConnection, openSseConnection } from "./sse-connection.js";
import { StatusPopover } from "./status-popover.js";
import { blocksFromAssistantCompletion } from "./stream-blocks.js";
import { LiveStreamingBlocks as LiveStreamingBlocksModule } from "./streaming-blocks.js";
import { useSessionController } from "./use-session-controller.js";
import { useSessionState } from "./use-session-state.js";
import { useWorkspaceState } from "./use-workspace-state.js";

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
	// Streaming state lives in LiveStreamingBlocks, so token commits never
	// reconcile the sidebar or full settled transcript.
	const streamingControllerRef = useRef(null);
	const updateStreaming = useCallback((event) => streamingControllerRef.current?.reduce(event), []);
	const resetStreamingNow = useCallback(() => streamingControllerRef.current?.reset(), []);
	const takeStreamingNow = useCallback(() => streamingControllerRef.current?.take() ?? [], []);
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
	} = useWorkspaceState({ initialCwd: SANDBOX_CWD });
	const requestConfirm = useCallback(
		(message) => new Promise((resolve) => setConfirmState({ message, resolve })),
		[setConfirmState],
	);
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
	const { loadSessions, selectSession, commitSession, startDraft, initClientState, startReconnectLoop } =
		useSessionController({
			setSessions,
			setSessionsLoaded,
			setSession,
			setActiveId,
			setRunning,
			setSidebarOpen,
			sessionsLoadVersionRef,
			sessionViewVersionRef,
			draftVersionRef,
			draftCommitsRef,
			olderPagesCacheRef,
			resetStreamingNow,
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
			setCurrentThemeId,
			setDefaultCwd,
			setDefaultModel,
			setQuickSessionPersona,
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

	// Diff panel drag-to-resize — pointer events so mouse and touch both work.
	const dragStateRef = useRef(null);
	const onDiffResizeMove = useCallback(
		(e) => {
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
		},
		[setDiffWidth],
	);
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
		[diffOpen, setSidebarWidth],
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
		[
			activeId,
			session,
			commitSession,
			loadSessions,
			selectSession,
			showToast,
			toggleDiff,
			addNotice,
			setInputsRefreshNonce,
			planRefineArmedRef,
			setDefaultModel,
			setPendingQueue,
			setPendingSteers, // Show the message immediately — waiting for the POST to resolve before
			// appending it made every send feel like it had a beat of lag, even
			// though the round trip to localhost is fast. Rendered the same shape
			// toDisplayMessages produces (content: text, images: [...]) so a page
			// reload looks identical to what was just shown live.
			setSession,
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

	// Abort
	const abortRun = useCallback(async () => {
		if (!activeId) return;
		try {
			await api("POST", `/api/sessions/${activeId}/abort`);
		} catch {}
		setSession((prev) =>
			prev ? { ...prev, messages: [...prev.messages, { role: "warning", content: "Run aborted" }] } : prev,
		);
	}, [activeId, setSession]);

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
			closeSseConnection(es);
		};
	}, [activeId, reconnectNonce, startReconnectLoop, addNotice, queueDiffRefresh, showToast]);

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
	}, [session, activeId, setSession]);

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
	}, [loadOlderMessages, setAtBottom]);

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

			<${SidebarModule}
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
				<${SettingsModalModule}
					panels=${{ SettingsAppearance, SettingsModel, SettingsBash, SettingsWeb, SettingsQuickMode, SettingsHooks, SettingsMcp, SettingsSkills, SettingsPlugins, SettingsMarketplace, SettingsSkillssh, SettingsProvider, SettingsSsh }}
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
					${messages.map((msg) => html`<${MessageModule} key=${keyForMessage(msg)} msg=${msg} renderMarkdown=${renderMarkdown} escapeHtml=${escapeHtml} />`)}
					<${LiveStreamingBlocksModule} controllerRef=${streamingControllerRef} onFrame=${scrollStreamingFrame} renderMarkdown=${renderMarkdown} />
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
				<${ComposerModule} running=${running} ready=${!!session} activeId=${activeId} commands=${commands} personas=${personas} onSubmit=${submitMessage} onAbort=${abortRun} onDocUploaded=${() => setInputsRefreshNonce((n) => n + 1)} />
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
			<${DiffPanelModule} data=${diffData} activeFile=${diffFile} onSelectFile=${setDiffFile} onResizeStart=${startDiffResize} open=${diffOpen} activeId=${activeId} tab=${diffTab} onTabChange=${setDiffTab} confirm=${requestConfirm} fsRefreshNonce=${fsRefreshNonce} inputsRefreshNonce=${inputsRefreshNonce} bootstrapping=${bootstrapping} InputsExplorer=${InputsExplorerModule} FileExplorer=${FileExplorerModule} />
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
				${data.messages.map((msg, i) => html`<${MessageModule} key=${i} msg=${msg} renderMarkdown=${renderMarkdown} escapeHtml=${escapeHtml} />`)}
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
