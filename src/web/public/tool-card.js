import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { FilePreviewModal } from "./file-preview.js";
import { icons } from "./icons.js";
import { getToolCardOpen, getToolCardPreviewSrc, setToolCardOpen, setToolCardPreviewSrc } from "./tool-card-state.js";

const UNICODE_ESCAPE_RE = /\\u[\dA-Fa-f]{4}/;

const html = htm.bind(h);

function formatValue(value, indent) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.map((item, index) => `${indent}[${index}]\n${formatValue(item, `${indent}  `)}`).join("\n");
	}
	if (value && typeof value === "object") {
		return Object.entries(value)
			.map(([key, nestedValue]) => {
				const formatted = formatValue(nestedValue, `${indent}  `);
				return formatted.includes("\n") ? `${indent}${key}:\n${formatted}` : `${indent}${key}: ${formatted}`;
			})
			.join("\n");
	}
	return `${indent}${JSON.stringify(value)}`;
}

function formatArgsFull(args) {
	if (!args) return "";
	try {
		const entries = Object.entries(JSON.parse(args));
		if (entries.length === 0) return "";
		return entries
			.map(([key, value]) => {
				const formatted = typeof value === "string" ? value : formatValue(value, "  ");
				return formatted.includes("\n") ? `${key}:\n${formatted}` : `${key}: ${formatted}`;
			})
			.join("\n");
	} catch {
		return args;
	}
}

function isMcpTool(name) {
	return name.startsWith("mcp_");
}

function mcpToolLabel(name) {
	return name.slice(4).replace(/_/g, " · ");
}

function formatToolResult(name, result) {
	if (name === "todo_write") {
		try {
			return formatValue(JSON.parse(result), "");
		} catch {
			return result;
		}
	}
	if (!UNICODE_ESCAPE_RE.test(result)) return result;
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

export function ToolCard({ call, renderMarkdown }) {
	// Local useState wraps reads from the shared map: the initializer pulls
	// the saved value on mount (so a ToolCard that re-mounts inside a
	// settled Message after `assistant_message` resumes the user's
	// expanded/preview state), and the setter mirrors each change back
	// into the map so a later remount sees it too. Map keyed by
	// call.id — same key on the JSX (see BlockView in streaming-blocks.js
	// and message.js) so streaming and settled instances read/write the
	// same entry.
	const [open, _setOpen] = useState(() => getToolCardOpen(call.id));
	const [previewSrc, _setPreviewSrc] = useState(() => getToolCardPreviewSrc(call.id));
	const setOpen = (updater) => {
		_setOpen((prev) => {
			const next = typeof updater === "function" ? updater(prev) : updater;
			setToolCardOpen(call.id, next);
			return next;
		});
	};
	const setPreviewSrc = (value) => {
		_setPreviewSrc((prev) => {
			const next = typeof value === "function" ? value(prev) : value;
			setToolCardPreviewSrc(call.id, next);
			return next;
		});
	};
	const statusClass = call.status || "running";
	const args = formatArgsFull(call.args);
	const mcp = isMcpTool(call.name);
	const hasResult = Boolean(call.result) || Boolean(call.images?.length);
	return html`
		<div class="tool-card">
			<div
				class="tool-card-header${hasResult ? " clickable" : ""}"
				data-tool=${call.name}
				onClick=${hasResult ? () => setOpen((openState) => !openState) : undefined}
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
					${call.images.map((src, index) => html`<img key=${index} src=${src} class="message-image" onClick=${() => setPreviewSrc(src)} />`)}
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
					? html`<div class="tool-card-result" dangerouslySetInnerHTML=${{ __html: renderMarkdown(formatToolResult(call.name, call.result)) }}></div>`
					: html`<div class="tool-card-result">${formatToolResult(call.name, call.result)}</div>`)
			}
		</div>
	`;
}
