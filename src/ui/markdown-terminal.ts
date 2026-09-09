/**
 * Markdown → terminal lines.
 *
 * The model answers in markdown and the TUI printed it verbatim, so a reply
 * arrived looking like source: `## heading`, `**bold**`, backticks, ``` fences,
 * `|---|` table rules. The web UI has had a renderer since the beginning; this
 * is the same job for a terminal.
 *
 * The output is *lines*, not a blob, and each line is already wrapped to the
 * width it was rendered for. That is deliberate: the live-region clamp needs
 * to know exactly how many rows a block will occupy (see ChatLog), and a
 * renderer that returns pre-wrapped lines answers that question by
 * construction instead of by estimating cells afterwards.
 *
 * Wrapping measures cells with displayWidth, so CJK, emoji and combining marks
 * count the way the terminal draws them.
 */

import { displayWidth } from "./display-width.ts";
import { highlightCode } from "./syntax.ts";

export interface Span {
	text: string;
	bold?: boolean;
	italic?: boolean;
	dim?: boolean;
	underline?: boolean;
	/** Semantic colour name resolved by the view against the active theme. */
	tone?: "heading" | "code" | "quote" | "link" | "marker" | "rule";
	/** highlight.js scope inside a fenced block ("keyword", "string", …), or
	 *  "text" for a piece the grammar left plain. Set only when the block was
	 *  highlighted, so the view can tell a highlighted token from flat code. */
	scope?: string;
}

export interface RenderedLine {
	spans: Span[];
	/** True for a line inside a fenced code block — the view draws its gutter. */
	code?: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*(\S*)/;
const BULLET_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const TABLE_ROW_RE = /^\s*\|(.+)\|\s*$/;
const LIST_MARKER_WIDTH = 2;

// Inline patterns, hoisted: inlineSpans runs per line of every rendered block.
const INLINE_CODE_RE = /`([^`]+)`/;
const INLINE_LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/;
const INLINE_BOLD_RE = /\*\*([^*]+)\*\*/;
const INLINE_BOLD_ALT_RE = /__([^_]+)__/;
const INLINE_ITALIC_RE = /(?<![A-Za-z0-9])\*([^*\n]+)\*(?![A-Za-z0-9])/;
const INLINE_ITALIC_ALT_RE = /(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/;
const INLINE_STRIKE_RE = /~~([^~]+)~~/;
const WORD_SPLIT_RE = /(\s+)/;
const ONLY_SPACE_RE = /^\s+$/;

interface InlinePattern {
	re: RegExp;
	make: (m: RegExpExecArray, base: Omit<Span, "text">) => Span[];
}

// Precedence: code first (its content is never emphasised), then links, then
// the emphasis markers longest-first so `**` beats `*`.
const INLINE_PATTERNS: InlinePattern[] = [
	{ re: INLINE_CODE_RE, make: (m, base) => [{ ...base, text: m[1]!, tone: "code" }] },
	{
		re: INLINE_LINK_RE,
		make: (m, base) => [
			{ ...base, text: m[1]!, tone: "link", underline: true },
			{ ...base, text: ` (${m[2]})`, dim: true },
		],
	},
	{ re: INLINE_BOLD_RE, make: (m, base) => [{ ...base, text: m[1]!, bold: true }] },
	{ re: INLINE_BOLD_ALT_RE, make: (m, base) => [{ ...base, text: m[1]!, bold: true }] },
	{ re: INLINE_ITALIC_RE, make: (m, base) => [{ ...base, text: m[1]!, italic: true }] },
	{ re: INLINE_ITALIC_ALT_RE, make: (m, base) => [{ ...base, text: m[1]!, italic: true }] },
	{ re: INLINE_STRIKE_RE, make: (m, base) => [{ ...base, text: m[1]!, dim: true }] },
];

/** Inline emphasis, code and links, in one pass so nested markers don't nest. */
function inlineSpans(text: string, base: Omit<Span, "text"> = {}): Span[] {
	const spans: Span[] = [];
	let rest = text;
	for (let guard = 0; guard < 500; guard++) {
		let best: { index: number; length: number; spans: Span[] } | undefined;
		for (const { re, make } of INLINE_PATTERNS) {
			const m = re.exec(rest);
			if (!m) continue;
			if (best === undefined || m.index < best.index) {
				best = { index: m.index, length: m[0].length, spans: make(m, base) };
			}
		}
		if (!best) break;
		if (best.index > 0) spans.push({ ...base, text: rest.slice(0, best.index) });
		spans.push(...best.spans);
		rest = rest.slice(best.index + best.length);
		if (!rest) break;
	}
	if (rest) spans.push({ ...base, text: rest });
	return spans.filter((span) => span.text !== "");
}

/**
 * Collapse neighbouring spans that share a style.
 *
 * Wrapping works word by word, so a styled run arrives as one span per word
 * and every one of them would carry its own escape sequence into the frame —
 * a heading of four words wrote four bold-on/bold-off pairs. Ink diffs frames
 * as strings, so this is fewer bytes on the wire and less for it to compare.
 */
function mergeSpans(spans: Span[]): Span[] {
	const out: Span[] = [];
	for (const span of spans) {
		const last = out[out.length - 1];
		if (
			last &&
			last.bold === span.bold &&
			last.italic === span.italic &&
			last.dim === span.dim &&
			last.underline === span.underline &&
			last.tone === span.tone &&
			last.scope === span.scope
		) {
			last.text += span.text;
			continue;
		}
		out.push({ ...span });
	}
	return out;
}

/** Break spans into lines no wider than `width` cells, indenting continuations. */
function wrapSpans(spans: Span[], width: number, indent: string, hangingIndent: string): RenderedLine[] {
	const usable = Math.max(8, width - displayWidth(indent));
	const lines: RenderedLine[] = [];
	let current: Span[] = [];
	let used = 0;
	let prefix = indent;

	const flush = (): void => {
		lines.push({ spans: mergeSpans([{ text: prefix, dim: true, tone: "marker" }, ...current]) });
		current = [];
		used = 0;
		prefix = hangingIndent;
	};

	for (const span of spans) {
		// Words, keeping the spaces so a wrapped line does not lose them.
		const words = span.text.split(WORD_SPLIT_RE).filter((w) => w !== "");
		for (const word of words) {
			const w = displayWidth(word);
			const room = Math.max(8, width - displayWidth(prefix));
			if (used > 0 && used + w > room) {
				if (ONLY_SPACE_RE.test(word)) continue; // never start a line with the space that broke it
				flush();
			}
			if (w > usable && !ONLY_SPACE_RE.test(word)) {
				// A single word wider than the line (a URL, a long identifier):
				// hard-split it rather than overflowing the viewport.
				let remainder = word;
				while (displayWidth(remainder) > Math.max(8, width - displayWidth(prefix))) {
					const room2 = Math.max(8, width - displayWidth(prefix));
					let cut = 0;
					let cells = 0;
					for (const ch of remainder) {
						const cw = displayWidth(ch);
						if (cells + cw > room2) break;
						cells += cw;
						cut += ch.length;
					}
					current.push({ ...span, text: remainder.slice(0, cut) });
					used = cells;
					flush();
					remainder = remainder.slice(cut);
				}
				if (remainder) {
					current.push({ ...span, text: remainder });
					used += displayWidth(remainder);
				}
				continue;
			}
			current.push({ ...span, text: word });
			used += w;
		}
	}
	if (current.length > 0 || lines.length === 0) flush();
	return lines;
}

/** Cells wide, for table layout. */
function spansWidth(spans: Span[]): number {
	let total = 0;
	for (const span of spans) total += displayWidth(span.text);
	return total;
}

function splitRow(row: string): string[] {
	const inner = TABLE_ROW_RE.exec(row)?.[1] ?? row;
	return inner.split("|").map((cell) => cell.trim());
}

/**
 * A markdown table as aligned columns. Column widths come from the content,
 * then shrink proportionally when the table is wider than the terminal —
 * a raw `|---|---|` table just wrapped into noise before.
 */
function renderTable(rows: string[][], width: number, indent: string): RenderedLine[] {
	const columns = Math.max(...rows.map((r) => r.length));
	const cells = rows.map((row) => {
		const padded = [...row];
		while (padded.length < columns) padded.push("");
		return padded.map((cell) => inlineSpans(cell));
	});
	const widths = Array.from({ length: columns }, (_, c) => Math.max(1, ...cells.map((row) => spansWidth(row[c]!))));
	const gap = 2;
	const available = Math.max(8, width - displayWidth(indent) - gap * (columns - 1));
	let total = widths.reduce((a, b) => a + b, 0);
	if (total > available) {
		// Shrink the widest columns first so short ones stay readable.
		const scale = available / total;
		for (let c = 0; c < columns; c++) widths[c] = Math.max(3, Math.floor(widths[c]! * scale));
		total = widths.reduce((a, b) => a + b, 0);
	}
	const lines: RenderedLine[] = [];
	cells.forEach((row, rowIndex) => {
		const spans: Span[] = [{ text: indent, dim: true, tone: "marker" }];
		row.forEach((cell, c) => {
			const budget = widths[c]!;
			let usedCells = 0;
			for (const span of cell) {
				const remaining = budget - usedCells;
				if (remaining <= 0) break;
				let piece = span.text;
				if (displayWidth(piece) > remaining) {
					let cut = 0;
					let cells2 = 0;
					for (const ch of piece) {
						const cw = displayWidth(ch);
						if (cells2 + cw > remaining) break;
						cells2 += cw;
						cut += ch.length;
					}
					piece = piece.slice(0, cut);
				}
				if (!piece) break;
				spans.push({ ...span, text: piece, bold: span.bold || rowIndex === 0 });
				usedCells += displayWidth(piece);
			}
			const pad = budget - usedCells + (c === columns - 1 ? 0 : gap);
			if (pad > 0) spans.push({ text: " ".repeat(pad) });
		});
		lines.push({ spans: mergeSpans(spans) });
		// A rule under the header row. Bold alone marked it before, which is
		// nothing at all in a theme with a low-contrast palette or on a terminal
		// that renders bold as a colour shift — and a table whose header reads as
		// data is a table you have to count columns in.
		if (rowIndex === 0 && cells.length > 1) {
			const rule = widths
				.map((columnWidth, c) => "─".repeat(columnWidth) + (c === columns - 1 ? "" : " ".repeat(gap)))
				.join("");
			lines.push({
				spans: [
					{ text: indent, dim: true, tone: "marker" },
					{ text: rule, dim: true, tone: "rule" },
				],
			});
		}
	});
	return lines;
}

/** A fenced block left open, and the language it was opened with. */
export interface OpenFence {
	language?: string;
}

export interface MarkdownRenderOptions {
	/** Terminal cells available for the text itself (gutter excluded). */
	width: number;
	/** Indent applied to every line — two spaces for the chat's body text. */
	indent?: string;
	/** The text starts inside this already-open fence (see trailingOpenFence). */
	openFence?: OpenFence | null;
}

/**
 * Render `text` as terminal lines. Deterministic and side-effect free: the
 * same input and width always produce the same lines, which is what lets the
 * clamp count rows without rendering twice.
 */
export function renderMarkdownLines(text: string, options: MarkdownRenderOptions): RenderedLine[] {
	const width = Math.max(20, options.width);
	const indent = options.indent ?? "";
	const out: RenderedLine[] = [];
	const rawLines = text.split("\n");
	// The text may begin inside a fence opened in an earlier chunk of the same
	// answer — the caller says so with `openFence`, and its language is what
	// keeps the highlighting going across the cut.
	let inFence = options.openFence != null;
	let fenceMarker = "```";
	let table: string[][] | null = null;

	const flushTable = (): void => {
		if (!table) return;
		out.push(...renderTable(table, width, indent));
		table = null;
	};

	// A fenced block is highlighted as a whole, not line by line: a block
	// comment or a template literal spans lines, and a per-line tokenizer would
	// lose its scope at every break. So the lines are buffered until the closing
	// fence — or until the input ends, which is the normal case mid-stream.
	let fenceLang: string | undefined = options.openFence?.language;
	let fenceLines: string[] = [];
	const flushFence = () => {
		if (fenceLines.length === 0) return;
		const highlighted = highlightCode(fenceLines.join("\n"), fenceLang);
		fenceLines.forEach((raw, index) => {
			const tokens = highlighted?.[index];
			const spans: Span[] =
				tokens && tokens.length > 0
					? tokens.map((token) => ({ text: token.text, tone: "code" as const, scope: token.scope ?? "text" }))
					: // A blank line still needs a cell, or the wrapper drops the row.
						[{ text: raw === "" ? " " : raw, tone: "code" as const, ...(highlighted ? { scope: "text" } : {}) }];
			// Code keeps its own spacing; only hard-wrap what does not fit.
			out.push(...wrapSpans(spans, width, indent, `${indent}  `).map((line) => ({ ...line, code: true })));
		});
		fenceLines = [];
	};

	for (const raw of rawLines) {
		const fence = FENCE_RE.exec(raw);
		if (fence) {
			flushTable();
			if (!inFence) {
				// The language tag is not printed — it would cost a row in the live
				// region — but it does decide the grammar the block is coloured with.
				inFence = true;
				fenceMarker = fence[1]!.slice(0, 3);
				fenceLang = fence[2] || undefined;
			} else if (fence[1]!.startsWith(fenceMarker)) {
				inFence = false;
				flushFence();
				fenceLang = undefined;
			}
			continue;
		}
		if (inFence) {
			fenceLines.push(raw);
			continue;
		}

		if (TABLE_RULE_RE.test(raw) && table) continue;
		if (TABLE_ROW_RE.test(raw)) {
			table = table ?? [];
			table.push(splitRow(raw));
			continue;
		}
		flushTable();

		if (raw.trim() === "") {
			out.push({ spans: [{ text: "" }] });
			continue;
		}
		if (HR_RE.test(raw)) {
			const rule = "─".repeat(Math.max(4, width - displayWidth(indent)));
			out.push({ spans: [{ text: indent }, { text: rule, dim: true, tone: "rule" }] });
			continue;
		}
		const heading = HEADING_RE.exec(raw);
		if (heading) {
			const level = heading[1]!.length;
			out.push(
				...wrapSpans(inlineSpans(heading[2]!, { bold: true, tone: "heading" }), width, indent, `${indent}  `).map(
					(line) => (level > 2 ? line : line),
				),
			);
			continue;
		}
		const quote = QUOTE_RE.exec(raw);
		if (quote) {
			out.push(
				...wrapSpans(inlineSpans(quote[1]!, { dim: true, tone: "quote" }), width, `${indent}│ `, `${indent}│ `),
			);
			continue;
		}
		const bullet = BULLET_RE.exec(raw);
		if (bullet) {
			const depth = Math.floor(displayWidth(bullet[1]!) / 2);
			const marker = depth === 0 ? "•" : depth === 1 ? "–" : "·";
			const lead = `${indent}${" ".repeat(depth * LIST_MARKER_WIDTH)}${marker} `;
			out.push(
				...wrapSpans(inlineSpans(bullet[3]!), width, lead, `${indent}${" ".repeat(depth * LIST_MARKER_WIDTH + 2)}`),
			);
			continue;
		}
		const ordered = ORDERED_RE.exec(raw);
		if (ordered) {
			const depth = Math.floor(displayWidth(ordered[1]!) / 2);
			const lead = `${indent}${" ".repeat(depth * LIST_MARKER_WIDTH)}${ordered[2]}. `;
			out.push(
				...wrapSpans(
					inlineSpans(ordered[3]!),
					width,
					lead,
					`${indent}${" ".repeat(depth * LIST_MARKER_WIDTH + displayWidth(`${ordered[2]}. `))}`,
				),
			);
			continue;
		}
		out.push(...wrapSpans(inlineSpans(raw), width, indent, indent));
	}
	// An unclosed fence is the normal case while an answer streams: render what
	// arrived rather than holding the whole block back until the closing fence.
	flushFence();
	flushTable();
	return out;
}

/**
 * The last `maxLines` rendered lines of `text`, for the live region.
 *
 * Rendering a whole streaming block every frame is what the old cell
 * arithmetic was avoiding, and a reasoning stream reaches hundreds of KB. Only
 * the tail can be on screen, so only the tail is rendered — with enough raw
 * lines taken to fill the budget, plus the fence state carried in from the
 * text before them so a code block does not lose its styling mid-stream.
 */
/**
 * The fence still open at the end of `text`, with the language tag it was
 * opened with — or null when everything is closed. `incoming` is the fence the
 * text *starts* inside, for a chunk cut out of a longer answer.
 *
 * The streaming transcript is cut into chunks at line boundaries (see
 * splitCompleteLines), so a chunk routinely begins inside a fenced block with
 * its ```` ```ts ```` opener in an earlier chunk. Without threading this, the
 * first rows of a code block were highlighted and every row after the cut
 * arrived flat.
 */
export function trailingOpenFence(text: string, incoming?: OpenFence | null): OpenFence | null {
	let open: OpenFence | null = incoming ?? null;
	let marker = "```";
	for (const raw of text.split("\n")) {
		const fence = FENCE_RE.exec(raw);
		if (!fence) continue;
		if (!open) {
			open = fence[2] ? { language: fence[2] } : {};
			marker = fence[1]!.slice(0, 3);
		} else if (fence[1]!.startsWith(marker)) {
			open = null;
		}
	}
	return open;
}

export function renderMarkdownTail(
	text: string,
	options: MarkdownRenderOptions & { maxLines: number },
): {
	lines: RenderedLine[];
	truncated: boolean;
} {
	const { maxLines } = options;
	if (maxLines <= 0) return { lines: [], truncated: text.length > 0 };
	const rawLines = text.split("\n");
	// A rendered line is at least one raw line, so this many raw lines can
	// always cover the budget; a couple extra absorb wrapping.
	const take = Math.min(rawLines.length, maxLines + 4);
	const head = rawLines.slice(0, rawLines.length - take).join("\n");
	const tailText = rawLines.slice(rawLines.length - take).join("\n");
	// Reopen the fence the window starts inside — *with its language tag*.
	// A bare ``` was enough to keep the block styled as code, but it threw the
	// tag away, so a long block lost its highlighting the moment the opening
	// fence scrolled out of the window: the first rows of an answer were
	// coloured and the rest arrived flat.
	const open = trailingOpenFence(head, options.openFence);
	const rendered = renderMarkdownLines(tailText, { ...options, openFence: open });
	const truncated = rendered.length > maxLines || take < rawLines.length;
	return { lines: truncated ? rendered.slice(rendered.length - maxLines) : rendered, truncated };
}
