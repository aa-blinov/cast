import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type OpenFence, type RenderedLine, renderMarkdownLines, trailingOpenFence } from "../ui/markdown-terminal.ts";
import { spanProps } from "../ui/span-style.ts";
import { theme } from "../ui/themes/index.ts";
import { formatTimeout, isMcpTool, mcpToolLabel, oneLineSummary, parseToolSummary } from "../ui/tool-summary.ts";
import type { ChatMessage, StreamBlock, ToolCallEntry } from "../ui/useAgentSession.ts";
import { paint } from "./paint.ts";
import { sanitize } from "./sanitize.ts";

// The transcript as rows of text, with no terminal in it, set like a man page:
// the speaker is a section heading in bold capitals, what they said hangs at a
// four-column indent, and code sits four further in. Rank is carried by weight and
// case, state by a word or a mark, so nothing depends on colour or a coloured edge.
// A row never exceeds `width`; the scroll view owns everything taller than the screen.

export const INDENT = 4;
const CODE_INDENT = 4;
/** "  * ": the margin that tells a tool row from the text around it. */
const MARGIN_WIDTH = 4;
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

/**
 * A summary is a glance at what was asked, not the payload: a heredoc that writes a file, or the arguments of a tool
 * the row has no summary for, can be megabytes, and laying that out (every character is measured and wrapped, again
 * on every width change) froze the screen for seconds at a time. Past this the row says how much more there is.
 */
const MAX_SUMMARY_CHARS = 1500;

function clipSummary(text: string): string {
	if (text.length <= MAX_SUMMARY_CHARS) return text;
	return `${text.slice(0, MAX_SUMMARY_CHARS)}… (+${(text.length - MAX_SUMMARY_CHARS).toLocaleString("en-US")} more characters)`;
}

/** What the summary says, as plain text plus the paint each piece takes. */
function summaryPieces(call: ToolCallEntry): Array<{ text: string; style: "summary" | "added" | "removed" | "meta" }> {
	const model = parseToolSummary(call.name, call.args ?? "");
	// One row either way: a command or a path with line breaks would otherwise leave its continuation under the margin.
	const flat = (text: string) => sanitize(oneLineSummary(clipSummary(text)));
	switch (model.kind) {
		case "edit":
			return [
				{ text: `${flat(model.path)} `, style: "summary" },
				{ text: `+${model.added}`, style: "added" },
				{ text: " ", style: "summary" },
				{ text: `−${model.removed}`, style: "removed" },
			];
		case "bash":
			return [
				{ text: flat(model.command), style: "summary" },
				// The deadline that will apply, default or chosen: the reason a command is cut off is worth seeing before it happens.
				...(model.timeoutMs !== undefined
					? [{ text: ` * timeout ${formatTimeout(model.timeoutMs)}`, style: "meta" as const }]
					: []),
			];
		case "read":
			return [{ text: `${flat(model.path)} – lines ${model.range}`, style: "summary" }];
		case "write":
			return [
				{ text: `${flat(model.path)} – ${model.lines} ${model.lines === 1 ? "line" : "lines"}`, style: "summary" },
			];
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
	const stepText = running && call.toolProgress ? paint(`[${call.toolProgress}] `, { color: colors.accent }) : "";
	const tone = { color: failed ? colors.error : colors.muted };
	const render = (piece: ReturnType<typeof summaryPieces>[number]) => {
		if (piece.style === "added") return paint(piece.text, { color: colors.success });
		if (piece.style === "removed") return paint(piece.text, { color: colors.error });
		if (piece.style === "meta") return paint(piece.text, { color: colors.muted });
		return paint(piece.text, tone);
	};
	const pieces = summaryPieces(call);
	// The note after the command (its deadline) is kept apart so a running row, which is cut to one line, trims the
	// command and not the note.
	const summary = pieces
		.filter((piece) => piece.style !== "meta")
		.map(render)
		.join("");
	const note = pieces
		.filter((piece) => piece.style === "meta")
		.map(render)
		.join("");
	const failure = failed ? paint(" failed", { color: colors.error }) : "";
	const tail = note + failure;
	if (running) {
		const room = Math.max(1, width - visibleWidth(tail));
		return [truncateToWidth(margin + name + badge + stepText + summary, room, "…") + tail];
	}
	// A finished command wraps in full, its continuation under the text and not under the margin.
	const body = wrapTextWithAnsi(name + badge + summary + tail, Math.max(1, width - MARGIN_WIDTH));
	return body.map((line, i) => truncateToWidth((i === 0 ? margin : " ".repeat(MARGIN_WIDTH)) + line, width, "…"));
}

/** One ordered block of an assistant turn. */
export function blockLines(
	block: StreamBlock,
	options: { width: number; showReasoning: boolean; openFence?: OpenFence | null },
): string[] {
	const { width, showReasoning, openFence } = options;
	if (block.kind === "tool") return toolRowLines(block.call, width);
	// A block of a kind this build does not know (an old or foreign session) has nothing to show.
	if (block.kind !== "thinking" && block.kind !== "content") return [];
	const text = sanitize(String(block.text ?? "")).replace(THINK_TAG_RE, "");
	if (block.kind === "thinking") {
		if (!showReasoning) return [];
		return sectionLines(markdown(text, { width: bodyWidth(width), openFence }), {
			heading: block.continued ? undefined : "REASONING",
			quiet: true,
		});
	}
	return sectionLines(markdown(text, { width: bodyWidth(width), openFence }), {
		heading: block.continued ? undefined : "AGENT",
	});
}

/** The fence still open after this message, to carry into the next one. */
export function fenceAfter(message: ChatMessage, incoming: OpenFence | null): OpenFence | null {
	let fence = incoming;
	if (message.role !== "assistant") return fence;
	try {
		for (const block of message.blocks ?? []) {
			if (block.kind === "thinking" || block.kind === "content")
				fence = trailingOpenFence(String(block.text ?? ""), fence);
		}
	} catch {
		// A message that cannot be read opens no fence; it is reported where it is laid out.
		return incoming;
	}
	return fence;
}

/** A committed message. */
export function messageLines(
	message: ChatMessage,
	options: { width: number; showReasoning: boolean; openFence?: OpenFence | null },
): string[] {
	const { width, showReasoning } = options;
	const content = sanitize(String(message.content ?? ""));
	if (message.role === "user") {
		return sectionLines(markdown(content, { width: bodyWidth(width) }), { heading: "YOU" });
	}
	if (message.role === "assistant") {
		let fence = options.openFence ?? null;
		const out: string[] = [];
		for (const block of message.blocks ?? []) {
			for (const line of blockLines(block, { width, showReasoning, openFence: fence })) out.push(line);
			if (block.kind === "thinking" || block.kind === "content")
				fence = trailingOpenFence(String(block.text ?? ""), fence);
		}
		return out;
	}
	if (message.role === "warning") {
		const text = content.startsWith(SYSTEM_PREFIX) ? content.slice(SYSTEM_PREFIX.length) : content;
		return sectionLines(markdown(text, { width: bodyWidth(width) }), { quiet: true, gap: true });
	}
	return sectionLines(markdown(`[${message.role}] ${content}`, { width: bodyWidth(width) }), {
		quiet: true,
		gap: true,
	});
}
