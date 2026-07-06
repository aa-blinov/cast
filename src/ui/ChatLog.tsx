import { Box, Static, Text } from "ink";
import { type JSX, useMemo } from "react";
import { gradientHex } from "./gradient.ts";
import { Spinner } from "./Spinner.tsx";
import type { ChatMessage, RetryInfo, StreamingState, ToolCallEntry } from "./useAgentSession.ts";

interface ChatLogProps {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
	/**
	 * Bumped by App after a terminal resize settles. Used as the <Static> key so
	 * the whole history is replayed from a clean top — Ink otherwise only prints
	 * newly-added static items, so a resize-time screen clear would wipe the
	 * on-screen history with no way to redraw it. See App.tsx's resize effect.
	 */
	repaintKey?: number;
}

/**
 * Tail of `text` that fits within `maxRows` terminal rows, accounting for line
 * wrapping at `columns`. Keeps the most recent lines — what the user is watching
 * stream in — and reports how many older lines were dropped.
 *
 * This bounds the height of the live (non-<Static>) streaming region. Ink
 * repaints the *entire* static history — scrolling the viewport to the top of
 * the conversation — on any frame whose interactive output is taller than the
 * terminal (shouldClearTerminalForFrame in ink 7.x: `wasOverflowing ||
 * isOverflowing`). A long model reasoning block would otherwise blow past the
 * screen on every streamed token, so scrolling up mid-generation constantly
 * snapped back to the start. The full text still lands in scrollback once the
 * turn is promoted to history, so nothing is lost.
 */
export function clampTailToRows(
	text: string,
	maxRows: number,
	columns: number,
): { text: string; hiddenLines: number; usedRows: number } {
	if (!text) return { text: "", hiddenLines: 0, usedRows: 0 };
	const cols = Math.max(1, columns);
	const budget = Math.max(1, maxRows);
	const lines = text.split("\n");
	const rowCost = (line: string) => Math.max(1, Math.ceil(line.length / cols));

	let usedRows = 0;
	let start = lines.length;
	for (let i = lines.length - 1; i >= 0; i--) {
		const cost = rowCost(lines[i]!);
		// Always keep at least the last line, even if it alone exceeds the budget.
		if (start !== lines.length && usedRows + cost > budget) break;
		usedRows += cost;
		start = i;
	}
	return { text: lines.slice(start).join("\n"), hiddenLines: start, usedRows };
}

/**
 * Rows reserved for the rest of the interactive frame (composer, status line,
 * notices, borders) when budgeting the live streaming region. Kept generous so
 * the live column stays comfortably under the terminal height even while the
 * composer is a few lines tall.
 */
const RENDER_ROW_RESERVE = 12;

/** Dim marker shown above a clamped streaming block: older lines are in history. */
function TruncationNote({ hidden }: { hidden: number }): JSX.Element {
	return (
		<Text color="gray" dimColor>
			⋯ {hidden} earlier {hidden === 1 ? "line" : "lines"} above (full text kept in history)
		</Text>
	);
}

const TOOL_COLOR = gradientHex(0);
// Sampled from the same cyan→violet brand gradient (t=0.3 lands on a clean
// sky blue) rather than raw ANSI "blue", which reads dark/muddy on a black
// background and doesn't relate to the rest of the palette.
const USER_COLOR = gradientHex(0.3);
// No point along the cyan→violet gradient can be green (neither endpoint has
// enough green channel to interpolate through it), so this is a standalone
// hex picked to match the gradient's brightness/saturation level instead —
// vivid and readable on black, not the muddier default ANSI "green".
const AGENT_COLOR = "#4ade80";

/**
 * Line-level churn between two blocks of text. Uses an LCS so the counts
 * reflect the lines that actually changed, not the whole replaced block — a
 * one-line tweak inside a 6-line oldText/newText reads as "+1 -1", not "+6 -6".
 * Falls back to a block count for pathologically large edits so the O(m·n) DP
 * can't stall the render.
 */
function lineChurn(oldText: string, newText: string): { added: number; removed: number } {
	const a = oldText.split("\n");
	const b = newText.split("\n");
	const m = a.length;
	const n = b.length;
	if (m * n > 250_000) return { removed: m, added: n };
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const lcs = dp[0]![0]!;
	return { removed: m - lcs, added: n - lcs };
}

/**
 * One-line summary for a tool call. edit/write get a readable file + change
 * summary instead of a truncated JSON blob; every other tool keeps the generic
 * `key=value` args. Args stream in as partial JSON, so anything that fails to
 * parse (or doesn't match the expected shape) falls back to the raw/generic
 * form — the rich view only kicks in once the call is complete.
 */
function ToolSummary({ name, args }: { name: string; args: string }): JSX.Element {
	return useMemo(() => {
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(args) as Record<string, unknown>;
		} catch {
			parsed = null;
		}

		if (parsed && name === "edit" && typeof parsed.path === "string" && Array.isArray(parsed.edits)) {
			let added = 0;
			let removed = 0;
			for (const e of parsed.edits) {
				if (e && typeof e === "object" && typeof (e as { oldText?: unknown }).oldText === "string") {
					const churn = lineChurn(
						(e as { oldText: string }).oldText,
						String((e as { newText?: unknown }).newText ?? ""),
					);
					added += churn.added;
					removed += churn.removed;
				}
			}
			return (
				<Text wrap="truncate">
					<Text color="gray">{parsed.path} · </Text>
					<Text color="green">+{added}</Text>
					<Text color="gray"> </Text>
					<Text color="red">-{removed}</Text>
				</Text>
			);
		}

		if (parsed && name === "write" && typeof parsed.path === "string") {
			const lines = typeof parsed.content === "string" ? parsed.content.split("\n").length : 0;
			return (
				<Text color="gray" wrap="truncate">
					{parsed.path} · {lines} {lines === 1 ? "line" : "lines"}
				</Text>
			);
		}

		const generic = parsed
			? Object.entries(parsed)
					.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
					.join(", ")
			: args.slice(0, 200);
		return (
			<Text color="gray" wrap="truncate">
				{generic}
			</Text>
		);
	}, [name, args]);
}

function ToolCallView({ call }: { call: ToolCallEntry }): JSX.Element {
	const statusColor = call.status === "running" ? "yellow" : call.status === "error" ? "red" : "green";
	return (
		<Box flexDirection="column">
			<Text>
				<Text color={TOOL_COLOR}>[{call.name}]</Text> <Text color={statusColor}>[{call.status}]</Text>{" "}
				<ToolSummary name={call.name} args={call.args} />
			</Text>
			{call.result && (
				<Text color={call.status === "error" ? "red" : "gray"} wrap="truncate">
					{call.result.slice(0, 500)}
					{call.result.length > 500 ? " ..." : ""}
				</Text>
			)}
		</Box>
	);
}

function MessageView({ message }: { message: ChatMessage }): JSX.Element {
	if (message.role === "user") {
		return (
			<Box flexDirection="column">
				<Text color={USER_COLOR}>
					<Text bold>[user] </Text>
					{message.content}
				</Text>
			</Box>
		);
	}
	if (message.role === "assistant") {
		return (
			<Box flexDirection="column">
				{/* Reasoning first (chronological: the model thinks, then answers) —
				    same dim style as the live streaming view so it reads identically
				    once the turn lands in history. */}
				{message.thinking && (
					<Text color="gray" dimColor>
						<Text bold>[reasoning] </Text>
						{message.thinking}
					</Text>
				)}
				{message.content && (
					<Text color={AGENT_COLOR}>
						<Text bold>[agent] </Text>
						{message.content}
					</Text>
				)}
				{message.toolCalls &&
					message.toolCalls.length > 0 &&
					message.toolCalls.map((c) => <ToolCallView key={c.id} call={c} />)}
			</Box>
		);
	}
	if (message.role === "warning") {
		return (
			<Box>
				<Text color="yellow">{message.content}</Text>
			</Box>
		);
	}
	return (
		<Text>
			[{message.role}] {message.content}
		</Text>
	);
}

export function ChatLog({ messages, streaming, error, retry, repaintKey }: ChatLogProps): JSX.Element {
	const liveParts: JSX.Element[] = [];

	// Error/warning before streaming — chronologically the error happened
	// first (e.g. vision fallback), then the agent responded.
	if (error) {
		liveParts.push(
			<Text key="error" color="red">
				[{error}]
			</Text>,
		);
	}

	if (retry) {
		liveParts.push(
			<Text key="retry" color="yellow">
				[Retrying ({retry.attempt}/{retry.maxAttempts}): {retry.reason}]
			</Text>,
		);
	}

	if (streaming) {
		const streamingParts: JSX.Element[] = [];
		const hasOutput = streaming.thinking || streaming.content || streaming.toolCalls.length > 0;
		if (!hasOutput) {
			streamingParts.push(<Spinner key="wait" />);
		}

		// Bound the live region to the terminal so Ink doesn't repaint the whole
		// history (jumping the viewport to the top) on every streamed token — see
		// clampTailToRows. Content is the answer, so it gets budget priority;
		// reasoning fills whatever rows remain. The rest of the live column
		// (composer, status, tool calls) is left headroom by the reserve.
		const rows = process.stdout.rows ?? 24;
		const cols = process.stdout.columns ?? 80;
		let budget = Math.max(4, rows - RENDER_ROW_RESERVE - streaming.toolCalls.length);

		// Chronological order: reasoning first, then the answer. Compute the
		// content clamp first (priority for budget), but render reasoning above it.
		let contentPart: JSX.Element | null = null;
		if (streaming.content) {
			const c = clampTailToRows(streaming.content, budget, cols);
			budget -= c.usedRows;
			contentPart = (
				<Box key="c" flexDirection="column">
					{c.hiddenLines > 0 && <TruncationNote hidden={c.hiddenLines} />}
					<Text color={AGENT_COLOR}>
						<Text bold>[agent] </Text>
						{c.text}
					</Text>
				</Box>
			);
		}
		if (streaming.thinking) {
			const t = clampTailToRows(streaming.thinking, Math.max(1, budget), cols);
			streamingParts.push(
				<Box key="t" flexDirection="column">
					{t.hiddenLines > 0 && <TruncationNote hidden={t.hiddenLines} />}
					<Text color="gray" dimColor>
						<Text bold>[reasoning] </Text>
						{t.text}
					</Text>
				</Box>,
			);
		}
		if (contentPart) streamingParts.push(contentPart);
		for (const tc of streaming.toolCalls) {
			streamingParts.push(<ToolCallView key={tc.id} call={tc} />);
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
				{(m, i) => <MessageView key={`m-${i}`} message={m} />}
			</Static>
			<Box flexDirection="column">{liveParts}</Box>
		</>
	);
}
