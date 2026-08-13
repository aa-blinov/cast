import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { marked } from "marked";
import hljs from "highlight.js/lib/common";
import { apiV1OpenApiDocument } from "../src/server/api-v1.ts";

// ── Config ──────────────────────────────────────────────────────────────────
const ROOT = new URL("..", import.meta.url).pathname;
const DOCS = join(ROOT, "docs");
const SITE = join(ROOT, "site");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version;

const NAV_ORDER = [
	{ file: "getting-started.md", label: "Getting Started" },
	{ file: "cli-reference.md", label: "CLI Reference" },
	{ file: "interactive-commands.md", label: "Interactive Commands" },
	{ file: "tools.md", label: "Tools" },
	{ file: "personas.md", label: "Personas" },
	{ file: "persona-research.md", label: "Persona Research" },
	{ file: "subagents.md", label: "Sub-agents & Delegation" },
	{ file: "skills.md", label: "Skills" },
	{ file: "plugins.md", label: "Plugins" },
	{ file: "rules.md", label: "Rules" },
	{ file: "mcp-servers.md", label: "MCP Servers" },
	{ file: "context-files.md", label: "Context Files" },
	{ file: "sessions.md", label: "Sessions" },
	{ file: "worktrees.md", label: "Git Worktrees" },
	{ file: "plan-mode.md", label: "Plan Mode" },
	{ file: "reasoning.md", label: "Reasoning" },
	{ file: "configuration.md", label: "Configuration" },
	{ file: "themes.md", label: "Themes" },
	{ file: "non-interactive-mode.md", label: "Non-Interactive Mode" },
	{ file: "eval-behavior.md", label: "Behavior Evals" },
	{ file: "eval-methodology.md", label: "Eval Methodology" },
	{ file: "architecture.md", label: "Architecture" },
	{ file: "infrastructure.md", label: "Infrastructure" },
	{ file: "api.md", label: "API v1" },
	// Not a real markdown file — rendered from docs/eval-scoreboard.json by the
	// special case in the build loop below. The ".md" suffix is kept purely so
	// the existing `.replace(".md", ".html")` calls (sidebar, prev/next, landing
	// grid) keep working unmodified; nothing here ever reads this as markdown.
	{ file: "eval-scoreboard.md", label: "Model Scoreboard" },
	{ file: "changelog.md", label: "Changelog" },
];

// ── marked config ───────────────────────────────────────────────────────────
marked.setOptions({
	gfm: true,
	breaks: false,
});

// Custom renderer: mermaid blocks get <pre class="mermaid"> with raw code stored as base64
// Tables get wrapped in a scrollable div for mobile overflow
const renderer = new marked.Renderer();
const languageAliases = {
	jsonl: "json",
	sh: "bash",
	shell: "bash",
	console: "plaintext",
	text: "plaintext",
};
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
renderer.code = function ({ text, lang }) {
	if (lang === "mermaid") {
		const b64 = Buffer.from(text).toString("base64");
		return `<pre class="mermaid" data-raw="${b64}">${text}</pre>`;
	}

	const sourceLanguage = lang?.trim().toLowerCase() || "";
	const language = languageAliases[sourceLanguage] || sourceLanguage;
	const hasLanguage = Boolean(language && hljs.getLanguage(language));
	const highlighted = hasLanguage ? hljs.highlight(text, { language }).value : escapeHtml(text);
	const className = sourceLanguage ? ` class="language-${escapeHtml(sourceLanguage)} hljs"` : ' class="hljs"';
	return `<pre class="code-block"${sourceLanguage ? ` data-language="${escapeHtml(sourceLanguage)}"` : ""}><code${className}>${highlighted}</code></pre>`;
};
const originalTable = renderer.table;
renderer.table = function (token) {
	const header = token.header;
	const rows = token.rows;
	let html = '<div class="table-wrap"><table><thead><tr>';
	for (const cell of header) html += `<th>${marked.parseInline(cell.text)}</th>`;
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		html += '<tr>';
		for (const cell of row) html += `<td>${marked.parseInline(cell.text)}</td>`;
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	return html;
};

// Fix .md links to .html for site navigation
const originalLink = renderer.link;
renderer.link = function (token) {
	const href = token.href.replace(/\.md(#[^)]+)?$/, '.html$1');
	const title = token.title ? ` title="${token.title}"` : '';
	return `<a href="${href}"${title}>${token.text}</a>`;
};
marked.use({ renderer });

// ── CSS ─────────────────────────────────────────────────────────────────────
// Font/palette here match cast server (src/server/public/tokens.css & style.css) —
// dark zinc surfaces (#08080a / #131317 / #1e1e24), sharp contrast, and a
// purple/violet accent gradient with clean mono typography.
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Inter:wght@400;500;600;700&display=swap');

:root {
	--bg: #08080a;
	--bg-surface: #131317;
	--bg-raised: #1e1e24;
	--bg-hover: #28282e;
	--bg-secondary: #131317;
	--bg-tertiary: #1e1e24;
	--border: #35353d;
	--border-active: #4a4a55;
	--border-subtle: rgba(53, 53, 61, 0.55);
	--text: #fafafa;
	--text-dim: #a1a1aa;
	--text-secondary: #a1a1aa;
	--text-muted: #71717a;
	--cyan: #8b5cf6;
	--violet: #8b5cf6;
	--teal: #2dd4bf;
	--purple: #a78bfa;
	--blue: #60a5fa;
	--green: #22c55e;
	--green-subtle: rgba(34, 197, 94, .12);
	--amber: #eab308;
	--rose: #ef4444;
	--persona: #c084fc;
	--accent: #8b5cf6;
	--accent-subtle: rgba(139, 92, 246, 0.12);
	--accent-muted: rgba(139, 92, 246, 0.2);
	--gradient: linear-gradient(135deg, #a855f7, #8b5cf6);
	--code-bg: #111116;
	--code-bg-raised: #17171e;
	--code-border: #3b3b48;
	--code-text: #e4e4e7;
	--sidebar-w: 272px;
	--header-h: 48px;
	--font: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
	--font-mono: 'JetBrains Mono', 'Fira Code', 'SF Mono', Consolas, monospace;
	--radius: 8px;
	--radius-sm: 6px;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html {
	font-size: 15px; scroll-behavior: smooth;
	scrollbar-width: thin; scrollbar-color: var(--accent) var(--bg-surface);
}
body {
	font-family: var(--font);
	background: var(--bg);
	color: var(--text);
	line-height: 1.55;
	-webkit-font-smoothing: antialiased;
}
body, .sidebar, .content, .table-wrap, .workspace-ui-personas, .workspace-install .install-block code {
	scrollbar-width: thin; scrollbar-color: var(--accent) var(--bg-surface);
}
html::-webkit-scrollbar, body::-webkit-scrollbar, .sidebar::-webkit-scrollbar,
.content::-webkit-scrollbar, .table-wrap::-webkit-scrollbar,
.workspace-ui-personas::-webkit-scrollbar, .workspace-install .install-block code::-webkit-scrollbar { width: 8px; height: 8px; }
html::-webkit-scrollbar-track, body::-webkit-scrollbar-track, .sidebar::-webkit-scrollbar-track,
.content::-webkit-scrollbar-track, .table-wrap::-webkit-scrollbar-track,
.workspace-ui-personas::-webkit-scrollbar-track, .workspace-install .install-block code::-webkit-scrollbar-track { background: var(--bg-surface); }
html::-webkit-scrollbar-thumb, body::-webkit-scrollbar-thumb, .sidebar::-webkit-scrollbar-thumb,
.content::-webkit-scrollbar-thumb, .table-wrap::-webkit-scrollbar-thumb,
.workspace-ui-personas::-webkit-scrollbar-thumb, .workspace-install .install-block code::-webkit-scrollbar-thumb {
	background: var(--accent); border: 2px solid var(--bg-surface); border-radius: 999px;
}
html::-webkit-scrollbar-thumb:hover, body::-webkit-scrollbar-thumb:hover, .sidebar::-webkit-scrollbar-thumb:hover,
.content::-webkit-scrollbar-thumb:hover, .table-wrap::-webkit-scrollbar-thumb:hover,
.workspace-ui-personas::-webkit-scrollbar-thumb:hover, .workspace-install .install-block code::-webkit-scrollbar-thumb:hover { background: var(--purple); }
a { color: var(--purple); text-decoration: none; transition: color .15s ease; }
a:hover { color: #c084fc; text-decoration: none; }

/* ── Header (Cast Web UI Bar) ─────────────────────────────────────── */
.header {
	position: fixed; top: 0; left: 0; right: 0; z-index: 100;
	height: var(--header-h);
	background: var(--bg-surface);
	border-bottom: 1px solid var(--border);
	display: flex; align-items: center; padding: 0 16px; gap: 12px;
}
.header-logo {
	display: inline-flex; align-items: center; gap: 8px;
	font-family: var(--font-mono); font-size: 1rem; font-weight: 700;
	color: var(--text);
}
.header-logo img {
	width: 20px; height: 20px; border-radius: 4px; display: inline-block;
}
.header-badge {
	font-family: var(--font-mono); font-size: .7rem; font-weight: 500;
	color: var(--teal); background: rgba(45, 212, 191, 0.12);
	border: 1px solid rgba(45, 212, 191, 0.25);
	padding: 1px 7px; border-radius: 12px;
}
.header-links { margin-left: auto; display: flex; gap: 14px; align-items: center; }
.header-links a {
	color: var(--text-dim); font-size: .8rem; font-weight: 500;
	font-family: var(--font-mono); padding: 4px 8px; border-radius: var(--radius-sm);
	transition: color .15s, background .15s;
}
.header-links a:hover { color: var(--text); background: var(--bg-raised); }

/* ── Sidebar (Cast Web Navigation) ───────────────────────────────── */
.sidebar {
	position: fixed; top: var(--header-h); left: 0; bottom: 0;
	width: var(--sidebar-w); background: var(--bg-surface);
	border-right: 1px solid var(--border);
	overflow-y: auto; padding: 12px 0 24px;
}
.sidebar-section { padding: 0 10px; margin-bottom: 12px; }
.sidebar-section-title {
	font-family: var(--font-mono); font-size: .68rem; font-weight: 600;
	text-transform: uppercase; letter-spacing: .08em; color: var(--text-muted);
	padding: 6px 10px 4px;
}
.sidebar a {
	display: flex; align-items: center; justify-content: space-between;
	padding: 6px 10px; border-radius: var(--radius-sm);
	font-size: .82rem; color: var(--text-dim); line-height: 1.4;
	font-family: var(--font); transition: background .15s, color .15s;
}
.sidebar a:hover { background: var(--bg-raised); color: var(--text); }
.sidebar a.active {
	background: var(--accent-subtle); color: var(--purple); font-weight: 500;
	border: 1px solid var(--accent-muted);
}
.sidebar a .badge {
	font-family: var(--font-mono); font-size: .65rem; color: var(--text-muted);
}

/* ── Mobile Menu & Responsiveness ────────────────────────────────── */
.menu-toggle {
	display: none; background: none; border: 1px solid var(--border);
	color: var(--text-dim); font-size: 1.1rem; cursor: pointer;
	padding: 4px 8px; border-radius: var(--radius-sm);
}
.menu-toggle:hover { color: var(--text); border-color: var(--border-active); }
@media (max-width: 768px) {
	.sidebar {
		transform: translateX(-100%); transition: transform .2s ease;
		z-index: 99; width: 280px;
	}
	.sidebar.open { transform: translateX(0); }
	.sidebar-backdrop {
		position: fixed; inset: 0; z-index: 98;
		background: rgba(0,0,0,.6); backdrop-filter: blur(4px);
		display: none;
	}
	.sidebar-backdrop.visible { display: block; }
	.menu-toggle { display: block; }
	.main { margin-left: 0 !important; padding: 20px 14px 60px !important; }
	.header { padding: 0 12px; }
	.header-links { gap: 8px; }
	.hero { padding: 40px 16px 32px; }
	.hero h1 { font-size: 1.6rem; }
	.hero p { font-size: .92rem; margin-bottom: 20px; }
	.install-block { padding: 12px 14px; }
	.install-block code { font-size: .75rem; word-break: break-all; }
	.content h1 { font-size: 1.5rem; }
	.content h2 { font-size: 1.2rem; margin: 24px 0 10px; }
	.content table { font-size: .78rem; }
	.content th, .content td { padding: 6px 8px; }
	.content pre:not(.mermaid-code) { padding: 12px; font-size: .78rem; border-radius: 6px; }
}

/* ── Main Workspace ──────────────────────────────────────────────── */
.main {
	margin-left: var(--sidebar-w);
	margin-top: var(--header-h);
	padding: 32px 48px 80px;
	max-width: 960px;
}
.main-landing {
	margin-left: 0; max-width: none; padding: 0;
}

/* ── Typography & Content ────────────────────────────────────────── */
.content h1 {
	font-family: var(--font); font-size: 1.8rem; font-weight: 700;
	margin: 0 0 16px; line-height: 1.25; color: var(--text);
	letter-spacing: -0.02em;
}
.content h2 {
	font-family: var(--font); font-size: 1.35rem; font-weight: 600;
	margin: 36px 0 12px; padding-bottom: 6px;
	border-bottom: 1px solid var(--border); color: var(--text);
}
.content h3 { font-size: 1.1rem; font-weight: 600; margin: 24px 0 8px; color: var(--text); }
.content h4 { font-size: .95rem; font-weight: 600; margin: 18px 0 6px; color: var(--text-dim); }
.content p { margin: 0 0 14px; color: var(--text-dim); font-size: .92rem; }
.content ul, .content ol { margin: 0 0 14px; padding-left: 20px; color: var(--text-dim); font-size: .92rem; }
.content li { margin: 4px 0; }
.content strong { color: var(--text); font-weight: 600; }
.content hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
.content blockquote {
	margin: 0 0 16px; background: var(--accent-subtle); border-radius: 0 6px 6px 0;
}
.content blockquote p:last-child { margin-bottom: 0; }

/* ── Code ───────────────────────────────────────────────────────────── */
.content code {
	font-family: var(--font-mono); font-size: .875em;
	background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
	border: 1px solid var(--border);
	color: var(--code-text);
}
.content pre.code-block,
.content pre:not(.mermaid):not(.mermaid-code) {
	position: relative;
	background: linear-gradient(180deg, var(--code-bg-raised), var(--code-bg));
	border: 1px solid var(--code-border);
	border-radius: 10px; padding: 18px 20px; margin: 0 0 18px;
	overflow-x: auto; line-height: 1.6; box-shadow: 0 8px 24px rgba(0, 0, 0, .14);
	-webkit-overflow-scrolling: touch;
}
.content pre.code-block::before {
	content: attr(data-language);
	position: absolute; top: 9px; right: 14px;
	font: 600 .62rem/1 var(--font-mono); letter-spacing: .08em;
	text-transform: uppercase; color: var(--text-muted); opacity: .9;
}
.content pre.code-block code,
.content pre:not(.mermaid):not(.mermaid-code) code {
	display: block; min-width: max-content; background: none; border: none;
	padding: 0; color: var(--code-text); font-size: .875rem; white-space: pre;
}
.content :not(pre) > code {
	white-space: break-spaces; overflow-wrap: anywhere;
}
.content .hljs-comment, .content .hljs-quote { color: #7f8494; font-style: italic; }
.content .hljs-keyword, .content .hljs-selector-tag, .content .hljs-literal,
.content .hljs-type, .content .hljs-addition { color: #c084fc; }
.content .hljs-string, .content .hljs-regexp, .content .hljs-attr,
.content .hljs-template-tag, .content .hljs-template-variable { color: #86efac; }
.content .hljs-number, .content .hljs-symbol, .content .hljs-bullet,
.content .hljs-variable, .content .hljs-variable.language_ { color: #67e8f9; }
.content .hljs-title, .content .hljs-title.class_, .content .hljs-title.function_,
.content .hljs-section, .content .hljs-name { color: #93c5fd; }
.content .hljs-built_in, .content .hljs-selector-attr, .content .hljs-selector-pseudo,
.content .hljs-meta, .content .hljs-link { color: #fcd34d; }
.content .hljs-operator, .content .hljs-punctuation { color: #d4d4d8; }
.content .hljs-deletion { color: #fda4af; }
.content .hljs-emphasis { font-style: italic; }
.content .hljs-strong { font-weight: 700; }
.content .hljs { color: var(--code-text); background: transparent; }
@media (max-width: 768px) {
	.content pre.code-block,
	.content pre:not(.mermaid):not(.mermaid-code) { padding: 16px 14px; border-radius: 8px; }
	.content pre.code-block code,
	.content pre:not(.mermaid):not(.mermaid-code) code { font-size: .78rem; }
}

/* ── Mermaid ────────────────────────────────────────────────────────── */
.mermaid-viewer {
	background: var(--code-bg); border: 1px solid var(--border);
	border-radius: 8px; margin: 0 0 16px; overflow: hidden;
}
.mermaid-toolbar {
	display: flex; align-items: center; gap: 6px;
	padding: 8px 12px; border-bottom: 1px solid var(--border);
	background: var(--bg-tertiary);
}
.mermaid-toolbar button {
	background: var(--bg-secondary); border: 1px solid var(--border);
	color: var(--text-secondary); border-radius: 4px;
	padding: 4px 10px; font-size: .8rem; cursor: pointer;
	font-family: var(--font); line-height: 1;
}
.mermaid-toolbar button:hover { color: var(--text); border-color: var(--accent); }
.mermaid-toolbar button.active { color: var(--accent); border-color: var(--accent); }
.mermaid-toolbar .zoom-label {
	font-size: .75rem; color: var(--text-muted); margin-left: auto;
}
.mermaid-diagram {
	padding: 24px; overflow: hidden; max-height: 60vh;
	position: relative; cursor: grab; user-select: none;
	touch-action: none; -webkit-user-select: none;
}
.mermaid-diagram.dragging { cursor: grabbing; }
.mermaid-diagram svg { transition: none; transform-origin: 0 0; }
.mermaid-code {
	display: none; padding: 16px; margin: 0;
	background: none; border: none;
	font-family: var(--font-mono); font-size: .8rem;
	color: var(--text-secondary); line-height: 1.5;
	overflow-x: auto; max-height: 60vh;
}
.mermaid-code.visible { display: block; }

/* ── Tables ─────────────────────────────────────────────────────────── */
.table-wrap { overflow-x: auto; margin: 0 0 16px; border: 1px solid var(--border); border-radius: 8px; }
.content table {
	width: 100%; border-collapse: collapse; margin: 0;
	font-size: .875rem;
}
.content th, .content td {
	padding: 8px 12px; border: 1px solid var(--border); text-align: left;
}
.content th { background: var(--bg-tertiary); font-weight: 600; }
.content tr:hover td { background: var(--bg-tertiary); }
.badge-pass, .badge-fail {
	display: inline-block; padding: 2px 8px; border-radius: 999px;
	font-size: .8rem; font-weight: 500; white-space: nowrap;
}
.badge-pass { background: var(--green-subtle); color: var(--green); }
.badge-fail { background: var(--bg-tertiary); color: var(--text-secondary); }
.content details { margin: 0 0 8px; }
.content details summary { cursor: pointer; font-weight: 500; padding: 4px 0; }
.visually-hidden {
	position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
	overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

/* ── Doc page navigation ─────────────────────────────────────────────── */
.doc-nav {
	display: flex; justify-content: space-between; gap: 16px;
	margin-top: 48px; padding-top: 24px;
	border-top: 1px solid var(--border);
}
.doc-nav a {
	padding: 12px 20px; border: 1px solid var(--border); border-radius: 8px;
	font-size: .9rem; font-weight: 500; color: var(--text-secondary);
	background: var(--bg-secondary); transition: border-color .15s, color .15s;
	flex: 1;
}
.doc-nav a:hover { border-color: var(--accent); color: var(--text); text-decoration: none; }
.doc-nav-prev { text-align: left; }
.doc-nav-next { text-align: right; }
@media (max-width: 768px) {
	.doc-nav { flex-direction: column; }
	.doc-nav a { text-align: left; }
}

/* ── Landing page ───────────────────────────────────────────────────── */
.hero {
	text-align: center; padding: 100px 24px 60px; overflow-x: hidden;
	background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg) 100%);
}
.hero-ascii-wrap { margin-bottom: 24px; }
.hero-ascii {
	/* An <img>, not text — scales like any other image (GitHub's own
	   markdown CSS caps images at max-width:100%, and so do we below), no
	   runtime measuring/fit script needed. */
	max-width: 100%; height: auto;
}
.hero h1 { font-size: 3rem; font-weight: 800; margin: 0 0 16px; }
.hero h1 .accent { color: #38e0ff; }
.hero p { font-size: 1.25rem; color: var(--text-secondary); max-width: 600px; margin: 0 auto 32px; }
.hero-buttons { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.hero-buttons a {
	padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 1rem;
}
.btn-primary { background: linear-gradient(135deg, #38e0ff, #a855f7); color: #fff; }
.btn-primary:hover { background: linear-gradient(135deg, #5eead4, #c084fc); color: #fff; text-decoration: none; }
.btn-secondary {
	background: var(--bg-tertiary); color: var(--text); border: 1px solid var(--border);
}
.btn-secondary:hover { background: var(--bg-secondary); text-decoration: none; }

.install-block {
	max-width: 560px; margin: 32px auto 0; text-align: left;
	background: var(--code-bg); border: 1px solid var(--border);
	border-radius: 8px; padding: 16px 20px;
}
.install-block .label {
	font-size: .75rem; font-weight: 600; color: var(--text-muted);
	text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px;
}
.install-block code { font-size: .875rem; color: #34d399; }
.install-block .note { font-size: .8rem; color: var(--text-muted); margin-top: 8px; }

.features {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
	gap: 20px; padding: 40px 48px 60px; max-width: 1200px; margin: 0 auto;
}
.feature {
	background: var(--bg-secondary); border: 1px solid var(--border);
	border-radius: 8px; padding: 24px;
}
.feature h3 { font-size: 1.1rem; margin: 0 0 8px; }
.feature p { color: var(--text-secondary); font-size: .9rem; margin: 0; }
.feature .icon { margin-bottom: 12px; display: block; color: var(--accent); }

.providers {
	text-align: center; padding: 40px 24px;
	max-width: 800px; margin: 0 auto;
}
.providers h2 { font-size: 1.5rem; margin: 0 0 24px; border: none; padding: 0; }
.provider-grid {
	display: flex; flex-wrap: wrap; gap: 12px; justify-content: center;
}
.provider-tag {
	background: var(--bg-secondary); border: 1px solid var(--border);
	padding: 8px 16px; border-radius: 6px; font-size: .875rem;
	color: var(--text-secondary); font-weight: 500;
}

.landing-docs {
	max-width: 1200px; margin: 0 auto; padding: 40px 48px 80px;
}
.landing-docs h2 {
	font-size: 1.5rem; text-align: center; margin: 0 0 32px;
	border: none; padding: 0;
}
.docs-grid {
	display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
	gap: 12px;
}
.doc-card {
	background: var(--bg-secondary); border: 1px solid var(--border);
	border-radius: 8px; padding: 16px 20px; transition: border-color .15s;
}
.doc-card:hover { border-color: var(--accent); text-decoration: none; }
.doc-card h3 { font-size: 1rem; margin: 0 0 4px; color: var(--text); }
.doc-card p { font-size: .85rem; color: var(--text-secondary); margin: 0; }

.footer {
	text-align: center; padding: 24px; border-top: 1px solid var(--border);
	font-size: .8rem; color: var(--text-muted);
}

/* ── Roles showcase ────────────────────────────────────────────────── */
.roles-showcase {
	background: var(--bg-secondary); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
	padding: 48px 24px; max-width: 900px; margin: 0 auto;
}
.roles-showcase h2 {
	text-align: center; font-size: 1.5rem; font-weight: 700; margin: 0 0 12px;
}
.roles-showcase > p {
	text-align: center; color: var(--text-secondary); max-width: 600px; margin: 0 auto 28px;
}
.roles-terminal {
	background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px;
	max-width: 560px; margin: 0 auto; overflow: hidden;
}
.roles-terminal-bar {
	display: flex; align-items: center; gap: 6px;
	padding: 10px 16px; border-bottom: 1px solid var(--border);
	background: var(--bg-tertiary);
}
.roles-terminal-bar span {
	width: 10px; height: 10px; border-radius: 50%;
}
.roles-terminal-bar span:nth-child(1) { background: #fb7185; }
.roles-terminal-bar span:nth-child(2) { background: #fbbf24; }
.roles-terminal-bar span:nth-child(3) { background: #34d399; }
.roles-terminal-body {
	font-family: var(--font-mono); font-size: .85rem; padding: 16px;
	line-height: 1.8;
}
.roles-terminal-body .prompt { color: var(--accent); }
.roles-terminal-body .cmd { color: var(--green); }
.roles-terminal-body .out { color: var(--text-secondary); }

/* ── Motivation ────────────────────────────────────────────────────── */
.motivation {
	max-width: 760px; margin: 0 auto; padding: 48px 24px 40px;
}
.motivation h2 {
	text-align: center; font-size: 1.5rem; font-weight: 700; margin: 0 0 12px;
}
.motivation > p.lede {
	text-align: center; color: var(--text-secondary); max-width: 620px; margin: 0 auto 24px;
}
.motivation ul {
	list-style: none; margin: 0 0 20px; padding: 0;
	display: flex; flex-direction: column; gap: 12px;
}
.motivation li {
	background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px;
	padding: 14px 16px; font-size: .9rem; color: var(--text-secondary); line-height: 1.55;
}
.motivation li a { font-size: .85em; }
.motivation p.closing {
	color: var(--text-secondary); font-size: .95rem; line-height: 1.6;
}
.motivation p.closing + p.closing {
	margin-top: 16px; text-align: center; font-size: .9rem;
}
.motivation code {
	font-family: var(--font-mono); font-size: .875em;
	background: var(--code-bg); padding: 2px 6px; border-radius: 4px;
	border: 1px solid var(--border); color: var(--accent);
}

/* ── Comparison ────────────────────────────────────────────────────── */
.comparison {
	max-width: 700px; margin: 0 auto; padding: 40px 24px 60px;
}
.comparison h2 {
	text-align: center; font-size: 1.5rem; font-weight: 700; margin: 0 0 12px;
}
.comparison > p {
	text-align: center; color: var(--text-secondary); max-width: 540px; margin: 0 auto 24px;
}
.comparison-table-wrap { overflow-x: auto; }
.comparison table {
	width: 100%; border-collapse: collapse;
	font-size: .875rem; background: var(--bg-secondary);
	border: 1px solid var(--border); border-radius: 8px;
	overflow: hidden;
}
.comparison th, .comparison td {
	padding: 10px 16px; border-bottom: 1px solid var(--border); text-align: left;
}
.comparison th {
	background: var(--bg-tertiary); font-weight: 600; color: var(--text);
}
.comparison td { color: var(--text-secondary); }
.comparison tr:last-child td { border-bottom: none; }

@media (max-width: 768px) {
	.roles-showcase { padding: 32px 16px; }
	.roles-terminal-body { font-size: .75rem; padding: 12px; }
	.motivation { padding: 32px 16px 24px; }
	.comparison { padding: 32px 16px 48px; }
}

/* ── Workspace landing ─────────────────────────────────────────────── */
.workspace-shell {
	max-width: 1240px; margin: 0 auto; padding: 88px 32px 72px;
}
.workspace-hero {
	display: grid; grid-template-columns: minmax(0, .92fr) minmax(460px, 1.08fr);
	gap: clamp(40px, 7vw, 96px); align-items: center; min-height: 590px;
}
.workspace-title {
	max-width: 620px; font-size: clamp(2.7rem, 6vw, 5rem); line-height: 1.02;
	letter-spacing: -.055em; font-weight: 700; margin-bottom: 22px;
}
.workspace-title .accent { color: #c084fc; }
.workspace-copy {
	max-width: 560px; font-size: 1.05rem; line-height: 1.7; color: var(--text-dim); margin-bottom: 30px;
}
.workspace-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 32px; }
.workspace-actions a { display: inline-flex; align-items: center; gap: 8px; }
.workspace-actions .btn-primary { padding: 12px 18px; }
.workspace-actions .btn-secondary { padding: 11px 17px; }
.workspace-section { border-top: 1px solid var(--border); padding: 62px 0; }
.workspace-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.workspace-section-heading h2 { margin: 0; font-size: 1.55rem; letter-spacing: -.025em; }
.workspace-section-heading p { max-width: 450px; margin: 0; color: var(--text-muted); font-size: .86rem; }
.workspace-grid { display: grid; grid-template-columns: 1.25fr .75fr; gap: 16px; }
.workspace-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; transition: border-color .15s, transform .15s, background .15s; }
.workspace-card:hover { border-color: var(--border-active); background: var(--bg-raised); transform: translateY(-2px); }
.workspace-card h3 { margin: 0 0 7px; font-size: .98rem; }
.workspace-card p { margin: 0; color: var(--text-muted); font-size: .82rem; line-height: 1.55; }
.workspace-card-link { display: block; color: inherit; }
.workspace-card-link:hover { color: inherit; }
.workspace-card-tag { display: inline-block; margin-bottom: 16px; color: var(--accent); font: 600 .65rem var(--font-mono); text-transform: uppercase; letter-spacing: .1em; }
.workspace-card-arrow { display: block; margin-top: 16px; color: var(--purple); font: .72rem var(--font-mono); }
.workspace-install { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-width: 0; }
.workspace-install .install-block { max-width: none; min-width: 0; margin: 0; padding: 16px; overflow: hidden; }
.workspace-code { position: relative; min-width: 0; padding-right: 34px; }
.workspace-install .install-block code { display: block; min-width: 0; overflow-x: auto; white-space: nowrap; }
.workspace-copy-btn {
	position: absolute; top: -4px; right: 0; display: flex; align-items: center; justify-content: center;
	width: 26px; height: 26px; padding: 0; background: var(--bg-hover); border: 1px solid var(--border);
	border-radius: var(--radius-sm); color: var(--text-muted); cursor: pointer;
	transition: color .1s ease, border-color .1s ease, background .1s ease;
}
.workspace-copy-btn svg { width: 14px; height: 14px; }
.workspace-copy-btn:hover, .workspace-copy-btn:focus-visible { color: var(--text); border-color: var(--text-muted); outline: none; }
.workspace-copy-btn.copied { color: var(--teal); border-color: var(--teal); }
.workspace-docs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.workspace-docs a { color: var(--text-dim); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 13px 14px; font-size: .8rem; transition: border-color .15s, color .15s; }
.workspace-docs a:hover { color: var(--purple); border-color: var(--border-active); }
.workspace-footer { display: flex; align-items: center; justify-content: center; gap: 10px; padding-top: 20px; color: var(--text-muted); font: .7rem var(--font-mono); text-align: center; }
.workspace-footer a { color: var(--text-muted); transition: color .15s ease; }
.workspace-footer a:hover { color: var(--purple); }
@media (max-width: 900px) {
	.workspace-hero { grid-template-columns: 1fr; gap: 34px; min-height: 0; padding: 24px 0 52px; }
	.workspace-title { max-width: 680px; }
	.workspace-panel { max-width: 680px; }
}
@media (max-width: 640px) {
	.workspace-shell { padding: 62px 16px 42px; }
	.workspace-title { font-size: clamp(2.55rem, 15vw, 4rem); }
	.workspace-copy { font-size: .94rem; }
	.workspace-panel-body { padding: 15px; }
	.workspace-section { padding: 42px 0; }
	.workspace-section-heading { display: block; }
	.workspace-section-heading h2 { margin-bottom: 8px; }
	.workspace-grid, .workspace-install { grid-template-columns: 1fr; }
	.workspace-docs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* The landing preview mirrors the actual Web UI: shared header, sessions
 * sidebar, chat header, persona status, and transcript. It is deliberately
 * static in structure but persona switching is live so the preview explains
 * the product instead of pretending to be a screenshot. */
.workspace-ui {
	background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
	overflow: hidden; box-shadow: 0 24px 70px rgba(0, 0, 0, .32);
}
.workspace-ui-header {
	display: flex; align-items: center; gap: 14px; height: 48px; padding: 0 14px;
	background: var(--bg-surface); border-bottom: 1px solid var(--border); color: var(--text-dim);
	font: .7rem var(--font-mono);
}
.workspace-ui-brand { display: flex; align-items: center; color: var(--text); font-weight: 600; }
.workspace-ui-status {
	width: 10px; height: 10px; border-radius: 50%; background: var(--green);
	box-shadow: 0 0 6px color-mix(in srgb, var(--green) 50%, transparent);
}
.workspace-ui-actions { display: flex; gap: 7px; margin-left: auto; }
.workspace-ui-actions span { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--border); border-radius: 5px; color: var(--text-muted); }
.workspace-ui-body { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: 390px; }
.workspace-ui-sidebar { display: flex; flex-direction: column; min-width: 0; padding: 12px; background: var(--bg-surface); border-right: 1px solid var(--border); }
.workspace-ui-new { display: flex; align-items: center; justify-content: center; gap: 7px; width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-dim); font: .68rem var(--font-mono); }
.workspace-ui-directory { padding: 16px 3px 12px; border-bottom: 1px solid var(--border); color: var(--text-muted); font: .6rem var(--font-mono); }
.workspace-ui-directory strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); font-weight: 500; margin-top: 5px; }
.workspace-ui-sidebar-title { padding: 16px 3px 7px; color: var(--text-muted); font: 600 .6rem var(--font-mono); text-transform: uppercase; letter-spacing: .08em; }
.workspace-ui-session { display: block; width: 100%; padding: 8px 9px; margin-bottom: 3px; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--text-muted); font: .65rem var(--font-mono); }
.workspace-ui-session.active { border-color: var(--accent-muted); background: var(--accent-subtle); color: var(--text); }
.workspace-ui-sidebar-model { margin-top: auto; padding: 12px 3px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-top: 1px solid var(--border); color: var(--text-muted); font: .58rem var(--font-mono); }
.workspace-ui-chat { display: flex; flex-direction: column; min-width: 0; background: var(--bg); }
.workspace-ui-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 17px; border-bottom: 1px solid var(--border); }
.workspace-ui-chat-title { color: var(--text); font-size: .76rem; font-weight: 600; }
.workspace-ui-chat-state { color: var(--text-muted); font: .58rem var(--font-mono); }
.workspace-ui-personas { display: flex; gap: 5px; padding: 12px 17px 0; overflow-x: auto; }
.workspace-ui-persona { flex: 0 0 auto; padding: 5px 8px; border: 1px solid var(--border); border-radius: 5px; background: transparent; color: var(--text-muted); cursor: pointer; font: .61rem var(--font-mono); transition: color .15s, border-color .15s, background .15s; }
.workspace-ui-persona:hover { color: var(--text); border-color: var(--border-active); }
.workspace-ui-persona.active { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 55%, var(--border)); background: var(--accent-subtle); }
.workspace-ui-messages { flex: 1; padding: 18px 17px 14px; }
.workspace-ui-message { display: flex; gap: 9px; margin-bottom: 17px; }
.workspace-ui-avatar { display: grid; place-items: center; flex: 0 0 24px; height: 24px; border-radius: 5px; background: var(--teal); color: var(--bg); font: 700 .58rem var(--font-mono); }
.workspace-ui-avatar.agent { background: var(--purple); }
.workspace-ui-message-content { min-width: 0; }
.workspace-ui-message-label { margin-bottom: 4px; color: var(--text-muted); font: .57rem var(--font-mono); text-transform: uppercase; }
.workspace-ui-message-text { color: var(--text-dim); font-size: .7rem; line-height: 1.55; }
.workspace-ui-message-text strong { color: var(--text); font-weight: 600; }
.workspace-ui-tool { margin: -2px 0 15px 33px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; color: var(--text-muted); font: .58rem var(--font-mono); }
.workspace-ui-tool::before { content: "✓"; margin-right: 6px; color: var(--teal); }
.workspace-ui-panel[hidden] { display: none; }
@media (max-width: 640px) {
	.workspace-ui-body { grid-template-columns: 1fr; min-height: 350px; }
	.workspace-ui-sidebar { display: none; }
	.workspace-ui-header { gap: 9px; }
	.workspace-ui-actions span:nth-child(2) { display: none; }
}
`;

// ── Landing page HTML ───────────────────────────────────────────────────────
const LEGACY_LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>cast — One agent, many roles</title>
<meta name="description" content="A role-based terminal agent harness. Seven built-in personas, same tools, different judgment. Runs on any OpenAI-compatible model — including the one on your own hardware.">
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<header class="header">
	<a href="index.html" class="header-logo" aria-label="cast home"><img src="assets/favicon.svg" alt="cast logo"></a>
	<span class="header-badge">v${PACKAGE_VERSION}</span>
	<div class="header-links">
		<a href="getting-started.html">Docs</a>
		<a href="https://github.com/aa-blinov/cast">GitHub</a>
	</div>
</header>

<div class="main main-landing">
	<section class="hero">
		<div class="hero-ascii-wrap"><img class="hero-ascii" src="assets/cast-banner.svg" alt="cast" width="440"></div>
		<h1>One agent, <span class="accent">many roles</span></h1>
		<p>cast brings a full cast to your terminal: senior developer, analyst, reviewer, planner, researcher, assistant, and coder with sub-agents. Swap the role, not the tool. Runs on any OpenAI-compatible model, including the one on your own hardware.</p>
		<div class="hero-buttons">
			<a href="getting-started.html" class="btn-primary">Get Started</a>
			<a href="https://github.com/aa-blinov/cast" class="btn-secondary">GitHub</a>
		</div>
		<div class="install-block">
			<div class="label">macOS / Linux</div>
			<code>curl -fsSL https://aa-blinov.github.io/cast/install | bash</code>
			<div class="label" style="margin-top:12px">Windows (PowerShell)</div>
			<code>irm https://aa-blinov.github.io/cast/install.ps1 | iex</code>
			<div class="note">Requires Node.js 22+. Self-contained bundle — no npm packages needed at runtime.</div>
		</div>
	</section>

	<section class="roles-showcase">
		<h2>One session, one repo, four roles</h2>
		<p>Same codebase, different lens. Swap personas mid-session — the tools don't change, the judgment does.</p>
		<div class="roles-terminal">
			<div class="roles-terminal-bar"><span></span><span></span><span></span></div>
			<div class="roles-terminal-body">
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona pm</span></div>
				<div class="out">Write a spec for the new auth flow</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona senior</span></div>
				<div class="out">Implement the spec — file by file, tested</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona qa</span></div>
				<div class="out">Review the implementation for edge cases</div>
				<div><span class="prompt">&gt;</span> <span class="cmd">/persona tech-writer</span></div>
				<div class="out">Document the new auth flow in the README</div>
			</div>
		</div>
	</section>

	<section class="motivation">
		<h2>Why personas, not just prompts</h2>
		<p class="lede">Point a generic coding agent and a role-specific one at the same file, and they don't just answer differently — they look for different things. An analyst surfaces gaps and acceptance criteria; a reviewer looks for regressions and unhappy paths. Same repo, same tools, different definition of "done."</p>
		<ul>
			<li>Assigning an LLM an expert role measurably changes the <em>shape</em> of its output — deeper domain framing at the cost of some plain-language clarity, a real trade-off rather than a free upgrade. <a href="https://arxiv.org/abs/2605.29420" target="_blank" rel="noopener">Xiao et al., 2026 ↗</a></li>
			<li>The effect isn't free-floating flavor text: matching the persona to the task helps, mismatching it hurts, and a mismatched persona measurably breaks more answers than a matched one fixes. <a href="https://arxiv.org/abs/2408.08631" target="_blank" rel="noopener">Kim et al., 2024 ↗</a></li>
			<li>For tool-using agents specifically, explicit role/behavior rules — not just a persona label — are what fixes "under-acting" (skipping a tool the role should obviously use) and "over-speaking" (chatting instead of calling). <a href="https://arxiv.org/abs/2509.00482" target="_blank" rel="noopener">Ruangtanusak et al., 2025 ↗</a></li>
			<li>The effect isn't universal — persona framing helps most on open-ended, advisory, judgment-heavy tasks, and least on narrow factual lookups. A persona only pays for itself when it actually matches the task.</li>
		</ul>
		<p class="closing">cast leans into that instead of working around it: swap <code>/persona</code> and the same tools, the same repo, and the same model produce a different investigation — different priorities, different tool sequencing, different conclusions, different follow-up questions. A review that reasons like a senior developer misses different things than one that reasons like an analyst or QA reviewer, even reading identical code.</p>
		<p class="closing"><a href="persona-research.html">Read the full research writeup →</a></p>
	</section>

	<section class="features">
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
			<h3>A cast, not a coder</h3>
			<p>Seven built-in personas: senior developer, analyst, reviewer, planner, researcher, assistant, and coder with sub-agents. Same tools, different judgment. Add your own with a markdown file or build one through chat.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg></span>
			<h3>Runs where your code runs</h3>
			<p>vLLM, Ollama, your own inference server, or any OpenAI-compatible API. No account, no telemetry, no cloud dependency. Your tokens stay on your hardware.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>
			<h3>Real Tools, Real Work</h3>
			<p>Reads files, writes code, runs shell commands, searches codebases — all in parallel. Delegates sub-tasks to isolated sub-agents. Rules, skills, and MCP servers extend capabilities.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg></span>
			<h3>Reasoning Control</h3>
			<p>Adjust reasoning effort per model: off, low, medium, high, max. Think blocks parsed automatically.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg></span>
			<h3>Plan Mode</h3>
			<p>Explore the codebase and write execution plans before implementing. Think before you build.</p>
		</div>
		<div class="feature">
			<span class="icon"><svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 12h12"/><path d="m12 6 6 6-6 6"/></svg></span>
			<h3>Ink TUI</h3>
			<p>A proper terminal interface with multiline paste, image attachments, smooth animations, and 16 color themes.</p>
		</div>
	</section>

	<section class="comparison">
		<h2>Why not opencode?</h2>
		<p>Both are terminal agents with tools. Different philosophy.</p>
		<div class="comparison-table-wrap">
		<table>
			<tr><th></th><th>opencode</th><th>cast</th></tr>
			<tr><td>Approach</td><td>Universal agent</td><td>Role-based harness</td></tr>
			<tr><td>Personas</td><td>Single agent, single lens</td><td>7 built-in + custom</td></tr>
			<tr><td>Self-hosted focus</td><td>Works with any provider</td><td>Designed for local inference</td></tr>
			<tr><td>Telemetry</td><td>Varies</td><td>None. Ever.</td></tr>
		</table>
		</div>
	</section>

	<section class="landing-docs">
		<h2>Documentation</h2>
		<div class="docs-grid">
			${NAV_ORDER.map(
				(item) =>
					`<a href="${item.file.replace(".md", ".html")}" class="doc-card"><h3>${item.label}</h3><p>${getDescription(item.file)}</p></a>`,
			).join("\n\t\t\t")}
		</div>
	</section>

	<footer class="footer">
		cast is open source under the MIT License. Works with OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, Azure OpenAI, and any OpenAI-compatible API.
	</footer>
</div>
</body>
</html>`;

const LANDING_COPY_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/></svg>';
const LANDING_CHECK_ICON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 12.75 6 6 9-13.5"/></svg>';

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>cast — Agent workspace</title>
<meta name="description" content="cast is a role-based agent workspace for your repository and OpenAI-compatible model.">
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<header class="header">
	<a href="index.html" class="header-logo" aria-label="cast home"><img src="assets/favicon.svg" alt="cast logo"></a>
	<span class="header-badge">v${PACKAGE_VERSION}</span>
	<div class="header-links">
		<a href="getting-started.html">Docs</a>
		<a href="https://github.com/aa-blinov/cast">GitHub</a>
	</div>
</header>

<div class="main main-landing">
	<main class="workspace-shell">
		<section class="workspace-hero" aria-labelledby="workspace-title">
			<div>
				<h1 id="workspace-title" class="workspace-title">Work with a <span class="accent">different lens.</span></h1>
				<p class="workspace-copy">A focused agent harness for real repositories. Choose the role, keep the same tool surface, and let the work follow the shape of the task.</p>
				<div class="workspace-actions">
					<a href="getting-started.html" class="btn-primary">Open the workspace <span aria-hidden="true">→</span></a>
					<a href="personas.html" class="btn-secondary">Browse personas</a>
				</div>
			</div>

			<div class="workspace-ui" aria-label="Cast Web UI preview">
				<div class="workspace-ui-header">
					<div class="workspace-ui-brand"><span class="workspace-ui-status" role="status" aria-label="Backend connected" title="Backend connected"></span></div>
					<div class="workspace-ui-actions" aria-hidden="true"><span>◌</span><span>⌘</span><span>⚙</span></div>
				</div>
				<div class="workspace-ui-body">
					<aside class="workspace-ui-sidebar" aria-label="Sessions preview">
						<button class="workspace-ui-new" type="button">＋ New session</button>
						<div class="workspace-ui-directory">Directory<strong>~/projects/auth-service</strong></div>
						<div class="workspace-ui-sidebar-title">Sessions</div>
						<button class="workspace-ui-session active" type="button">Review auth flow</button>
						<button class="workspace-ui-session" type="button">Plan release notes</button>
						<button class="workspace-ui-session" type="button">Investigate flaky test</button>
						<div class="workspace-ui-sidebar-model">openai-compatible</div>
					</aside>
					<section class="workspace-ui-chat" aria-label="Active Cast session">
						<div class="workspace-ui-chat-head"><div class="workspace-ui-chat-title">Review auth flow</div><div class="workspace-ui-chat-state">idle</div></div>
						<div class="workspace-ui-personas" role="tablist" aria-label="Switch persona">
							<button class="workspace-ui-persona active" type="button" role="tab" aria-selected="true" data-persona-switch="senior">Senior</button>
							<button class="workspace-ui-persona" type="button" role="tab" aria-selected="false" data-persona-switch="analyst">Analyst</button>
							<button class="workspace-ui-persona" type="button" role="tab" aria-selected="false" data-persona-switch="reviewer">Reviewer</button>
							<button class="workspace-ui-persona" type="button" role="tab" aria-selected="false" data-persona-switch="planner">Planner</button>
						</div>
						<div class="workspace-ui-messages">
							<div class="workspace-ui-message"><div class="workspace-ui-avatar">U</div><div class="workspace-ui-message-content"><div class="workspace-ui-message-label">you</div><div class="workspace-ui-message-text">Audit the auth flow and identify the highest-risk edge cases.</div></div></div>
							<div class="workspace-ui-panel" role="tabpanel" data-persona-panel="senior"><div class="workspace-ui-message"><div class="workspace-ui-avatar agent">C</div><div class="workspace-ui-message-content"><div class="workspace-ui-message-label">Senior</div><div class="workspace-ui-message-text">I traced the request path and found <strong>3 places where session state can drift.</strong></div></div></div><div class="workspace-ui-tool">read auth.ts · search session · run tests</div></div>
							<div class="workspace-ui-panel" role="tabpanel" data-persona-panel="analyst" hidden><div class="workspace-ui-message"><div class="workspace-ui-avatar agent">C</div><div class="workspace-ui-message-content"><div class="workspace-ui-message-label">Analyst</div><div class="workspace-ui-message-text">The biggest uncertainty is the session boundary. I mapped <strong>four assumptions</strong> that need evidence before changing code.</div></div></div><div class="workspace-ui-tool">search auth · inspect config · map assumptions</div></div>
							<div class="workspace-ui-panel" role="tabpanel" data-persona-panel="reviewer" hidden><div class="workspace-ui-message"><div class="workspace-ui-avatar agent">C</div><div class="workspace-ui-message-content"><div class="workspace-ui-message-label">Reviewer</div><div class="workspace-ui-message-text">The risky paths are the unhappy ones: expired sessions, retries, and <strong>missing coverage around logout.</strong></div></div></div><div class="workspace-ui-tool">inspect tests · check regressions · report gaps</div></div>
							<div class="workspace-ui-panel" role="tabpanel" data-persona-panel="planner" hidden><div class="workspace-ui-message"><div class="workspace-ui-avatar agent">C</div><div class="workspace-ui-message-content"><div class="workspace-ui-message-label">Planner</div><div class="workspace-ui-message-text">I split the work into <strong>three verifiable steps</strong>, starting with a trace of the request lifecycle.</div></div></div><div class="workspace-ui-tool">write plan · define checks · sequence work</div></div>
						</div>
					</section>
				</div>
			</div>
		</section>

		<section class="workspace-section" aria-labelledby="start-title">
			<div class="workspace-section-heading"><h2 id="start-title">Start where the work is</h2></div>
			<div class="workspace-grid">
				<a class="workspace-card workspace-card-link" href="getting-started.html">
					<span class="workspace-card-tag">01 / setup</span><h3>Connect your model</h3><p>Install Cast, point it at OpenRouter, Ollama, vLLM, or any OpenAI-compatible endpoint, and start in your repository.</p><span class="workspace-card-arrow">Read the quick start →</span>
				</a>
				<div class="workspace-card"><span class="workspace-card-tag">02 / choose a lens</span><h3>Personas for the moment</h3><p>Switch perspective without changing your tools or context. Use the persona tabs in the workspace preview to see how the investigation changes.</p></div>
			</div>
		</section>

		<section class="workspace-section" aria-labelledby="install-title">
			<div class="workspace-section-heading"><h2 id="install-title">Install Cast</h2></div>
			<div class="workspace-install">
				<div class="install-block"><div class="label">macOS / Linux</div><div class="workspace-code"><code>curl -fsSL https://aa-blinov.github.io/cast/install | bash</code><button class="workspace-copy-btn" type="button" aria-label="Copy macOS and Linux install command" title="Copy command">${LANDING_COPY_ICON_SVG}</button></div></div>
				<div class="install-block"><div class="label">Windows / PowerShell</div><div class="workspace-code"><code>irm https://aa-blinov.github.io/cast/install.ps1 | iex</code><button class="workspace-copy-btn" type="button" aria-label="Copy Windows install command" title="Copy command">${LANDING_COPY_ICON_SVG}</button></div></div>
			</div>
		</section>

		<section class="workspace-section" aria-labelledby="docs-title">
			<div class="workspace-section-heading"><h2 id="docs-title">Documentation</h2></div>
			<nav class="workspace-docs" aria-label="Documentation">
				${NAV_ORDER.slice(0, 12).map((item) => `<a href="${item.file.replace(".md", ".html")}">${item.label}</a>`).join("\n\t\t\t\t")}
			</nav>
			<div class="workspace-footer"><a href="https://github.com/aa-blinov/cast">GitHub</a><span aria-hidden="true">·</span><a href="https://github.com/aa-blinov/cast/blob/master/LICENSE">MIT License</a></div>
		</section>
	</main>
</div>
<script>
document.querySelectorAll('[data-persona-switch]').forEach((button) => {
	button.addEventListener('click', () => {
		const persona = button.dataset.personaSwitch;
		document.querySelectorAll('[data-persona-switch]').forEach((item) => {
			const active = item === button;
			item.classList.toggle('active', active);
			item.setAttribute('aria-selected', String(active));
		});
		document.querySelectorAll('[data-persona-panel]').forEach((panel) => {
			panel.hidden = panel.dataset.personaPanel !== persona;
		});
	});
});

document.querySelectorAll('.workspace-copy-btn').forEach((button) => {
	const label = button.getAttribute('aria-label') || 'Copy command';
	button.addEventListener('click', async () => {
		const code = button.closest('.install-block')?.querySelector('code')?.textContent ?? '';
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code);
			else {
				const textarea = document.createElement('textarea');
				textarea.value = code;
				textarea.style.cssText = 'position:fixed;opacity:0';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				textarea.remove();
			}
			button.classList.add('copied');
			button.innerHTML = '${LANDING_CHECK_ICON_SVG}';
			button.title = 'Copied';
			button.setAttribute('aria-label', 'Copied');
			window.setTimeout(() => {
				button.classList.remove('copied');
				button.innerHTML = '${LANDING_COPY_ICON_SVG}';
				button.title = 'Copy command';
				button.setAttribute('aria-label', label);
			}, 1200);
		} catch {}
	});
});
</script>
</body>
</html>`;

// ── Doc page template ───────────────────────────────────────────────────────
function docPage(title, bodyHtml, activeFile) {
	const sidebarLinks = NAV_ORDER.map((item) => {
		const cls = item.file === activeFile ? ' class="active"' : "";
		return `\t\t\t<a href="${item.file.replace(".md", ".html")}"${cls}>${item.label}</a>`;
	}).join("\n");

	// Prev/next sequential navigation (wraps: last → first)
	const idx = NAV_ORDER.findIndex((item) => item.file === activeFile);
	const prev = idx > 0 ? NAV_ORDER[idx - 1] : NAV_ORDER[NAV_ORDER.length - 1];
	const next = idx < NAV_ORDER.length - 1 ? NAV_ORDER[idx + 1] : NAV_ORDER[0];
	const docNav = `\n\t\t<nav class="doc-nav">\n\t\t\t<a href="${prev.file.replace(".md", ".html")}" class="doc-nav-prev">← ${prev.label}</a>\n\t\t\t<a href="${next.file.replace(".md", ".html")}" class="doc-nav-next">${next.label} →</a>\n\t\t</nav>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
<title>${title} — cast</title>
<meta name="description" content="${title} documentation for cast, a role-based terminal agent harness.">
<link rel="icon" type="image/svg+xml" href="assets/favicon.svg">
<style>${CSS}</style>
</head>
<body>
<header class="header">
	<button class="menu-toggle" aria-label="Menu">&#9776;</button>
	<a href="index.html" class="header-logo" aria-label="cast home"><img src="assets/favicon.svg" alt="cast logo"></a>
	<span class="header-badge">v${PACKAGE_VERSION}</span>
	<div class="header-links">
		<a href="index.html">Home</a>
		<a href="https://github.com/aa-blinov/cast">GitHub</a>
	</div>
</header>

<div class="sidebar-backdrop"></div>
<nav class="sidebar">
	<div class="sidebar-section">
		<div class="sidebar-section-title">Documentation</div>
${sidebarLinks}
	</div>
</nav>

<main class="main">
	<article class="content">
		${bodyHtml}
	</article>${docNav}
</main>

<script>
// Mobile sidebar toggle with backdrop
(function() {
	const sidebar = document.querySelector('.sidebar');
	const backdrop = document.querySelector('.sidebar-backdrop');
	const toggle = document.querySelector('.menu-toggle');
	if (!toggle) return;
	function close() { sidebar.classList.remove('open'); backdrop.classList.remove('visible'); }
	function open() { sidebar.classList.add('open'); backdrop.classList.add('visible'); }
	toggle.addEventListener('click', () => {
		if (sidebar.classList.contains('open')) close(); else open();
	});
	backdrop.addEventListener('click', close);
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
</script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
<script>
// ── Mermaid viewer with zoom + diagram/code toggle ──
document.addEventListener('DOMContentLoaded', () => {
	const blocks = document.querySelectorAll('pre.mermaid');
	if (!blocks.length) return;

	mermaid.initialize({ startOnLoad: false, theme: 'dark' });

	blocks.forEach((pre, i) => {
		const raw = atob(pre.dataset.raw || '') || pre.textContent;

		// Build viewer shell
		const viewer = document.createElement('div');
		viewer.className = 'mermaid-viewer';

		const toolbar = document.createElement('div');
		toolbar.className = 'mermaid-toolbar';
		toolbar.innerHTML =
			'<button class="active" data-view="diagram">Diagram</button>' +
			'<button data-view="code">Code</button>' +
			'<span class="zoom-label">Zoom:</span>' +
			'<button data-zoom="out">−</button>' +
			'<button data-zoom="reset">100%</button>' +
			'<button data-zoom="in">+</button>';

		const diagram = document.createElement('div');
		diagram.className = 'mermaid-diagram';

		const code = document.createElement('pre');
		code.className = 'mermaid-code';
		code.textContent = raw;

		viewer.append(toolbar, diagram, code);
		pre.replaceWith(viewer);

		// Render mermaid
		const id = 'mermaid-' + i;
		mermaid.render(id, raw).then(({ svg }) => {
			diagram.innerHTML = svg;
		}).catch(err => {
			diagram.innerHTML = '<pre style="color:#fb7185">' + err.message + '</pre>';
		});

		// Zoom + pan state
		let zoom = 1, panX = 0, panY = 0, dragging = false, startX, startY;
		const zoomLabel = toolbar.querySelector('[data-zoom="reset"]');
		const applyTransform = () => {
			const svg = diagram.querySelector('svg');
			if (svg) svg.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
		};

		// Drag to pan (mouse + touch)
		const getPos = e => e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY };
		const onStart = e => {
			const p = getPos(e); dragging = true;
			startX = p.x - panX; startY = p.y - panY;
			diagram.classList.add('dragging');
		};
		const onMove = e => {
			if (!dragging) return;
			const p = getPos(e);
			panX = p.x - startX; panY = p.y - startY;
			applyTransform();
		};
		const onEnd = () => { dragging = false; diagram.classList.remove('dragging'); };

diagram.addEventListener('mousedown', e => { onStart(e); e.preventDefault(); });
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onEnd);
		diagram.addEventListener('touchstart', e => { if (e.touches.length === 1) onStart(e); }, { passive: true });
		document.addEventListener('touchmove', e => { if (e.touches.length === 1 && dragging) onMove(e); }, { passive: true });
		document.addEventListener('touchend', onEnd);

		// Pinch to zoom (touch)
		let lastPinchDist = 0;
		diagram.addEventListener('touchstart', e => {
			if (e.touches.length === 2) {
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				lastPinchDist = Math.hypot(dx, dy);
			}
		}, { passive: true });
		diagram.addEventListener('touchmove', e => {
			if (e.touches.length === 2) {
				e.preventDefault();
				const dx = e.touches[0].clientX - e.touches[1].clientX;
				const dy = e.touches[0].clientY - e.touches[1].clientY;
				const dist = Math.hypot(dx, dy);
				if (lastPinchDist > 0) {
					zoom = Math.min(3, Math.max(0.25, zoom * (dist / lastPinchDist)));
					applyTransform();
				}
				lastPinchDist = dist;
			}
		});
		diagram.addEventListener('touchend', e => { if (e.touches.length < 2) lastPinchDist = 0; });

		// Zoom + view toggle buttons
		toolbar.addEventListener('click', e => {
			const btn = e.target.closest('button');
			if (!btn) return;

			if (btn.dataset.view) {
				toolbar.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
				btn.classList.add('active');
				diagram.style.display = btn.dataset.view === 'diagram' ? '' : 'none';
				code.classList.toggle('visible', btn.dataset.view === 'code');
				return;
			}

			if (btn.dataset.zoom === 'in') zoom = Math.min(3, zoom + 0.25);
			else if (btn.dataset.zoom === 'out') zoom = Math.max(0.25, zoom - 0.25);
			else if (btn.dataset.zoom === 'reset') { zoom = 1; panX = 0; panY = 0; }
			applyTransform();
		});
	});
});
</script>
</body>
</html>`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getDescription(file) {
	const descs = {
		"getting-started.md": "Install, first run, provider setup",
		"cli-reference.md": "All flags and subcommands",
		"interactive-commands.md": "All slash commands in the TUI",
		"tools.md": "Built-in tools the agent uses",
		"personas.md": "Built-in personas, custom frontmatter, and tool/skill allowlists",
		"persona-research.md": "Research on role prompting and agent behavior",
		"subagents.md": "Sub-agent delegation, parallel execution, task tool, and roles",
		"skills.md": "Agent Skills spec, loading, creating",
		"rules.md": "Cursor-compatible rule system",
		"mcp-servers.md": "MCP configuration",
		"context-files.md": "AGENTS.md / CLAUDE.md hierarchy",
		"sessions.md": "Persistence, resume, compaction",
		"worktrees.md": "Isolated git worktree sessions",
		"plan-mode.md": "Explore and plan before implementing",
		"reasoning.md": "Reasoning levels and provider support",
		"configuration.md": "Settings, env vars, .cast/ layout",
		"themes.md": "Color themes for the TUI",
		"non-interactive-mode.md": "cast run and JSON output",
		"eval-behavior.md": "Real-model behavioral contracts and signals",
		"eval-methodology.md": "Scoreboard methodology, repeats, traces, and regressions",
		"architecture.md": "Source layout and design decisions",
		"infrastructure.md": "Daemon, TUI/web clients, lifecycle, and auth",
		"api.md": "Stable daemon integration API and OpenAPI specification",
		"eval-scoreboard.md": "Per-model certification scores against the behavior eval suite",
		"changelog.md": "Version history and feature highlights",
	};
	return descs[file] || "";
}

function mdToHtml(md) {
	return marked.parse(md);
}

// Certification bar a model's score must clear to show as "certified" below —
// kept as a plain literal (not imported) because this script runs under plain
// `node`, not `tsx`, and can't load evals/lib/scoreboard.ts's TS source; the
// authoritative value (and the `certified` boolean actually used per row) is
// computed on the eval side and simply carried in the JSON as-is.
const SCOREBOARD_CERTIFICATION_THRESHOLD = 0.8;

function formatDuration(ms) {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function formatTokens(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

function percentile(sorted, p) {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

function tokenStats(entry, key) {
	const values = entry.results.flatMap((result) => result[key] ?? []).sort((a, b) => a - b);
	const avg = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
	return [avg, percentile(values, 50), percentile(values, 75), percentile(values, 95), percentile(values, 99)]
		.map(formatTokens)
		.join(" / ");
}

function formatGroupScore(group) {
	if (!group || group.casesTotal === 0) return "—";
	return `${(group.score * 100).toFixed(0)}% (${group.casesPassed}/${group.casesTotal})`;
}

/** Renders docs/eval-scoreboard.json (a `Record<model, ScoreboardEntry>`,
 * written by `evals/run.ts --scoreboard`) into the Model Scoreboard page body.
 * Reuses the same `.table-wrap`/`.content table` CSS every markdown table on
 * this site already gets — no new styles needed. */
function scoreboardToHtml(scoreboard) {
	const entries = Object.values(scoreboard);
	if (entries.length === 0) {
		return `<p>No scoreboard data yet. Populate it by running the full behavior suite with
			<code>--scoreboard</code> (it runs three attempts per case):</p>
			<pre><code>node --import tsx evals/run.ts -m &lt;model&gt; --scoreboard</code></pre>
			<p>See <a href="eval-methodology.html">Eval Methodology</a> for what the score means.</p>`;
	}

	entries.sort((a, b) => b.score - a.score);

	const rows = entries
		.map((e) => {
			const pct = (e.score * 100).toFixed(1);
			const badge = e.certified
				? '<span class="badge-pass">✓ certified</span>'
				: '<span class="badge-fail">not yet</span>';
			const date = e.timestamp.slice(0, 10);
			const inputTokens = tokenStats(e, "promptTokens");
			const outputTokens = tokenStats(e, "completionTokens");
			const timing = [e.avgDurationMs, e.medianDurationMs, e.p75DurationMs, e.p95DurationMs, e.p99DurationMs]
				.map((ms) => formatDuration(ms ?? 0))
				.join(" / ");
			const turns = [e.avgTurns, e.medianTurns, e.p75Turns, e.p95Turns, e.p99Turns]
				.map((value) => Number(value ?? 0).toFixed(1))
				.join(" / ");
			const providerUrl = e.providerUrl ? `<code>${e.providerUrl}</code>` : "—";
			const reasoning = e.reasoningLevel ? `<code>${e.reasoningLevel}</code>` : "—";
			return `<tr><td>${e.model}</td><td>${reasoning}</td><td>${pct}%</td><td>${e.casesPassed}/${e.casesTotal}</td><td>${badge}</td><td>${formatGroupScore(e.core)}</td><td>${formatGroupScore(e.chain)}</td><td>${timing}</td><td>${turns}</td><td>${inputTokens}</td><td>${outputTokens}</td><td>${providerUrl}</td><td>${date}</td></tr>`;
		})
		.join("\n");

	const mainTable = `<div class="table-wrap"><table><thead><tr>
		<th>Model</th><th>Reasoning</th><th>Score</th><th>Passed</th><th>Certified</th><th>Core</th><th>Chain</th><th>Time (avg/p50/p75/p95/p99)</th><th>Turns (avg/p50/p75/p95/p99)</th><th>Input tokens (avg/p50/p75/p95/p99)</th><th>Output tokens (avg/p50/p75/p95/p99)</th><th>Provider URL</th><th>Last updated</th>
	</tr></thead><tbody>
${rows}
	</tbody></table></div>`;

	const signalSections = entries
		.map((e) => {
			const signalRows = Object.entries(e.bySignal)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([signal, s]) => `<tr><td>${signal}</td><td>${s.passed}/${s.total}</td></tr>`)
				.join("\n");
			return `<details><summary>${e.model} — signal breakdown</summary>
	<div class="table-wrap"><table><thead><tr><th>Signal</th><th>Passed</th></tr></thead><tbody>
${signalRows}
	</tbody></table></div>
</details>`;
		})
		.join("\n");

	return `<p>This scoreboard answers one question: how reliably does a model operate the <em>Cast</em> harness?
		It is not a general intelligence ranking. A model is <strong>certified</strong> once it clears ${(SCOREBOARD_CERTIFICATION_THRESHOLD * 100).toFixed(0)}%
		of the full behavior suite across exactly three fresh attempts per case, where every attempt on a case must
		agree (a case that only passes sometimes doesn't count). <strong>Core</strong>/<strong>Chain</strong> break
		the same score down by single-turn tool contracts vs. multi-turn stateful workflows (see
		<a href="eval-behavior.html">Behavior Evals</a>).
		Tokens are per-attempt averages; the time and turns columns are avg/median/p75/p95/p99 over every
		individual attempt. See
		<a href="eval-methodology.html">Eval Methodology</a>
		for the full methodology.</p>
${mainTable}
<h2>Per-signal breakdown</h2>
${signalSections}`;
}

// ── Build ───────────────────────────────────────────────────────────────────
mkdirSync(SITE, { recursive: true });

// The Pages copy is generated from the exact object the daemon serves, so the
// static link is a reviewable snapshot rather than a hand-maintained duplicate.
mkdirSync(join(SITE, "openapi"), { recursive: true });
writeFileSync(join(SITE, "openapi", "v1.json"), `${JSON.stringify(apiV1OpenApiDocument, null, 2)}\n`);
console.log("  openapi/v1.json");

// Copy install scripts for backward compatibility
cpSync(join(ROOT, "install.sh"), join(SITE, "install"));
cpSync(join(ROOT, "install.ps1"), join(SITE, "install.ps1"));
writeFileSync(join(SITE, ".nojekyll"), "");

// Same banner asset the README uses — an <img> scales for free (the
// browser's normal image layout, no measuring/JS involved), unlike the
// text-in-a-<pre> version this replaced, which needed a runtime fit script
// to avoid overflowing on narrow phones and still had its own timing bugs.
mkdirSync(join(SITE, "assets"), { recursive: true });
cpSync(join(ROOT, "assets", "cast-banner.svg"), join(SITE, "assets", "cast-banner.svg"));
cpSync(join(ROOT, "src", "server", "public", "favicon.svg"), join(SITE, "assets", "favicon.svg"));

// Landing page
writeFileSync(join(SITE, "index.html"), LANDING_HTML);
console.log("  index.html");

// Doc pages
const SCOREBOARD_PATH = join(DOCS, "eval-scoreboard.json");
for (const item of NAV_ORDER) {
	const bodyHtml =
		item.file === "eval-scoreboard.md"
			? scoreboardToHtml(existsSync(SCOREBOARD_PATH) ? JSON.parse(readFileSync(SCOREBOARD_PATH, "utf-8")) : {})
			: mdToHtml(readFileSync(join(DOCS, item.file), "utf-8"));
	const html = docPage(item.label, bodyHtml, item.file);
	const outFile = item.file.replace(".md", ".html");
	writeFileSync(join(SITE, outFile), html);
	console.log(`  ${outFile}`);
}

console.log(`\nSite built: ${SITE} (${NAV_ORDER.length + 1} pages)`);
