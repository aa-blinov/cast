import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { icons } from "./icons.js";
import { useModalFocusTrap } from "./modal-focus.js";

const html = htm.bind(h);

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
const EXT_TO_HLJS = {
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	ts: "typescript",
	tsx: "typescript",
	json: "json",
	jsonc: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	ini: "ini",
	cfg: "ini",
	conf: "ini",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "bash",
	py: "python",
	rb: "ruby",
	go: "go",
	rs: "rust",
	java: "java",
	kt: "kotlin",
	c: "c",
	h: "c",
	cpp: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sql: "sql",
	css: "css",
	scss: "scss",
	less: "less",
	html: "xml",
	htm: "xml",
	xml: "xml",
	svg: "xml",
};
const FS_TABLE_EXTENSIONS = new Set(["csv", "tsv"]);
const FS_PREVIEW_MAX_BYTES = 512 * 1024;
const FS_TABLE_MAX_ROWS = 1000;

let markedModulePromise = null;
function loadMarked() {
	if (!markedModulePromise) markedModulePromise = import("/vendor/marked.min.mjs");
	return markedModulePromise;
}

let hljsModulePromise = null;
function loadHljs() {
	if (!hljsModulePromise) hljsModulePromise = import("/vendor/highlight.min.mjs");
	return hljsModulePromise;
}

export function detectDelimiter(text, ext) {
	if (ext === "tsv") return "\t";
	const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
	const candidates = [",", ";", "\t", "|"];
	let best = ",";
	let bestCount = -1;
	for (const delimiter of candidates) {
		const count = firstLine.split(delimiter).length - 1;
		if (count > bestCount) {
			best = delimiter;
			bestCount = count;
		}
	}
	return bestCount > 0 ? best : ",";
}

export function parseDelimited(text, delimiter) {
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
				} else inQuotes = false;
			} else field += ch;
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
		} else if (ch !== "\r") field += ch;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	while (rows.length > 0 && rows.at(-1).length === 1 && rows.at(-1)[0] === "") rows.pop();
	return rows;
}

export function fileExtOf(path) {
	const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function fileName(path) {
	return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
}

export function FilePreviewModal({ path, onClose, downloadHref, previewHref }) {
	const [content, setContent] = useState(null);
	const [tooLarge, setTooLarge] = useState(false);
	const [error, setError] = useState(null);
	const [enhanced, setEnhanced] = useState(null);
	const modalRef = useModalFocusTrap(!!path, ".modal-close");
	const [copied, setCopied] = useState(false);
	const ext = path ? fileExtOf(path) : "";
	const isImage = FS_IMAGE_EXTENSIONS.has(ext);
	const isPdf = !isImage && ext === "pdf";
	const isTable = !isImage && !isPdf && FS_TABLE_EXTENSIONS.has(ext);
	const isMarkdown = ext === "md" || ext === "markdown";
	const hljsLang = EXT_TO_HLJS[ext];
	const isText = !isImage && !isPdf && !isTable && (ext === "" || FS_TEXT_EXTENSIONS.has(ext));
	const fetchesContent = isText || isTable;

	useEffect(() => {
		if (!path) return;
		const onKey = (event) => event.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [path, onClose]);

	// fetchesContent is derived from path; listing it would refetch on every
	// unrelated render while the popup is loading or highlighting.
	useEffect(() => {
		setContent(null);
		setTooLarge(false);
		setError(null);
		setCopied(false);
		if (!path || !fetchesContent) return;
		let cancelled = false;
		(async () => {
			try {
				const response = await fetch(`${window.location.origin}${downloadHref}`);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const len = Number(response.headers.get("content-length") ?? 0);
				if (len > FS_PREVIEW_MAX_BYTES) {
					if (!cancelled) setTooLarge(true);
					return;
				}
				const text = await response.text();
				if (!cancelled) setContent(text);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, downloadHref, fetchesContent]);

	useEffect(() => {
		setEnhanced(null);
		if (content == null) return;
		let cancelled = false;
		if (isMarkdown) {
			loadMarked()
				.then(({ marked }) => {
					if (!cancelled) setEnhanced({ kind: "markdown", html: marked.parse(content) });
				})
				.catch(() => {
					if (!cancelled) setEnhanced({ kind: "error" });
				});
		} else if (hljsLang) {
			loadHljs()
				.then(({ default: hljs }) => {
					if (cancelled) return;
					const lines = content.split("\n").map((line) => {
						const result = hljs.getLanguage(hljsLang)
							? hljs.highlight(line || " ", { language: hljsLang })
							: hljs.highlightAuto(line || " ");
						return result.value;
					});
					setEnhanced({ kind: "code", lines });
				})
				.catch(() => {
					if (!cancelled) setEnhanced({ kind: "error" });
				});
		}
		return () => {
			cancelled = true;
		};
	}, [content, isMarkdown, hljsLang]);

	if (!path) return null;
	const name = fileName(path);
	let body;
	if (isImage) body = html`<img class="fs-preview-image" src=${previewHref} alt=${name} />`;
	else if (isPdf) body = html`<iframe class="fs-preview-pdf" src=${previewHref} title=${name}></iframe>`;
	else if (error) body = html`<div class="diff-empty diff-empty-error">${error}</div>`;
	else if (!isText && !isTable) body = html`<div class="diff-empty">No preview for this file type.</div>`;
	else if (tooLarge) body = html`<div class="diff-empty">Too large to preview — use Download instead.</div>`;
	else if (content == null || ((isMarkdown || hljsLang) && !enhanced))
		body = html`<div class="diff-empty">Loading…</div>`;
	else if (isTable) {
		const rows = parseDelimited(content, detectDelimiter(content, ext));
		const shown = rows.slice(0, FS_TABLE_MAX_ROWS);
		body =
			rows.length === 0
				? html`<div class="diff-empty">Empty file.</div>`
				: html`
			<div class="fs-preview-table-wrap"><table class="fs-preview-table">
				<thead><tr>${shown[0].map((cell, i) => html`<th key=${i}>${cell}</th>`)}</tr></thead>
				<tbody>${shown.slice(1).map((row, ri) => html`<tr key=${ri}>${row.map((cell, ci) => html`<td key=${ci}>${cell}</td>`)}</tr>`)}</tbody>
			</table>${rows.length > FS_TABLE_MAX_ROWS ? html`<div class="fs-preview-table-note">Showing first ${FS_TABLE_MAX_ROWS} of ${rows.length} rows — download for the rest.</div>` : null}</div>`;
	} else if (isMarkdown && enhanced?.kind === "markdown")
		body = html`<div class="fs-preview-markdown message-content" dangerouslySetInnerHTML=${{ __html: enhanced.html }} />`;
	else if (hljsLang && enhanced?.kind === "code")
		body = html`
		<div class="fs-preview-code-wrap"><div class="fs-preview-gutter" aria-hidden="true">${enhanced.lines.map((_, i) => html`<span key=${i}>${i + 1}</span>`)}</div>
		<pre class="fs-preview-text fs-preview-code hljs"><code>${enhanced.lines.map((line, i) => html`<span key=${i} class="fs-preview-line" dangerouslySetInnerHTML=${{ __html: line }} />`)}</code></pre></div>`;
	else {
		const lines = content.split("\n");
		body = html`<div class="fs-preview-code-wrap"><div class="fs-preview-gutter" aria-hidden="true">${lines.map((_, i) => html`<span key=${i}>${i + 1}</span>`)}</div>
		<pre class="fs-preview-text fs-preview-code"><code>${lines.map((line, i) => html`<span key=${i} class="fs-preview-line">${line || " "}</span>`)}</code></pre></div>`;
	}

	const copyTarget = isImage || isPdf ? previewHref : content;
	const copyDisabled = isImage || isPdf ? false : copyTarget == null;
	const handleCopy = async () => {
		if (copyTarget == null) return;
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(copyTarget);
			} else {
				const ta = document.createElement("textarea");
				ta.value = copyTarget;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
			}
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* copy denied — leave UI unchanged */
		}
	};

	return html`<div class="modal-backdrop" onClick=${onClose}><div class="modal modal-preview" role="dialog" aria-modal="true" aria-label="File preview" tabIndex="-1" ref=${modalRef} onClick=${(e) => e.stopPropagation()}>
		<div class="modal-header"><span title=${path}>${name}</span><div style=${{ display: "flex", gap: "6px", alignItems: "center" }}>
			<button class="modal-btn icon-btn" onClick=${handleCopy} disabled=${copyDisabled} title=${copied ? "Copied" : "Copy"} aria-label="Copy file contents"><${copied ? icons.check : icons.clipboard} /></button><a class="modal-btn icon-btn" href=${downloadHref} download title="Download"><${icons.arrowDownTray} /></a><button class="modal-close" onClick=${onClose} aria-label="Close"><${icons.xMark} /></button>
		</div></div><div class="fs-preview-body">${body}</div>
	</div></div>`;
}
