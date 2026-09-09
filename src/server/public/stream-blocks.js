// Browser-neutral streaming reducer shared by the TUI and web client.
export function appendTextBlock(blocks, kind, text) {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block.kind === "tool") break;
		if (block.kind === kind) {
			return [
				...blocks.slice(0, i),
				{ kind, text: block.text + text, continued: block.continued },
				...blocks.slice(i + 1),
			];
		}
	}
	const last = blocks.at(-1);
	const settledLast = last && last.kind !== "tool" && last.kind !== kind ? { ...last, continued: false } : last;
	return [...blocks.slice(0, -1), ...(settledLast ? [settledLast] : []), { kind, text }];
}

// The terminal assistant event is a recovery path for clients that did not
// receive its live SSE deltas. Its content still precedes the tool calls that
// follow it in the core loop, so preserve that order when reconstructing it.
export function blocksFromAssistantCompletion({ thinking, content, toolCalls }) {
	const blocks = [];
	if (thinking) blocks.push({ kind: "thinking", text: thinking });
	if (content) blocks.push({ kind: "content", text: content });
	for (const call of toolCalls ?? []) {
		blocks.push({
			kind: "tool",
			call: { id: call.id ?? "", name: call.name, args: call.arguments, status: "ok" },
		});
	}
	return blocks;
}

export function reduceStreamEvent(state, event) {
	if (event.type === "thinking" || event.type === "content") {
		if (event.type === "content" && event.text.trim() === "" && state.blocks.at(-1)?.kind === "thinking") {
			return { ...state, pendingContentWhitespace: `${state.pendingContentWhitespace ?? ""}${event.text}` };
		}
		if (event.type === "thinking") return { blocks: appendTextBlock(state.blocks, "thinking", event.text) };
		return {
			blocks: appendTextBlock(state.blocks, "content", `${state.pendingContentWhitespace ?? ""}${event.text}`),
		};
	}
	if (event.type === "tool_start") {
		return { blocks: [...state.blocks, { kind: "tool", call: event.call }] };
	}
	return {
		blocks: state.blocks.map((block) =>
			block.kind === "tool" && block.call.id === event.id
				? {
						// Spread `block` first to preserve fields the reducer
						// doesn't explicitly set — `order` is the streaming
						// block's identity for the React key (see
						// streaming-blocks.js's `block.order ?? ${kind}-${idx}`).
						// Dropping it would change the key on every tool_end
						// and remount the BlockView (and the ToolCard inside
						// it), clobbering the user's open/preview state mid-
						// read.
						...block,
						call: {
							...block.call,
							status: event.status,
							...(event.result === undefined ? {} : { result: event.result }),
							...(event.images === undefined ? {} : { images: event.images }),
						},
					}
				: block,
		),
	};
}

/**
 * How often the streaming answer may be repainted, by how long it already is.
 *
 * Each repaint replaces the block's HTML, and the browser then re-parses and
 * re-lays-out all of it — the cost grows with the answer while the render rate
 * does not, which is where a long turn's jank comes from. Traced on a CPU
 * throttled 6× (a mid-range laptop), an eight-second answer spent ~1.2s in
 * layout alone, and the transcript above it made no difference: it is the
 * growing block itself.
 *
 * So a short answer keeps the full ~12fps, where the difference is visible,
 * and a long one slows to ~4fps, where it is not — nobody reads the tail of a
 * 30KB answer as it lands, and the text still arrives continuously.
 */
export const MIN_FLUSH_MS = 80;
export const MAX_FLUSH_MS = 250;
/** Text length at which the interval reaches MAX_FLUSH_MS. */
const FLUSH_RAMP_CHARS = 12000;

export function flushInterval(blocks) {
	let length = 0;
	for (const block of blocks) if (block.kind !== "tool") length += block.text.length;
	const ramp = Math.min(1, length / FLUSH_RAMP_CHARS);
	return MIN_FLUSH_MS + (MAX_FLUSH_MS - MIN_FLUSH_MS) * ramp;
}
