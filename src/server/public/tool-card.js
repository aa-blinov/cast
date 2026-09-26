import htm from "htm";
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api.js";
import { FilePreviewModal } from "./file-preview.js";
import { icons } from "./icons.js";
import { pressable } from "./modal-focus.js";
import {
	getSubagentProgress,
	getToolCardOpen,
	getToolCardPreviewSrc,
	setToolCardOpen,
	setToolCardPreviewSrc,
	subscribeSubagentProgress,
} from "./tool-card-state.js";

const UNICODE_ESCAPE_RE = /\\u[\dA-Fa-f]{4}/;
const TASK_RESULT_RE = /^<task id="([^"]+)" subagent="([^"]*)" state="([^"]*)">/;

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
	return name.slice(4).replace(/_/g, " – ");
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

function parseArgs(args) {
	try {
		return JSON.parse(args) ?? {};
	} catch {
		return {};
	}
}

/** The task card's live line: who is working on what, what it's doing now,
 *  and the way into its session. */
function TaskLine({ call }) {
	const [progress, setProgress] = useState(() => getSubagentProgress(call.id));
	useEffect(
		() =>
			subscribeSubagentProgress((id) => {
				if (id === call.id) setProgress(getSubagentProgress(id));
			}),
		[call.id],
	);
	const args = parseArgs(call.args);
	const fromResult = TASK_RESULT_RE.exec(call.result ?? "");
	const taskId = progress?.taskId ?? fromResult?.[1] ?? args.task_id;
	const subagent = progress?.subagent ?? (fromResult?.[2] || args.subagent || "worker");
	const state = progress?.status ?? fromResult?.[3] ?? (call.status === "running" ? "running" : "");
	const running = state === "running";
	const doing = progress?.tool ? `${progress.tool.name} ${progress.tool.summary}`.trim() : "";
	const count = progress?.toolCount ? `${progress.toolCount} tool${progress.toolCount === 1 ? "" : "s"}` : "";
	const detail = running ? [doing && `↳ ${doing}`, count].filter(Boolean).join(" · ") : [state, count].filter(Boolean).join(" · ");
	return html`
		<div class="tool-card-task">
			<span class="tool-card-task-agent">${subagent}${progress?.background || args.background ? " · background" : ""}</span>
			<span class="tool-card-task-title">${args.description || progress?.description || ""}</span>
			${detail && html`<span class="tool-card-task-detail">${detail}</span>`}
			${
				taskId &&
				html`<button type="button" class="tool-card-task-btn" onClick=${() => window.dispatchEvent(new CustomEvent("cast:open-session", { detail: taskId }))}>Open</button>`
			}
			${
				running &&
				taskId &&
				progress?.parentSessionId &&
				html`<button type="button" class="tool-card-task-btn" onClick=${() => void api("POST", `/api/sessions/${progress.parentSessionId}/agents/${taskId}/cancel`).catch(() => {})}>Stop</button>`
			}
		</div>
	`;
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
				role=${hasResult ? "button" : undefined}
				tabIndex=${hasResult ? 0 : undefined}
				aria-expanded=${hasResult ? open : undefined}
				onClick=${hasResult ? () => setOpen((openState) => !openState) : undefined}
				onKeyDown=${hasResult ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((s) => !s); } } : undefined}
			>
				${mcp && html`<span class="tool-card-mcp-badge">MCP</span>`}
				<span class="tool-card-name">${mcp ? mcpToolLabel(call.name) : call.name}</span>
				<span class="tool-card-status ${statusClass}" role="img" aria-label=${statusClass} />
				${hasResult && html`<${open ? icons.chevronUp : icons.chevronDown} class="tool-card-toggle" />`}
			</div>
			${call.name === "task" && html`<${TaskLine} call=${call} />`}
			${args && html`<div class="tool-card-body">${args}</div>`}
			${
				open &&
				call.images?.length &&
				html`
				<div class="message-content message-images tool-card-images">
					${call.images.map((src, index) => html`<img key=${index} src=${src} class="message-image" loading="lazy" alt="Tool image ${index + 1}" ...${pressable(() => setPreviewSrc(src))} />`)}
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
					? html`<div class="tool-card-result md-body" dangerouslySetInnerHTML=${{ __html: renderMarkdown(formatToolResult(call.name, call.result)) }}></div>`
					: html`<div class="tool-card-result">${formatToolResult(call.name, call.result)}</div>`)
			}
		</div>
	`;
}
