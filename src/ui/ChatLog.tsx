import { Box, Text } from "ink";
import { type JSX, useMemo, useRef } from "react";
import { getLastFrameOverflow } from "../core/stdin-manager.ts";
import { displayWidth } from "./display-width.ts";
import { Spinner } from "./Spinner.tsx";
import { formatTaskToolSummary } from "./task-tool-summary.ts";
import { theme } from "./themes/index.ts";
import type { ChatMessage, RetryInfo, StreamBlock, StreamingState, ToolCallEntry } from "./useAgentSession.ts";

interface ChatLogProps {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
	/**
	 * Terminal columns/rows for wrapping and budget calculations. Both come
	 * from the same debounced resize tick (see ChatLogWithSize in App.tsx) —
	 * reading rows live from process.stdout while columns lagged behind its
	 * own debounce briefly disagreed with each other right after a resize,
	 * which could under-estimate row heights and let history overflow the
	 * viewport (pushing the composer below it) until the debounce settled.
	 */
	columns: number;
	rows: number;
	/**
	 * Bumped by App after a terminal resize (or theme change) settles. Used as
	 * the history Box's key to force a clean remount — the resize/theme
	 * handler clears the screen (see App.tsx's resize effect / onRepaintBanner)
	 * and this guarantees a full re-render lands right after, rather than
	 * relying on some other prop happening to change.
	 */
	repaintKey?: number;
	/**
	 * Rows scrolled up from the bottom (0 = pinned to the latest message).
	 * We run in Ink's alternate screen (see tui.tsx), which has no terminal
	 * scrollback of its own — once history exceeds the viewport height it
	 * would simply be gone with no way back, so ChatLog windows the message
	 * list itself and PageUp/PageDown (wired in App/Composer) move this.
	 */
	scrollOffset: number;
}

type ToolSummaryModel =
	| { kind: "edit"; path: string; added: number; removed: number }
	| { kind: "read"; path: string; range: string }
	| { kind: "write"; path: string; lines: number }
	| { kind: "task"; text: string }
	| { kind: "generic"; text: string };

/**
 * Parse the leading line number out of a hashline anchor like
 * `42:abc123` or `42:abc123:1f2`. Returns null for garbage — the
 * caller already falls back to a generic summary in that case.
 */
function anchorLineOf(anchor: unknown): number | null {
	if (typeof anchor !== "string") return null;
	const m = /^(\d+):/.exec(anchor);
	if (!m) return null;
	return Number.parseInt(m[1]!, 10);
}

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

	if (parsed && name === "edit" && typeof parsed.path === "string" && Array.isArray(parsed.ops)) {
		let added = 0;
		let removed = 0;
		for (const op of parsed.ops) {
			if (!op || typeof op !== "object") continue;
			const o = op as Record<string, unknown>;
			if (o.op === "write") continue;
			const content = typeof o.content === "string" ? o.content : "";
			if (o.op === "insert_after") {
				added += content.split("\n").length;
			} else if (o.op === "replace") {
				// Approximate line churn from the anchor range. The model
				// only sends anchors, not the original line text, so we
				// can't run `lineChurn` here without re-reading the file.
				// This is UI-only — the underlying tool is exact.
				const startLine = anchorLineOf(o.anchor);
				const endLine = o.end_anchor ? anchorLineOf(o.end_anchor) : startLine;
				if (startLine && endLine) {
					removed += Math.abs(endLine - startLine) + 1;
				}
				added += content.split("\n").length;
			}
		}
		return { kind: "edit", path: parsed.path, added, removed };
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

	const generic = parsed
		? Object.entries(parsed)
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
				.join(", ")
		: args.slice(0, 200);
	return { kind: "generic", text: generic };
}

/**
 * One-line summary for a tool call. Only the parse is memoized — the JSX is
 * rebuilt every render so theme() colors stay live: memoizing the whole
 * element on [name, args] kept the previous theme's colors on still-visible
 * rows after a /theme switch.
 */
function ToolSummary({ name, args, compact }: { name: string; args: string; compact?: boolean }): JSX.Element {
	const model = useMemo(() => parseToolSummary(name, args), [name, args]);
	if (model.kind === "edit") {
		return (
			<Text wrap="truncate">
				<Text color={theme().muted}>{model.path} · </Text>
				<Text color={theme().success}>+{model.added}</Text>
				<Text color={theme().muted}> </Text>
				<Text color={theme().error}>-{model.removed}</Text>
			</Text>
		);
	}
	if (model.kind === "read") {
		return (
			<Text color={theme().muted} wrap="truncate">
				{model.path} · lines {model.range}
			</Text>
		);
	}
	if (model.kind === "write") {
		return (
			<Text color={theme().muted} wrap="truncate">
				{model.path} · {model.lines} {model.lines === 1 ? "line" : "lines"}
			</Text>
		);
	}
	if (model.kind === "task") {
		// Live region: one line so parallel tasks stay visible under the clamp.
		// History: wrap the full assignment once the turn is committed.
		return (
			<Text color={theme().muted} wrap={compact ? "truncate" : "wrap"}>
				{model.text}
			</Text>
		);
	}
	return (
		<Text color={theme().muted} wrap="truncate">
			{model.text}
		</Text>
	);
}

function ToolCallView({ call, compact }: { call: ToolCallEntry; compact?: boolean }): JSX.Element {
	const statusColor =
		call.status === "running" ? theme().warning : call.status === "error" ? theme().error : theme().success;
	const resultColor = call.status === "error" ? theme().error : theme().muted;
	const showResult = Boolean(call.result) && call.name !== "read" && call.name !== "edit" && !isWebTool(call.name);
	// task: full wrapped report in history so the user can read the child answer;
	// live/compact stays one truncated line so parallel tasks don't blow the clamp.
	const taskResultFull = call.name === "task" && !compact && call.result;
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={theme().tool}>[{call.name}]</Text> <Text color={statusColor}>[{call.status}]</Text>{" "}
				<ToolSummary name={call.name} args={call.args} compact={compact} />
				{call.result && <WebResultSummary name={call.name} result={call.result} />}
			</Text>
			{showResult && taskResultFull && (
				<Text color={resultColor} wrap="wrap">
					{call.result}
				</Text>
			)}
			{showResult && !taskResultFull && (
				<Text color={resultColor} wrap="truncate">
					{call.result!.slice(0, 500)}
					{call.result!.length > 500 ? " ..." : ""}
				</Text>
			)}
		</Box>
	);
}

function isWebTool(name: string): boolean {
	return name === "web_search" || name === "web_fetch";
}

function WebResultSummary({ name, result }: { name: string; result: string }): JSX.Element | null {
	if (name === "web_search") {
		const meta = /^<!--(\{.*?})-->/.exec(result);
		if (meta) {
			try {
				const { count } = JSON.parse(meta[1]) as { count: number };
				return (
					<Text color={theme().muted}>
						{" · "}
						{count} result{count !== 1 ? "s" : ""}
					</Text>
				);
			} catch {
				// malformed — fall through
			}
		}
		return (
			<Text color={theme().muted}>
				{" · "}
				{result.startsWith("No results") ? 0 : result.split("\n\n").length} results
			</Text>
		);
	}
	if (name === "web_fetch") {
		return (
			<Text color={theme().muted}>
				{" · "}
				{result.length.toLocaleString()} chars
			</Text>
		);
	}
	return null;
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
}: {
	block: StreamBlock;
	truncated?: boolean;
	/** Live streaming region — keep tool rows short for the viewport clamp. */
	compact?: boolean;
}): JSX.Element {
	if (block.kind === "thinking") {
		return (
			<Text color={theme().muted} dimColor>
				{!block.continued && `[reasoning] ${truncated ? "… " : ""}`}
				{block.text}
			</Text>
		);
	}
	if (block.kind === "content") {
		return (
			<Text color={theme().agent}>
				{!block.continued && <Text bold>[agent] {truncated ? "… " : ""}</Text>}
				{block.text}
			</Text>
		);
	}
	return <ToolCallView call={block.call} compact={compact} />;
}

/**
 * Clamp the live streaming blocks to fit the terminal viewport, keeping the
 * tail. Ink's log-update redraws the live region by moving the cursor up N
 * rows and erasing — but the cursor can't move above the top of the screen,
 * so a live region taller than the viewport can't be fully erased and every
 * redraw stacks a duplicate frame into scrollback (repeated [reasoning] /
 * [agent] lines). Settled blocks already drain into <Static> (see
 * useAgentSession), but a single still-streaming block can grow past the
 * viewport on its own; here we render only its last lines that fit. The full
 * text still lands in history when the block settles — only the live preview
 * is clipped.
 *
 * Each entry carries the block's index in the *input* array so React keys
 * stay aligned with the unclamped list — keying by position in the clamped
 * output shifted identities whenever older blocks dropped out of the window.
 *
 * `extraReserve` shrinks the budget further, on top of the flat guess below.
 * It exists because the flat guess is only ever an estimate — the composer
 * grows with multi-line input, steer/queue notices stack, etc. — so ChatLog
 * feeds back the *actual* overflow of the last real Ink frame (see
 * getLastFrameOverflow) to keep the live region within the viewport even
 * when the estimate falls short. See the ChatLog component below.
 */
/** Rendered row count of `text` (wrapped at `cols`), with `prefixLen` extra
 * cells charged to the first line only (e.g. a "[agent] " label). */
function wrappedRows(text: string, prefixLen: number, cols: number): number {
	let total = 0;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const len = displayWidth(lines[i]!) + (i === 0 ? prefixLen : 0);
		total += Math.max(1, Math.ceil(len / cols));
	}
	return total;
}

export function clampStreamingBlocks(
	blocks: StreamBlock[],
	rows: number,
	columns: number,
	extraReserve = 0,
): Array<{ block: StreamBlock; truncated: boolean; index: number }> {
	// Rows reserved for everything below the streaming area: composer frame
	// (3), status bar (1), notices/steer/queue lines and a safety margin.
	const budget = Math.max(4, rows - 8 - extraReserve);
	const cols = Math.max(20, columns);

	const out: Array<{ block: StreamBlock; truncated: boolean; index: number }> = [];
	let used = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i]!;
		if (used >= budget) break;
		if (block.kind === "tool") {
			// Live ToolCallView uses compact truncate for task — charge 1 status
			// row (+ optional result). Full wrap is only in committed history.
			// Charging full wrap height hid sibling parallel tasks (only the
			// newest long assignment fit the budget).
			const resultRows = block.call.result && block.call.name !== "read" && !isWebTool(block.call.name) ? 1 : 0;
			const need = 1 + resultRows;
			if (used + need > budget) {
				if (out.length > 0) break;
				out.unshift({ block, truncated: true, index: i });
				used = budget;
				break;
			}
			out.unshift({ block, truncated: false, index: i });
			used += need;
			continue;
		}
		const prefixLen = block.continued ? 0 : block.kind === "thinking" ? "[reasoning] ".length : "[agent] ".length;
		const need = wrappedRows(block.text, prefixLen, cols);
		if (used + need <= budget) {
			out.unshift({ block, truncated: false, index: i });
			used += need;
			continue;
		}
		// Keep only the tail lines of this block that fit the remaining budget.
		const remaining = budget - used;
		const lines = block.text.split("\n");
		const kept: string[] = [];
		let tailRows = 0;
		for (let j = lines.length - 1; j >= 0 && tailRows < remaining; j--) {
			kept.unshift(lines[j]!);
			tailRows += Math.max(1, Math.ceil(displayWidth(lines[j]!) / cols));
		}
		// A single wrapped line longer than the budget: hard-cut by characters.
		// maxChars is measured in cells, so with wide chars this cuts slightly
		// more than strictly necessary — erring short is the safe direction.
		let text = kept.join("\n");
		const maxChars = remaining * cols;
		if (kept.length === 1 && text.length > maxChars) text = text.slice(-maxChars);
		out.unshift({ block: { ...block, text }, truncated: true, index: i });
		used = budget;
		break;
	}
	return out;
}

/**
 * Approximate rendered row count of a committed (non-live, full-wrap)
 * block — mirrors BlockView/ToolCallView's non-compact rendering closely
 * enough for scroll pagination. Doesn't need to be exact: worst case the
 * window shows a line or two more/less than the viewport, not a
 * correctness issue like clampStreamingBlocks' budget is.
 */
function estimateBlockRows(block: StreamBlock, cols: number): number {
	if (block.kind === "tool") {
		const showResult =
			Boolean(block.call.result) &&
			block.call.name !== "read" &&
			block.call.name !== "edit" &&
			!isWebTool(block.call.name);
		if (!showResult) return 1;
		if (block.call.name === "task") return 1 + wrappedRows(block.call.result ?? "", 0, cols);
		return 2; // truncated single-line result
	}
	const prefixLen = block.continued ? 0 : block.kind === "thinking" ? "[reasoning] ".length : "[agent] ".length;
	return wrappedRows(block.text, prefixLen, cols);
}

/** Approximate rendered row count of a whole history message. */
function estimateMessageRows(message: ChatMessage, cols: number): number {
	if (message.role === "user") return wrappedRows(message.content, "[user] ".length, cols);
	if (message.role === "assistant") {
		const rows = (message.blocks ?? []).reduce((sum, b) => sum + estimateBlockRows(b, cols), 0);
		return Math.max(1, rows);
	}
	if (message.role === "warning") return wrappedRows(message.content, 0, cols);
	return wrappedRows(`[${message.role}] ${message.content}`, 0, cols);
}

/**
 * Windows `messages` down to roughly `budgetRows` rows, `scrollOffset` rows
 * up from the bottom. Whole messages only (no mid-message clipping) — a
 * message straddling the window's edge just makes the window a bit taller
 * or shorter than budgetRows, which reads better than cutting a message
 * across an arbitrary line.
 */
function windowMessages(
	messages: ChatMessage[],
	cols: number,
	budgetRows: number,
	scrollOffset: number,
): { start: number; end: number } {
	let end = messages.length;
	let skipped = 0;
	while (end > 0) {
		const rows = estimateMessageRows(messages[end - 1]!, cols);
		if (skipped + rows > scrollOffset) break;
		skipped += rows;
		end--;
	}
	if (end === 0 && skipped < scrollOffset) {
		// Scrolled past the very top of history — pin to the beginning instead
		// of showing nothing.
		let start = 0;
		let collected = 0;
		while (start < messages.length && collected < budgetRows) {
			collected += estimateMessageRows(messages[start]!, cols);
			start++;
		}
		return { start: 0, end: start };
	}
	let start = end;
	let collected = 0;
	while (start > 0 && collected < budgetRows) {
		collected += estimateMessageRows(messages[start - 1]!, cols);
		start--;
	}
	return { start, end };
}

/**
 * Stable-ish key for a block at a given index. Tool blocks have a real id;
 * text/reasoning runs are positionally stable (blocks only append or update
 * in place, never reorder or change kind at an index), so index suffices.
 */
function blockKey(block: StreamBlock, index: number): string {
	return block.kind === "tool" ? `tool-${block.call.id}` : `${block.kind}-${index}`;
}

function MessageView({ message }: { message: ChatMessage }): JSX.Element {
	if (message.role === "user") {
		return (
			<Box flexDirection="column">
				<Text color={theme().user}>
					<Text bold>[user] </Text>
					{message.content}
				</Text>
			</Box>
		);
	}
	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				{message.blocks?.map((b, i) => (
					<BlockView key={blockKey(b, i)} block={b} />
				))}
			</Box>
		);
	}
	if (message.role === "warning") {
		return (
			<Box>
				<Text color={theme().warning}>{message.content}</Text>
			</Box>
		);
	}
	return (
		<Text>
			[{message.role}] {message.content}
		</Text>
	);
}

export function ChatLog({
	messages,
	streaming,
	error,
	retry,
	columns,
	rows,
	repaintKey,
	scrollOffset,
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

	const availableRows = Math.max(4, rows);

	// Error/warning before streaming — chronologically the error happened
	// first (e.g. vision fallback), then the agent responded.
	if (error) {
		liveParts.push(
			<Text key="error" color={theme().error}>
				[{error}]
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color={theme().warning}>
				[Retrying ({retry.attempt}/{retry.maxAttempts}): {retry.reason}]
			</Text>,
		);
	}

	// Rows the live region actually uses this frame — history gets whatever's
	// left of the viewport, not a flat guess, so it doesn't collapse to
	// nothing under a big streaming turn nor waste rows when idle.
	let liveRowsUsed = error ? 1 : 0;
	if (retry) liveRowsUsed += 1;

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		if (streaming.blocks.length === 0) {
			streamingParts.push(<Spinner key="wait" />);
			liveRowsUsed += 1;
		}
		const clamped = clampStreamingBlocks(streaming.blocks, availableRows, cols, stickyOverflowRef.current);
		for (const { block, truncated, index } of clamped) {
			streamingParts.push(<BlockView key={blockKey(block, index)} block={block} truncated={truncated} compact />);
			if (block.kind === "tool") {
				const resultRows = block.call.result && block.call.name !== "read" && !isWebTool(block.call.name) ? 1 : 0;
				liveRowsUsed += 1 + resultRows;
			} else {
				const prefixLen = block.continued
					? 0
					: block.kind === "thinking"
						? "[reasoning] ".length
						: "[agent] ".length;
				liveRowsUsed += wrappedRows(block.text, prefixLen, cols);
			}
		}
		liveParts.push(
			<Box key="streaming" flexDirection="column">
				{streamingParts}
			</Box>,
		);
	}

	// Flat guess for everything below the history area that isn't the live
	// region itself: composer frame, status bar, notices/steer/queue lines,
	// plus one row for the scroll indicator below.
	const belowReserve = 9;
	const historyBudget = Math.max(3, availableRows - belowReserve - liveRowsUsed);
	const { start, end } = windowMessages(messages, cols, historyBudget, Math.max(0, scrollOffset));
	const visible = messages.slice(start, end);
	const hiddenAbove = start > 0;
	const hiddenBelow = end < messages.length;

	return (
		<>
			<Box key={repaintKey} flexDirection="column">
				{(hiddenAbove || hiddenBelow) && (
					<Text color={theme().muted} dimColor>
						{hiddenAbove ? "▲ more above" : ""}
						{hiddenAbove && hiddenBelow ? " · " : ""}
						{hiddenBelow ? "▼ scrolled — PageDown to catch up" : ""}
						{" (PageUp/PageDown to scroll)"}
					</Text>
				)}
				{visible.map((m, i) => (
					<MessageView key={`m-${start + i}`} message={m} />
				))}
			</Box>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
