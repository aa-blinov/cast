import htm from "htm";
import { h } from "preact";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { collapseMidWordBoundaries } from "./reasoning-split.js";
import { reduceStreamEvent } from "./stream-blocks.js";
import { ToolCard } from "./tool-card.js";

const html = htm.bind(h);

function StreamingText({ text, className }) {
	const textNodeRef = useRef(null);
	const setRef = (element) => {
		if (element && !textNodeRef.current) {
			textNodeRef.current = document.createTextNode(text);
			element.appendChild(textNodeRef.current);
		}
	};
	useLayoutEffect(() => {
		if (textNodeRef.current) textNodeRef.current.data = text;
	}, [text]);
	return html`<div ref=${setRef} class=${className ?? "message-content"}></div>`;
}

function StreamingMarkdown({ text, renderMarkdown }) {
	const elRef = useRef(null);
	const setRef = (el) => {
		if (el && !elRef.current) elRef.current = el;
		if (el && text) {
			const fenceCount = (text.match(/```/g) || []).length;
			const patched = fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
			el.innerHTML = renderMarkdown(patched);
		}
	};
	useLayoutEffect(() => {
		if (!elRef.current) return;
		const fenceCount = (text.match(/```/g) || []).length;
		const patched = fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text;
		elRef.current.innerHTML = renderMarkdown(patched);
	}, [text, renderMarkdown]);
	return html`<div ref=${setRef} class="message-content"></div>`;
}

export function BlockView({ block, streaming = false, renderMarkdown, showReasoning = true }) {
	if (block.kind === "tool") {
		// Key on the tool-call id (not position): when a second tool call
		// streams in, Preact must NOT reuse this ToolCard's DOM node for
		// the new one and must NOT remount this one when its own block is
		// updated in place by tool_end — both would clobber the local
		// `open`/`previewSrc` state the user is currently looking at.
		return html`<${ToolCard} key=${block.call.id} call=${block.call} renderMarkdown=${renderMarkdown} />`;
	}
	if (!block.text.trim()) return null;
	// Reasoning models (MiniMax-M3, etc.) stream a lot of auxiliary
	// thinking that just clutters the transcript. The /reasoning-display
	// toggle (and the Appearance panel checkbox) flips this flag for the
	// current session — when off, drop thinking blocks entirely. The
	// default stays true so existing callers and the initial render match
	// the prior behavior (reasoning visible by default) unless the user
	// opts in to the toggle.
	if (block.kind === "thinking" && !showReasoning) return null;
	const kind = block.kind === "thinking" ? "reasoning" : "assistant";
	const isReasoning = block.kind === "thinking";
	const className = `message message-${kind}`;
	const streamingClass = streaming ? " message-entering" : "";
	return html`
		<div class=${className + streamingClass}>
			<div class="message-label">${block.kind === "thinking" ? "reasoning" : "agent"}</div>
			${
				streaming
					? isReasoning
						? html`<${StreamingText} text=${block.text} />`
						: html`<${StreamingMarkdown} text=${block.text} renderMarkdown=${renderMarkdown} />`
					: block.kind === "thinking"
						? html`<div class="message-content">${block.text}</div>`
						: html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />`
			}
		</div>
	`;
}

export function StreamingBlocks({ blocks, renderMarkdown, showReasoning = true }) {
	if (!blocks || blocks.length === 0) return null;
	const collapsed = collapseMidWordBoundaries(blocks);
	return html`
		<div class="message-group">
			${collapsed.map(
				(block, index) =>
					html`<${BlockView}
						key=${block.order ?? `${block.kind}-${index}-${showReasoning ? "on" : "off"}`}
						block=${block}
						streaming
						renderMarkdown=${renderMarkdown}
						showReasoning=${showReasoning}
					/>`,
			)}
		</div>
	`;
}

export function LiveStreamingBlocks({ controllerRef, onFrame, renderMarkdown, showReasoning = true }) {
	const [stream, setStream] = useState({ blocks: [] });
	const streamRef = useRef({ blocks: [] });
	// { kind: "raf" | "timeout", id } — the throttled path below schedules a
	// timeout, the immediate one a frame, and the two id spaces are unrelated:
	// storing both in one ref and always calling cancelAnimationFrame meant a
	// pending throttle timer survived reset/take/hydrate/unmount and fired a
	// stale flush afterwards, while the number it did pass to
	// cancelAnimationFrame could cancel an unrelated frame that happened to
	// share the id.
	const pendingRef = useRef(null);
	const cancelPending = useCallback(() => {
		const pending = pendingRef.current;
		if (!pending) return;
		if (pending.kind === "raf") cancelAnimationFrame(pending.id);
		else clearTimeout(pending.id);
		pendingRef.current = null;
	}, []);
	const lastFlushRef = useRef(0);
	const flush = useCallback(() => {
		pendingRef.current = null;
		lastFlushRef.current = performance.now();
		setStream({ blocks: [...streamRef.current.blocks] });
		onFrame();
	}, [onFrame]);
	const reduce = useCallback(
		(event) => {
			streamRef.current = reduceStreamEvent(streamRef.current, event);
			if (pendingRef.current != null) return;
			const since = performance.now() - lastFlushRef.current;
			// Throttle streaming renders to ~12fps (80ms) — full markdown re-parse
			// on every token is O(n²). Coalescing via RAF already helps, but for
			// 4-5 tokens per frame we still re-parse the whole growing text.
			// 80ms keeps typing feel smooth while cutting renders 4× on fast streams.
			const delay = since < 80 ? 80 - since : 0;
			if (delay === 0) {
				pendingRef.current = { kind: "raf", id: requestAnimationFrame(flush) };
			} else {
				pendingRef.current = {
					kind: "timeout",
					id: setTimeout(() => {
						// Re-registered as a frame, so a cancel landing between the
						// timeout firing and the frame running still catches it.
						pendingRef.current = { kind: "raf", id: requestAnimationFrame(flush) };
					}, delay),
				};
			}
		},
		[flush],
	);
	const reset = useCallback(() => {
		cancelPending();
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
	}, [cancelPending]);
	const take = useCallback(() => {
		cancelPending();
		const snapshot = streamRef.current.blocks;
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
		return snapshot;
	}, [cancelPending]);
	const hydrate = useCallback((blocks) => {
		cancelPending();
		const snapshot = Array.isArray(blocks) ? [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
		streamRef.current = { blocks: snapshot };
		setStream({ blocks: snapshot });
	}, [cancelPending]);
	controllerRef.current = { reduce, reset, take, hydrate };
	useEffect(
		() => () => {
			cancelPending();
			if (controllerRef.current?.reset === reset) controllerRef.current = null;
		},
		[cancelPending, controllerRef, reset],
	);
	return html`<${StreamingBlocks} blocks=${stream.blocks} renderMarkdown=${renderMarkdown} showReasoning=${showReasoning} />`;
}
