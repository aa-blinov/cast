import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { DEFAULT_BASH_TIMEOUT_MS } from "../core/config.ts";
import { type OpenFence, type RenderedLine, renderMarkdownLines, trailingOpenFence } from "../ui/markdown-terminal.ts";
import { spanProps } from "../ui/span-style.ts";
import { theme } from "../ui/themes/index.ts";
import { formatTimeout, isMcpTool, mcpToolLabel, oneLineSummary, parseToolSummary } from "../ui/tool-summary.ts";
import type { ChatMessage, StreamBlock, ToolCallEntry } from "../ui/useAgentSession.ts";
import { paint } from "./paint.ts";

// The transcript as rows of text, with no terminal in it, set like a man page:
// the speaker is a section heading in bold capitals, what they said hangs at a
// four-column indent, and code sits four further in. Rank is carried by weight and
// case, state by a word or a mark, so nothing depends on colour or a coloured edge.
// A row never exceeds `width`; the scroll view owns everything taller than the screen.

export const INDENT = 4;
const CODE_INDENT = 4;
const SYSTEM_PREFIX = "[system] ";
const THINK_TAG_RE = /<\/?think[^>]*>/g;

export function bodyWidth(width: number): number {
	return Math.max(20, width - INDENT);
}

interface SectionOptions {
	/** The speaker, as a heading on a row of its own, set apart by a blank row above. */
	heading?: string;
	/** Secondary text (reasoning, notices): the muted colour instead of the foreground. */
	quiet?: boolean;
	/** A blank row above even without a heading (a notice). */
	gap?: boolean;
}

/** Markdown with code set deeper than prose, the extra indent counted when long lines wrap. */
function markdown(text: string, options: { width: number; openFence?: OpenFence | null }): RenderedLine[] {
	return renderMarkdownLines(text, { ...options, codeIndent: " ".repeat(CODE_INDENT) });
}

/** Rendered markdown lines under one heading, hung at the indent. */
export function sectionLines(lines: RenderedLine[], options: SectionOptions = {}): string[] {
	const colors = theme();
	const out: string[] = [];
	if (options.heading) {
		out.push("", paint(options.heading, { color: options.quiet ? colors.muted : undefined, bold: true }));
	} else if (options.gap) out.push("");
	for (const line of lines) {
		const pad = " ".repeat(INDENT);
		const text = line.spans
			.map((span) => {
				const { color, bold, italic, dimColor, underline } = spanProps(span);
				return paint(span.text, {
					color: options.quiet || dimColor ? colors.muted : color,
					bold,
					italic,
					underline,
				});
			})
			.join("");
		// A blank line stays empty: indent-only rows copy out as trailing spaces.
		out.push(text === "" ? "" : pad + text);
	}
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
				...(model.timeoutMs !== undefined && model.timeoutMs !== DEFAULT_BASH_TIMEOUT_MS
					? [{ text: ` (timeout ${formatTimeout(model.timeoutMs)})`, style: "meta" as const }]
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
	// The four-column margin tells a tool row from the text around it, and how it went: a
	// star when done, an ellipsis while it runs, a cross and the word `failed` when it did not.
	const margin = failed
		? paint("  ✗ ", { color: colors.error, bold: true })
		: running
			? paint("  … ", { color: colors.accent })
			: paint("  * ", { color: colors.muted });
	const name = paint(`${toolLabel(call.name)} `, { bold: true });
	const progress = running && call.name === "task" ? call.progress : undefined;
	const step = progress?.tool ? `↳ ${progress.tool.name} ${progress.tool.summary}`.trim() : "";
	const badge = progress
		? paint(
				`[${progress.subagent}${progress.status === "queued" ? " queued" : step ? ` ${step}` : ""} * ${progress.toolCount}] `,
				{ color: colors.accent },
			)
		: "";
	const tone = { color: failed ? colors.error : colors.muted };
	const summary = summaryPieces(call, running)
		.map((piece) => {
			if (piece.style === "added") return paint(piece.text, { color: colors.success });
			if (piece.style === "removed") return paint(piece.text, { color: colors.error });
			if (piece.style === "meta") return paint(piece.text, { color: colors.muted });
			return paint(piece.text, tone);
		})
		.join("");
	const failure = failed ? paint(" failed", { color: colors.error }) : "";
	const row = margin + name + badge + summary + failure;
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
		return sectionLines(markdown(block.text.replace(THINK_TAG_RE, ""), { width: bodyWidth(width), openFence }), {
			heading: block.continued ? undefined : "REASONING",
			quiet: true,
		});
	}
	return sectionLines(markdown(block.text.replace(THINK_TAG_RE, ""), { width: bodyWidth(width), openFence }), {
		heading: block.continued ? undefined : "AGENT",
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
	if (message.role === "user") {
		return sectionLines(markdown(message.content, { width: bodyWidth(width) }), { heading: "YOU" });
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
		return sectionLines(markdown(text, { width: bodyWidth(width) }), { quiet: true, gap: true });
	}
	return sectionLines(markdown(`[${message.role}] ${message.content}`, { width: bodyWidth(width) }), {
		quiet: true,
		gap: true,
	});
}
