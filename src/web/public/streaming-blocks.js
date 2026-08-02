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

export function BlockView({ block, streaming = false, renderMarkdown }) {
	if (block.kind === "tool") {
		// Key on the tool-call id (not position): when a second tool call
		// streams in, Preact must NOT reuse this ToolCard's DOM node for
		// the new one and must NOT remount this one when its own block is
		// updated in place by tool_end — both would clobber the local
		// `open`/`previewSrc` state the user is currently looking at.
		return html`<${ToolCard} key=${block.call.id} call=${block.call} renderMarkdown=${renderMarkdown} />`;
	}
	if (!block.text.trim()) return null;
	const kind = block.kind === "thinking" ? "reasoning" : "assistant";
	const className = `message message-${kind}${streaming ? " message-entering" : ""}`;
	return html`
		<div class=${className}>
			<div class="message-label">${block.kind === "thinking" ? "reasoning" : "agent"}</div>
			${
				streaming
					? html`<${StreamingText} text=${block.text} />`
					: block.kind === "thinking"
						? html`<div class="message-content">${block.text}</div>`
						: html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(block.text) }} />`
			}
		</div>
	`;
}

export function StreamingBlocks({ blocks, renderMarkdown }) {
	if (!blocks || blocks.length === 0) return null;
	const collapsed = collapseMidWordBoundaries(blocks);
	return html`
		<div class="message-group">
			${collapsed.map(
				(block, index) =>
					html`<${BlockView}
						block=${block}
					streaming
					key=${block.order ?? `${block.kind}-${index}`}
					renderMarkdown=${renderMarkdown}
					/>`,
			)}
		</div>
	`;
}

export function LiveStreamingBlocks({ controllerRef, onFrame, renderMarkdown }) {
	const [stream, setStream] = useState({ blocks: [] });
	const streamRef = useRef({ blocks: [] });
	const rafRef = useRef(null);
	const flush = useCallback(() => {
		rafRef.current = null;
		setStream(streamRef.current);
		onFrame();
	}, [onFrame]);
	const reduce = useCallback(
		(event) => {
			streamRef.current = reduceStreamEvent(streamRef.current, event);
			if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
		},
		[flush],
	);
	const reset = useCallback(() => {
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		rafRef.current = null;
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
	}, []);
	const take = useCallback(() => {
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		rafRef.current = null;
		const snapshot = streamRef.current.blocks;
		streamRef.current = { blocks: [] };
		setStream({ blocks: [] });
		return snapshot;
	}, []);
	const hydrate = useCallback((blocks) => {
		if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
		rafRef.current = null;
		const snapshot = Array.isArray(blocks) ? [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : [];
		streamRef.current = { blocks: snapshot };
		setStream({ blocks: snapshot });
	}, []);
	controllerRef.current = { reduce, reset, take, hydrate };
	useEffect(
		() => () => {
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			if (controllerRef.current?.reset === reset) controllerRef.current = null;
		},
		[controllerRef, reset],
	);
	return html`<${StreamingBlocks} blocks=${stream.blocks} renderMarkdown=${renderMarkdown} />`;
}
