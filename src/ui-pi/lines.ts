import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type OpenFence, type RenderedLine, renderMarkdownLines, trailingOpenFence } from "../ui/markdown-terminal.ts";
import { railMuted, spanProps } from "../ui/span-style.ts";
import { theme } from "../ui/themes/index.ts";
import { formatTimeout, isMcpTool, mcpToolLabel, oneLineSummary, parseToolSummary } from "../ui/tool-summary.ts";
import type { ChatMessage, StreamBlock, ToolCallEntry } from "../ui/useAgentSession.ts";
import { band, paint } from "./paint.ts";

// The transcript as rows of text, with no terminal in it: the same words, rails
// and colours the Ink transcript draws, so the two front ends read alike. A row
// never exceeds `width`; the scroll view owns everything taller than the screen.

const GUTTER_WIDTH = 2;
const SYSTEM_PREFIX = "[system] ";
const THINK_TAG_RE = /<\/?think[^>]*>/g;

export function bodyWidth(width: number): number {
	return Math.max(20, width - GUTTER_WIDTH);
}

interface RailOptions {
	gutter: string;
	/** `▌` for a turn, `│` for scaffolding, `┆` for reasoning. */
	bar?: string;
	/** Rail for the lines after the first, where it differs from `bar` (a notice's `ⓘ`). */
	continuationBar?: string;
	/** The speaker, on a row of its own. */
	label?: string;
	dimText?: boolean;
	/** Sets the text on a band of this colour, as wide as `width`: the person's turns, told apart from the agent's. */
	bg?: string;
	width?: number;
}

/** Rendered markdown lines behind one rail. */
export function railLines(lines: RenderedLine[], options: RailOptions): string[] {
	const bar = options.bar ?? "▌";
	const out: string[] = [];
	if (options.label) {
		out.push(
			paint(`${bar} `, { color: options.gutter }) +
				paint(options.label, { color: options.gutter, bold: true, dim: options.dimText }),
		);
	}
	lines.forEach((line, i) => {
		const rail = options.label || i > 0 ? (options.continuationBar ?? bar) : bar;
		const text = line.spans
			.map((span) => {
				const { color, bold, italic, dimColor, underline } = spanProps(span);
				return paint(span.text, {
					color,
					bold,
					italic,
					underline,
					bg: options.bg,
					dim: Boolean(options.dimText || dimColor),
				});
			})
			.join("");
		const body = options.bg && options.width ? band(text, options.width - 2, options.bg) : text;
		out.push(paint(`${rail} `, { color: options.gutter }) + body);
	});
	return out;
}

/** Tool name as the row shows it: an MCP tool reads `server – tool`. */
function toolLabel(name: string): string {
	return isMcpTool(name) ? mcpToolLabel(name) : name;
}

/** What the summary says, as plain text plus the paint each piece takes. */
function summaryPieces(
	call: ToolCallEntry,
	live: boolean,
): Array<{ text: string; style: "summary" | "added" | "removed" | "meta" }> {
	const model = parseToolSummary(call.name, call.args);
	const flat = (text: string) => (live ? oneLineSummary(text) : text);
	switch (model.kind) {
		case "edit":
			return [
				{ text: `${model.path} `, style: "summary" },
				{ text: `+${model.added}`, style: "added" },
				{ text: " ", style: "summary" },
				{ text: `−${model.removed}`, style: "removed" },
			];
		case "bash":
			return [
				{ text: flat(model.command), style: "summary" },
				...(model.timeoutMs !== undefined
					? [{ text: ` · ${formatTimeout(model.timeoutMs)}`, style: "meta" as const }]
					: []),
			];
		case "read":
			return [{ text: `${model.path} – lines ${model.range}`, style: "summary" }];
		case "write":
			return [{ text: `${model.path} – ${model.lines} ${model.lines === 1 ? "line" : "lines"}`, style: "summary" }];
		default:
			return [{ text: flat(model.text), style: "summary" }];
	}
}

/**
 * One tool call. While it runs it is a single truncated row, so a long command
 * never pushes the rows under it around; once it has finished it wraps in full.
 */
export function toolRowLines(call: ToolCallEntry, width: number): string[] {
	const colors = theme();
	const failed = call.status === "error";
	const running = call.status === "running";
	// The rail says where the work is: bright while it runs, quiet once it is done.
	const rail = paint(`${failed ? "✗" : "│"} `, {
		color: failed ? colors.error : running ? colors.accent : railMuted(),
	});
	const name = paint(`${toolLabel(call.name)} `, { color: colors.muted, dim: true });
	const progress = running && call.name === "task" ? call.progress : undefined;
	const step = progress?.tool ? `↳ ${progress.tool.name} ${progress.tool.summary}`.trim() : "";
	const badge = progress
		? paint(
				`[${progress.subagent}${progress.status === "queued" ? " queued" : step ? ` ${step}` : ""} · ${progress.toolCount}] `,
				{ color: colors.accent },
			)
		: "";
	const tone = { color: failed ? colors.error : colors.muted, dim: !failed && !running };
	const summary = summaryPieces(call, running)
		.map((piece) => {
			if (piece.style === "added") return paint(piece.text, { color: colors.success });
			if (piece.style === "removed") return paint(piece.text, { color: colors.error });
			if (piece.style === "meta") return paint(piece.text, { color: colors.muted, dim: true });
			return paint(piece.text, tone);
		})
		.join("");
	const row = rail + name + badge + summary;
	if (running) return [truncateToWidth(row, width, "…")];
	return wrapTextWithAnsi(row, width).map((line) => truncateToWidth(line, width, "…"));
}

/** One ordered block of an assistant turn. */
export function blockLines(
	block: StreamBlock,
	options: { width: number; showReasoning: boolean; openFence?: OpenFence | null },
): string[] {
	const { width, showReasoning, openFence } = options;
	if (block.kind === "tool") return toolRowLines(block.call, width);
	if (block.kind === "thinking") {
		if (!showReasoning) return [];
		return railLines(
			renderMarkdownLines(block.text.replace(THINK_TAG_RE, ""), { width: bodyWidth(width), openFence }),
			{
				gutter: railMuted(),
				bar: "┆",
				label: block.continued ? undefined : "reasoning",
				dimText: true,
			},
		);
	}
	return railLines(renderMarkdownLines(block.text.replace(THINK_TAG_RE, ""), { width: bodyWidth(width), openFence }), {
		gutter: theme().agent,
		label: block.continued ? undefined : "agent",
	});
}

/** The fence still open after this message, to carry into the next one. */
export function fenceAfter(message: ChatMessage, incoming: OpenFence | null): OpenFence | null {
	let fence = incoming;
	if (message.role !== "assistant") return fence;
	for (const block of message.blocks ?? []) {
		if (block.kind !== "tool") fence = trailingOpenFence(block.text, fence);
	}
	return fence;
}

/** A committed message. */
export function messageLines(
	message: ChatMessage,
	options: { width: number; showReasoning: boolean; openFence?: OpenFence | null },
): string[] {
	const { width, showReasoning } = options;
	const colors = theme();
	if (message.role === "user") {
		return railLines(renderMarkdownLines(message.content, { width: bodyWidth(width) }), {
			gutter: colors.user,
			label: "you",
			bg: colors.bgSurface,
			width,
		});
	}
	if (message.role === "assistant") {
		let fence = options.openFence ?? null;
		const out: string[] = [];
		for (const block of message.blocks ?? []) {
			out.push(...blockLines(block, { width, showReasoning, openFence: fence }));
			if (block.kind !== "tool") fence = trailingOpenFence(block.text, fence);
		}
		return out;
	}
	if (message.role === "warning") {
		const text = message.content.startsWith(SYSTEM_PREFIX)
			? message.content.slice(SYSTEM_PREFIX.length)
			: message.content;
		return railLines(renderMarkdownLines(text, { width: bodyWidth(width) }), {
			gutter: colors.warning,
			bar: "ⓘ",
			continuationBar: "│",
			dimText: true,
		});
	}
	return railLines(renderMarkdownLines(`[${message.role}] ${message.content}`, { width: bodyWidth(width) }), {
		gutter: colors.muted,
		bar: "│",
	});
}
