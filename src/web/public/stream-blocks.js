// Browser-neutral streaming reducer shared by the TUI and web client.

// Cap the active reasoning block at this many characters. When the next
// thinking delta would push the active block past this, the older portion
// is moved into a settled (continued: false) sibling and the active block
// keeps only the most recent ~SPLIT_REASONING_CHARS chars.
//
// Why: a single still-streaming reasoning block can grow to thousands of
// chars. The TUI's scroll guard (useTerminalResync) disables its DECXCPR
// cursor poll once the live region exceeds the viewport, because the
// natural cursor-below-viewport position looks like a user scroll. With
// the poll disabled and a user-initiated scroll, Ink's CUU+erase redraws
// land at the wrong rows and the visible content "jumps" (rare, but
// repeatable on long reasoning). Capping the active block keeps the live
// region inside the viewport so the poll keeps running and the user can
// scroll up without corrupting the display. Content blocks are unaffected
// — splitCompleteLines already drains them via newlines.
const SPLIT_REASONING_CHARS = 1200;

export function appendTextBlock(blocks, kind, text) {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block.kind === "tool") break;
		if (block.kind === kind) {
			const merged = block.text + text;
			// Content drains via splitCompleteLines (newline-based); only
			// thinking needs the char-cap split.
			if (kind === "thinking" && merged.length > SPLIT_REASONING_CHARS) {
				const newText = merged.slice(-SPLIT_REASONING_CHARS);
				const oldText = merged.slice(0, -SPLIT_REASONING_CHARS);
				return [
					...blocks.slice(0, i),
					{ kind, text: oldText, continued: false },
					{ kind, text: newText, continued: true },
					...blocks.slice(i + 1),
				];
			}
			return [...blocks.slice(0, i), { kind, text: merged, continued: block.continued }, ...blocks.slice(i + 1)];
		}
	}
	const last = blocks.at(-1);
	const settledLast = last && last.kind !== "tool" && last.kind !== kind ? { ...last, continued: false } : last;
	const newBlock = { kind, text };
	// Same cap as the merge path: the very first event of a thinking stream
	// can already be >1200 chars (a single big delta), and there's no existing
	// block to merge into. Split here so the active block stays bounded from
	// delta #1, not just from delta #2 onward.
	if (kind === "thinking" && text.length > SPLIT_REASONING_CHARS) {
		return [
			...blocks.slice(0, -1),
			...(settledLast ? [settledLast] : []),
			{ kind, text: text.slice(0, -SPLIT_REASONING_CHARS), continued: false },
			{ kind, text: text.slice(-SPLIT_REASONING_CHARS), continued: true },
		];
	}
	return [...blocks.slice(0, -1), ...(settledLast ? [settledLast] : []), newBlock];
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
