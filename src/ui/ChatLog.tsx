import { Box, Static, Text } from "ink";
import { type JSX, useMemo, useRef } from "react";
import { getLastFrameOverflow } from "../core/stdin-manager.ts";
import { displayWidth } from "./display-width.ts";
import { type RenderedLine, renderMarkdownLines, renderMarkdownTail, type Span } from "./markdown-terminal.ts";
import { Spinner } from "./Spinner.tsx";
import { formatTaskToolSummary } from "./task-tool-summary.ts";
import { theme } from "./themes/index.ts";
import type { ChatMessage, RetryInfo, StreamBlock, StreamingState, ToolCallEntry } from "./useAgentSession.ts";

// Vendors are supposed to split reasoning out of the content stream; when one
// leaks the tags, a cut mid-tag must never show "]<]minimax[>" fragments.
const THINK_TAG_RE = /<\/?think[^>]*>/g;

interface ChatLogProps {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
	columns: number;
	showReasoning: boolean;
	/**
	 * Bumped by App after a terminal resize settles. Used as the <Static> key so
	 * the whole history is replayed from a clean top — Ink otherwise only prints
	 * newly-added static items, so a resize-time screen clear would wipe the
	 * on-screen history with no way to redraw it. See App.tsx's resize effect.
	 */
	repaintKey?: number;
}

type ToolSummaryModel =
	| { kind: "edit"; path: string; added: number; removed: number }
	| { kind: "read"; path: string; range: string }
	| { kind: "write"; path: string; lines: number }
	| { kind: "task"; text: string }
	| { kind: "generic"; text: string };

/**
 * Data half of the tool-call summary. edit/write get a readable file + change
 * summary instead of a truncated JSON blob; every other tool keeps the generic
 * `key=value` args. Args stream in as partial JSON, so anything that fails to
 * parse (or doesn't match the expected shape) falls back to the raw/generic
 * form — the rich view only kicks in once the call is complete.
 */
/** Exported for unit tests. */
export function parseToolSummary(name: string, args: string): ToolSummaryModel {
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(args) as Record<string, unknown>;
	} catch {
		parsed = null;
	}

	if (
		parsed &&
		name === "edit" &&
		typeof parsed.filePath === "string" &&
		typeof parsed.oldString === "string" &&
		typeof parsed.newString === "string"
	) {
		const removed = parsed.oldString.length === 0 ? 0 : parsed.oldString.split("\n").length;
		const added = parsed.newString.length === 0 ? 0 : parsed.newString.split("\n").length;
		return { kind: "edit", path: parsed.filePath, added, removed };
	}

	if (parsed && name === "read" && typeof parsed.path === "string") {
		// `offset` is 1-indexed (same contract as the read tool). Omitted/0 → line 1.
		const offset = typeof parsed.offset === "number" ? parsed.offset : 0;
		const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
		const start = offset > 0 ? offset : 1;
		const range = limit ? `${start}-${start + limit - 1}` : "all";
		return { kind: "read", path: parsed.path, range };
	}

	if (parsed && name === "write" && typeof parsed.path === "string") {
		const lines = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
		return { kind: "write", path: parsed.path, lines };
	}

	if (name === "task") {
		const taskText = formatTaskToolSummary(args);
		if (taskText) return { kind: "task", text: taskText };
	}

	// The raw args are the full todo list as one unindented JSON blob — fine
	// for the model (it's what gets echoed back to keep it grounded), but
	// unreadable as a terminal one-liner. "N/M done — current item" instead.
	if (parsed && name === "todo_write" && Array.isArray(parsed.todos)) {
		const todos = parsed.todos as Array<{ content?: unknown; status?: unknown }>;
		const done = todos.filter((t) => t.status === "completed").length;
		const active = todos.find((t) => t.status === "in_progress");
		const activeText = typeof active?.content === "string" ? active.content : "";
		const suffix = activeText ? ` — ${activeText.slice(0, 60)}` : "";
		return { kind: "generic", text: `${done}/${todos.length} done${suffix}` };
	}

	// `command="ls -la /tmp"` spent a third of the row on the key and the
	// quotes. A command, a pattern or a path is self-describing: print the
	// value. Several arguments still get the `k=v` list, which is the only
	// case where the keys carry information.
	const entries = parsed ? Object.entries(parsed) : [];
	const primary =
		name === "bash" && typeof parsed?.command === "string"
			? parsed.command
			: entries.length === 1 && typeof entries[0]![1] === "string"
				? (entries[0]![1] as string)
				: undefined;
	const generic =
		primary !== undefined
			? primary
			: parsed
				? entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")
				: args.slice(0, 200);
	return { kind: "generic", text: generic };
}

/**
 * Collapse a summary to one physical line for the live region.
 *
 * Ink's `wrap="truncate"` truncates the string, but it does not remove
 * newlines: a value that already fits the terminal width comes back
 * unchanged, so a multi-line `task` assignment ("Do X\nThen Y\nReport
 * back") rendered three rows while clampStreamingBlocks had charged the tool
 * block exactly one — and a live region taller than the viewport is what
 * makes Ink stack duplicate frames into scrollback. Streaming args arrive as
 * raw text too, so a model that emits pretty-printed JSON hits this on every
 * tool call, not just `task`.
 */
const NEWLINE_RUN_RE = /\s*\n\s*/g;
/** @internal exported for unit tests */
export function oneLineSummary(text: string): string {
	return text.replace(NEWLINE_RUN_RE, " ");
}

/**
 * One-line summary for a tool call. Only the parse is memoized — the JSX is
 * rebuilt every render so theme() colors stay live: memoizing the whole
 * element on [name, args] kept the previous theme's colors on still-visible
 * rows after a /theme switch.
 */
function ToolSummary({
	name,
	args,
	compact,
	muted,
}: {
	name: string;
	args: string;
	compact?: boolean;
	/** Inside a muted tool row the summary inherits its colour instead of
	 *  adding a second one — churn counts stay coloured, they are the point. */
	muted?: boolean;
}): JSX.Element {
	const model = useMemo(() => parseToolSummary(name, args), [name, args]);
	const tone = muted ? {} : { color: theme().muted };
	if (model.kind === "edit") {
		return (
			<Text wrap="truncate" {...tone}>
				{model.path} <Text color={theme().success}>+{model.added}</Text>{" "}
				<Text color={theme().error}>−{model.removed}</Text>
			</Text>
		);
	}
	if (model.kind === "read") {
		return (
			<Text wrap="truncate" {...tone}>
				{model.path} · lines {model.range}
			</Text>
		);
	}
	if (model.kind === "write") {
		return (
			<Text wrap="truncate" {...tone}>
				{model.path} · {model.lines} {model.lines === 1 ? "line" : "lines"}
			</Text>
		);
	}
	if (model.kind === "task") {
		// Live region: one line so parallel tasks stay visible under the clamp.
		// History: wrap the full assignment once the turn is committed.
		return (
			<Text wrap={compact ? "truncate" : "wrap"} {...tone}>
				{compact ? oneLineSummary(model.text) : model.text}
			</Text>
		);
	}
	return (
		<Text wrap="truncate" {...tone}>
			{compact ? oneLineSummary(model.text) : model.text}
		</Text>
	);
}

function ToolCallView({ call, compact }: { call: ToolCallEntry; compact?: boolean }): JSX.Element {
	const colors = theme();
	// Tool rows are scaffolding, not the answer: what the agent *said* should
	// be the loud thing on screen. `[bash] [ok] command="…"` spent three
	// bracketed columns on chrome, and a bright bullet was no quieter.
	//
	// So: the bar sits in the rail column, level with a turn's `▌`; the tool's
	// name is dimmer than its argument, because `bash` and `read` are rarely
	// the interesting half; and colour is spent only on a failure. The rail
	// itself is never dimmed — see MarkdownBody.
	const failed = call.status === "error";
	const running = call.status === "running";
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={failed ? colors.error : railMuted()}>{failed ? "✗" : "│"} </Text>
				<Text color={colors.muted} dimColor>
					{isMcpTool(call.name) ? mcpToolLabel(call.name) : call.name}{" "}
				</Text>
				<Text color={failed ? colors.error : colors.muted} dimColor={!failed && !running}>
					<ToolSummary name={call.name} args={call.args} compact={compact} muted />
				</Text>
			</Text>
		</Box>
	);
}

const GUTTER_WIDTH = 2;
/** Spaces between the speaker label and the text that follows it. */
const LABEL_GAP = 2;
const USER_LABEL = "you";
/** Written by every surface that renders a `<system-reminder>` as a notice. */
const SYSTEM_PREFIX = "[system] ";
/** Label and rail per block kind — shared by the clamp, which has to know the
 *  width the text will be rendered at, and the view, which draws them. */
const BLOCK_STYLE = {
	content: { label: "agent", bar: "▌" },
	thinking: { label: "reasoning", bar: "┆" },
} as const;

/** Ink props for one rendered span, with tones resolved against the theme. */
function spanProps(span: Span): {
	color?: string;
	bold?: boolean;
	italic?: boolean;
	dimColor?: boolean;
	underline?: boolean;
} {
	const colors = theme();
	const color =
		span.tone === "code"
			? colors.accent
			: span.tone === "heading"
				? colors.agent
				: span.tone === "link"
					? colors.accent
					: span.tone === "quote" || span.tone === "marker" || span.tone === "rule"
						? colors.muted
						: undefined;
	return {
		...(color ? { color } : {}),
		...(span.bold ? { bold: true } : {}),
		...(span.italic ? { italic: true } : {}),
		...(span.dim ? { dimColor: true } : {}),
		...(span.underline ? { underline: true } : {}),
	};
}

/**
 * The rail's own colour for a scaffolding row: `muted` is right in most
 * themes, but nord and solarized put it within 1.7–2.8:1 of the background,
 * where a one-cell bar disappears — those give the rail its own value.
 */
function railMuted(): string {
	const colors = theme();
	return colors.rail ?? colors.muted;
}

/**
 * Rendered markdown lines behind one rail.
 *
 * The speaker's label rides the first line rather than taking a row of its
 * own — two rows of chrome per turn is a lot on a 24-row terminal, and the
 * rail's colour already says who is speaking. Continuations are indented to
 * the same column, so the block still reads as one paragraph.
 *
 * The rail itself is never dimmed: it has to stay visible while the text
 * beside it is dim, and in two themes `muted` is already close enough to the
 * background that dimming it erases the rail (see ThemeColors.rail).
 */
function MarkdownBody({
	lines,
	gutter,
	bar = "▌",
	continuationBar,
	label,
	truncated,
	dimText,
}: {
	lines: RenderedLine[];
	gutter: string;
	/** `▌` for a turn, `│` for scaffolding, `┆` for reasoning. */
	bar?: string;
	/** Rail for lines after the first — a notice's `ⓘ` marks the notice, not
	 *  every line of it. Defaults to `bar`, which is what a turn wants. */
	continuationBar?: string;
	/** Speaker label for the first line — `you`, `agent`, `reasoning`. */
	label?: string;
	/** Head of the block was dropped: shown as `…` *inside* the label's field,
	 *  never appended to it. Appending made the row two cells wider than the
	 *  width its lines were rendered for, so Ink wrapped every one of them and
	 *  the live region doubled in height (63 full-screen clears in one
	 *  streaming answer — the exact failure the clamp exists to prevent). */
	truncated?: boolean;
	/** Dim the text (not the rail) — reasoning and finished scaffolding. */
	dimText?: boolean;
}): JSX.Element {
	// The label's field is exactly `label + LABEL_GAP` cells wide, whatever it
	// renders inside it — that is the width the lines were wrapped for.
	const indent = label ? " ".repeat(displayWidth(label) + LABEL_GAP) : "";
	return (
		<Box flexDirection="column">
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional by construction
				<Text key={i}>
					<Text color={gutter}>{`${i === 0 ? bar : (continuationBar ?? bar)} `}</Text>
					{label && i === 0 ? (
						<Text color={gutter} dimColor={dimText}>
							{label}
							{truncated ? `…${" ".repeat(LABEL_GAP - 1)}` : " ".repeat(LABEL_GAP)}
						</Text>
					) : (
						indent
					)}
					{line.spans.map((span, j) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: spans are positional within a line
						<Text key={j} {...spanProps(span)} dimColor={dimText || span.dim}>
							{span.text}
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

// MCP tools are exposed to the model as "mcp_<server>_<tool>" (see
// core/mcp.ts's mcpToolName) — same prefix-strip-and-loosen treatment the
// web UI already applies (app.js's isMcpTool/mcpToolLabel), so the TUI
// doesn't show the raw underscored wire name where the web UI shows a
// readable "server · tool" label.
function isMcpTool(name: string): boolean {
	return name.startsWith("mcp_");
}
function mcpToolLabel(name: string): string {
	return name.slice(4).replace(/_/g, " · ");
}

/**
 * Renders one ordered block. Shared between live streaming and committed
 * history so a turn reads identically before and after it lands — the reason
 * StreamBlock is the single source of truth for row order.
 */
function BlockView({
	block,
	truncated,
	compact,
	showReasoning,
	width,
	lines,
}: {
	block: StreamBlock;
	truncated?: boolean;
	/** Live streaming region — keep tool rows short for the viewport clamp. */
	compact?: boolean;
	/** When false, drop `thinking` blocks entirely. Defaults to true so the
	 *  pure-BlockView test surface and any external callers stay unchanged. */
	showReasoning?: boolean;
	/** Terminal columns; the body is rendered to fit them. */
	width?: number;
	/** Pre-rendered lines from the clamp — rendering twice per frame would
	 *  double the cost of the one thing that runs on every token. */
	lines?: RenderedLine[];
}): JSX.Element | null {
	if (block.kind === "thinking") {
		if (showReasoning === false) return null;
		const style = BLOCK_STYLE.thinking;
		return (
			<MarkdownBody
				lines={lines ?? renderMarkdownLines(block.text, { width: bodyWidth(width, "thinking") })}
				gutter={railMuted()}
				bar={style.bar}
				label={block.continued ? undefined : style.label}
				truncated={truncated}
				dimText
			/>
		);
	}
	if (block.kind === "content") {
		const style = BLOCK_STYLE.content;
		return (
			<MarkdownBody
				lines={lines ?? renderMarkdownLines(block.text, { width: bodyWidth(width, "content") })}
				gutter={theme().agent}
				bar={style.bar}
				label={block.continued ? undefined : style.label}
				truncated={truncated}
			/>
		);
	}
	return <ToolCallView call={block.call} compact={compact} />;
}

/**
 * Cells left for the text once the rail and the speaker label have taken
 * theirs. The label only appears on a block's first line, but every line is
 * indented to the same column, so one width covers the whole block — which is
 * what lets the clamp count rows without re-rendering.
 */
function bodyWidth(width: number | undefined, kind?: keyof typeof BLOCK_STYLE | "plain"): number {
	const label = kind && kind !== "plain" ? displayWidth(BLOCK_STYLE[kind].label) + LABEL_GAP : 0;
	return Math.max(20, (width ?? process.stdout.columns ?? 80) - GUTTER_WIDTH - label);
}

/**
 * Lay the live streaming blocks out to fit the terminal viewport, keeping the
 * tail.
 *
 * A live region taller than the viewport is the one thing this must prevent:
 * Ink cannot erase above the top of the screen, so it falls back to clearing
 * the terminal and replaying every static row it has printed — on every frame
 * (measured: 51 full clears in nine seconds of one streaming answer).
 *
 * Rows are counted by *rendering* each block to lines at the current width and
 * counting them, rather than by estimating cells and dividing. The renderer
 * wraps to the width it is given, so the count is exact, and the lines it
 * returns are handed to the view — one render per frame, not two. The old
 * arithmetic was where a cell/character mix-up let a CJK answer take twice the
 * rows it was allowed.
 *
 * Each entry carries the block's index in the *input* array so React keys stay
 * aligned with the unclamped list — keying by position in the clamped output
 * shifted identities whenever older blocks dropped out of the window.
 *
 * `extraReserve` shrinks the budget further, on top of the flat guess below.
 * It exists because the flat guess is only ever an estimate — the composer
 * grows with multi-line input, steer/queue notices stack, etc. — so ChatLog
 * feeds back the *actual* overflow of the last real Ink frame (see
 * getLastFrameOverflow) to keep the live region within the viewport even when
 * the estimate falls short.
 */
export interface LaidOutBlock {
	block: StreamBlock;
	/** Index in the input array, for stable React keys. */
	index: number;
	/** True when the block's head was dropped to make it fit. */
	truncated: boolean;
	/** Rendered body lines; absent for tool blocks, which are one row. */
	lines?: RenderedLine[];
}

export function clampStreamingBlocks(
	blocks: StreamBlock[],
	rows: number,
	columns: number,
	extraReserve = 0,
): LaidOutBlock[] {
	// Rows reserved for everything below the streaming area: composer frame
	// (3), status bar (1), notices/steer/queue lines and a safety margin.
	const budget = Math.max(4, rows - 8 - extraReserve);

	const out: LaidOutBlock[] = [];
	let used = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (used >= budget) break;
		if (block.kind === "tool") {
			// Live ToolCallView is one status row. Charging a full wrap hid
			// sibling parallel tasks (only the newest long assignment fit).
			if (used + 1 > budget) {
				if (out.length > 0) break;
				out.unshift({ block, truncated: true, index: i });
				used = budget;
				break;
			}
			out.unshift({ block, truncated: false, index: i });
			used += 1;
			continue;
		}
		// The speaker label rides the first body line, so a block costs exactly
		// its rendered lines — no separate header row to charge for.
		const room = budget - used;
		if (room <= 0) break;
		const width = bodyWidth(columns, block.kind === "thinking" ? "thinking" : "content");
		const text =
			block.text.includes("<think") || block.text.includes("</think")
				? block.text.replace(THINK_TAG_RE, "")
				: block.text;
		const { lines, truncated } = renderMarkdownTail(text, { width, maxLines: room });
		out.unshift({ block, truncated, index: i, lines });
		used += lines.length;
		if (truncated) break;
	}
	return out;
}

function blockKey(block: StreamBlock, index: number): string {
	return block.kind === "tool" ? `tool-${block.call.id}` : `${block.kind}-${index}`;
}

function MessageView({
	message,
	showReasoning,
	width,
}: {
	message: ChatMessage;
	showReasoning: boolean;
	width: number;
}): JSX.Element {
	const colors = theme();
	if (message.role === "user") {
		const usable = Math.max(20, width - GUTTER_WIDTH - displayWidth(USER_LABEL) - LABEL_GAP);
		return (
			<MarkdownBody
				lines={renderMarkdownLines(message.content, { width: usable })}
				gutter={colors.user}
				label={USER_LABEL}
			/>
		);
	}
	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				{message.blocks?.map((b, i) => (
					<BlockView key={blockKey(b, i)} block={b} showReasoning={showReasoning} width={width} />
				))}
			</Box>
		);
	}
	if (message.role === "warning") {
		// Notices ride the same rail as everything else: a row with no marker in
		// the gutter column broke the transcript's single left edge, which is
		// the thing that makes a wrapped reply read as one block. `ⓘ` replaces
		// the `[system]` prefix the text carries — the marker column already
		// says this is not the agent, so the word was chrome.
		const text = message.content.startsWith(SYSTEM_PREFIX)
			? message.content.slice(SYSTEM_PREFIX.length)
			: message.content;
		return (
			<MarkdownBody
				lines={renderMarkdownLines(text, { width: bodyWidth(width, "plain") })}
				gutter={colors.warning}
				bar="ⓘ"
				continuationBar="│"
				dimText
			/>
		);
	}
	return (
		<MarkdownBody
			lines={renderMarkdownLines(`[${message.role}] ${message.content}`, { width: bodyWidth(width) })}
			gutter={colors.muted}
			bar="│"
		/>
	);
}

export function ChatLog({
	messages,
	streaming,
	error,
	retry,
	columns,
	repaintKey,
	showReasoning,
}: ChatLogProps): JSX.Element {
	const liveParts: JSX.Element[] = [];

	const cols = Math.max(20, columns);
	// Sticky overflow compensation: the flat "-8" budget guess in
	// clampStreamingBlocks doesn't know the composer's actual height, open
	// palette, steer/queue lines, etc., so it can still under-reserve and let
	// the live region grow taller than the terminal. When that happens, the
	// DECXCPR scroll guard has to stop trusting polls (see useTerminalResync),
	// which is when scroll position gets lost. Once we observe a real
	// overflow (from the last actual Ink frame, ground truth) we shrink the
	// budget by that much for the rest of the turn — sticky, like the
	// composer's own height tracking — so one bad frame self-corrects instead
	// of repeating every frame. Resets when the turn ends.
	const stickyOverflowRef = useRef(0);
	if (streaming && streaming.blocks.length > 0) {
		const observed = getLastFrameOverflow();
		if (observed > stickyOverflowRef.current) stickyOverflowRef.current = observed;
	} else {
		stickyOverflowRef.current = 0;
	}

	const availableRows = process.stdout.rows || 24;

	// Error/warning before streaming — chronologically the error happened
	// first (e.g. vision fallback), then the agent responded.
	if (error) {
		liveParts.push(
			<Text key="error" color={theme().error}>
				│ {error}
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color={theme().warning}>
				│ Retrying (attempt {retry.attempt}): {retry.reason}
			</Text>,
		);
	}

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		const clamped = clampStreamingBlocks(streaming.blocks, availableRows, cols, stickyOverflowRef.current);
		const visibleBlocks = showReasoning ? clamped : clamped.filter(({ block }) => block.kind !== "thinking");
		for (const { block, truncated, index, lines } of visibleBlocks) {
			streamingParts.push(
				<BlockView
					key={blockKey(block, index)}
					block={block}
					truncated={truncated}
					compact
					showReasoning={showReasoning}
					width={cols}
					lines={lines}
				/>,
			);
		}
		// A completed text block is not the end of a turn: the model may still
		// be deciding on its next tool call. Keep one activity signal until a
		// running tool can speak for itself, or the turn actually ends.
		const hasVisibleRunningTool = visibleBlocks.some(
			({ block }) => block.kind === "tool" && block.call.status === "running",
		);
		if (!hasVisibleRunningTool) {
			// Even the activity frame keeps the rail — a bare spinner at column 0
			// was the one row that stepped out of line.
			streamingParts.push(
				<Text key="wait">
					<Text color={theme().muted} dimColor>
						{"│ "}
					</Text>
					<Spinner />
				</Text>,
			);
		}
		liveParts.push(
			<Box key="streaming" flexDirection="column">
				{streamingParts}
			</Box>,
		);
	}

	return (
		<>
			<Static key={repaintKey} items={messages}>
				{(m, i) => (
					<MessageView
						key={`m-${i}-${showReasoning ? "on" : "off"}-${cols}`}
						message={m}
						showReasoning={showReasoning}
						width={cols}
					/>
				)}
			</Static>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
