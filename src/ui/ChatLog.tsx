import { Box, Static, Text } from "ink";
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
	const mcp = isMcpTool(call.name);
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={theme().tool}>[{mcp ? mcpToolLabel(call.name) : call.name}]</Text>{" "}
				<Text color={statusColor}>[{call.status}]</Text>{" "}
				<ToolSummary name={call.name} args={call.args} compact={compact} />
			</Text>
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
}: {
	block: StreamBlock;
	truncated?: boolean;
	/** Live streaming region — keep tool rows short for the viewport clamp. */
	compact?: boolean;
	/** When false, drop `thinking` blocks entirely. Defaults to true so the
	 *  pure-BlockView test surface and any external callers stay unchanged. */
	showReasoning?: boolean;
}): JSX.Element | null {
	if (block.kind === "thinking") {
		if (showReasoning === false) return null;
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

	const wrappedRows = (text: string, prefixLen: number): number => {
		let total = 0;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const len = displayWidth(lines[i]!) + (i === 0 ? prefixLen : 0);
			total += Math.max(1, Math.ceil(len / cols));
		}
		return total;
	};

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
			const resultRows = block.call.result && block.call.status === "error" ? 1 : 0;
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
		const need = wrappedRows(block.text, prefixLen);
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
 * Stable-ish key for a block at a given index. Tool blocks have a real id;
 * text/reasoning runs are positionally stable (blocks only append or update
 * in place, never reorder or change kind at an index), so index suffices.
 */
function blockKey(block: StreamBlock, index: number): string {
	return block.kind === "tool" ? `tool-${block.call.id}` : `${block.kind}-${index}`;
}

function MessageView({ message, showReasoning }: { message: ChatMessage; showReasoning: boolean }): JSX.Element {
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
					<BlockView key={blockKey(b, i)} block={b} showReasoning={showReasoning} />
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
				[{error}]
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color={theme().warning}>
				[Retrying (attempt {retry.attempt}): {retry.reason}]
			</Text>,
		);
	}

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		if (streaming.blocks.length === 0) {
			streamingParts.push(<Spinner key="wait" />);
		}
		const clamped = clampStreamingBlocks(streaming.blocks, availableRows, cols, stickyOverflowRef.current);
		for (const { block, truncated, index } of clamped) {
			streamingParts.push(
				<BlockView
					key={blockKey(block, index)}
					block={block}
					truncated={truncated}
					compact
					showReasoning={showReasoning}
				/>,
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
				{(m, i) => <MessageView key={`m-${i}`} message={m} showReasoning={showReasoning} />}
			</Static>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
