import htm from "htm";
import { h } from "preact";
import { useState } from "preact/hooks";
import { FilePreviewModal } from "./file-preview.js";
import { icons } from "./icons.js";
import { collapseMidWordBoundaries, mergeMidWordBoundary } from "./reasoning-split.js";
import { BlockView } from "./streaming-blocks.js";
import { ToolCard } from "./tool-card.js";
import { TurnMetaLine } from "./turn-meta.js";

const html = htm.bind(h);

export function Message({ msg, renderMarkdown, escapeHtml, showReasoning = true }) {
	const role = msg.role || "assistant";
	// Only used by the legacy floating image-result branch below (pre
	// castToolCallId sessions) — declared unconditionally so hook order stays
	// stable across renders regardless of which branch a given msg takes.
	const [previewSrc, setPreviewSrc] = useState(null);
	if (role === "tool") return null;

	const labelMap = {
		user: "you",
		agent: "agent",
		assistant: "agent",
		system: "system",
		warning: "notice",
		error: "error",
	};

	// Messages flushed from a live turn this session carry the full ordered
	// block sequence (reasoning / prose / tool calls, same shape as
	// StreamingBlocks) instead of one flattened string — render each block
	// distinctly so reasoning doesn't silently blend into the reply, and so
	// every tool call this turn made stays visible after it settles.
	if (role === "assistant" && Array.isArray(msg.blocks)) {
		// When the parser splits the model output mid-word (e.g. </think>
		// landed inside "Сейчас" so the reasoning ends "...Сей" and the
		// content starts "час уточню..."), glue the boundary back together
		// before rendering. See reasoning-split.js's mergeMidWordBoundary.
		const collapsed = collapseMidWordBoundaries(msg.blocks);
		// Settled-message blocks render without the `message-entering`
		// class — the entrance rise keyframe is reserved for blocks
		// that appear *during* a stream (a new reasoning chunk, a new
		// tool card, etc.) where it visually marks "the model just
		// emitted this". On settled messages the rise was the source of
		// the "blink on submit" / "blink on final chunk" flicker: the
		// user message mounted on send and the assistant message
		// remounted when the stream settled both ran the 150ms fade-up,
		// which read as a UI stutter on a quiet chat. The settled
		// Message subtree is keyed by msg object identity, so a
		// re-render of the same history row reuses the same DOM and
		// wouldn't replay the animation anyway — but the *first* mount
		// of every new settled msg (the user just clicked send, the
		// assistant just finished) was the visible one. Now silent.
		return html`
			<div class="message-group">
				${collapsed.map((block, i) => html`<${BlockView} key=${block.kind === "tool" ? block.call.id : `${block.kind}-${i}-${showReasoning ? "on" : "off"}`} block=${block} renderMarkdown=${renderMarkdown} showReasoning=${showReasoning} />`)}
				<${TurnMetaLine} turnMeta=${msg.turnMeta} />
			</div>
		`;
	}

	// content is `null` for a tool-call-only turn (see core/loop.ts) — treat
	// that as "no text", not the literal string "null" JSON.stringify gives it.
	let content = typeof msg.content === "string" ? msg.content : msg.content == null ? "" : JSON.stringify(msg.content);

	if (role === "assistant") {
		let visibleThinking = msg.thinking;
		// The parser may have split the model's output mid-word (e.g.
		// </think> landed inside "Сейчас" — observed on MiniMax-M3) so
		// msg.thinking ends "...Сей" and content starts "час уточню...".
		// Glide the boundary back together so the user sees the model-intended
		// continuous word, not two halves separated across blocks.
		if (visibleThinking && content) {
			const merged = mergeMidWordBoundary(visibleThinking, content);
			if (merged.thinkingText !== visibleThinking) {
				visibleThinking = merged.thinkingText;
				content = merged.contentText;
			}
		}
		return html`
			<div class="message-group">
				${
					visibleThinking &&
					showReasoning &&
					html`
					<div class="message message-reasoning">
						<div class="message-label">reasoning</div>
						<div class="message-content">${visibleThinking}</div>
					</div>
				`
				}
				${
					content &&
					html`
					<div class="message message-assistant">
						<div class="message-label">agent</div>
						<div class="message-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(content) }} />
					</div>
				`
				}
				${msg.toolCalls?.map((tc) => html`<${ToolCard} key=${tc.id} call=${tc} renderMarkdown=${renderMarkdown} />`)}
				<${TurnMetaLine} turnMeta=${msg.turnMeta} />
			</div>
		`;
	}

	if (msg.images?.length) {
		// Array `content` on a role:"user" message is either a real send with
		// an attached photo (a text part is always present, even empty — see
		// bridge.ts's buildUserContent, and toDisplayMessages preserves that
		// as content:"" vs content:null) or a `read` on an image file: wire
		// role is "user" too (only role that can carry image_url content per
		// the OpenAI-compatible API — see loop.ts), but the person didn't
		// send that one, the read tool did. Only the latter case is reached
		// for sessions saved before castToolCallId existed — newer ones show
		// inside their ToolCard instead.
		const isRealSend = msg.content !== null;
		return html`
		<div class="message ${isRealSend ? "message-user" : "message-image-result"}">
		<div class="message-label">${isRealSend ? (msg.pending ? "you · sending…" : "you") : "image (read)"}</div>
			${content && html`<div class="message-content" dangerouslySetInnerHTML=${{ __html: escapeHtml(content) }} />`}
			<div class="message-content message-images">
				${msg.images.map(
					(src, i) => html`<img key=${i} src=${src} class="message-image" onClick=${() => setPreviewSrc(src)} />`,
				)}
			</div>
			${
				previewSrc &&
				html`<${FilePreviewModal}
					path="image.jpg"
					downloadHref=${previewSrc}
					previewHref=${previewSrc}
					onClose=${() => setPreviewSrc(null)}
				/>`
			}
		</div>
	`;
	}

	return html`
	<div class="message message-${role}">
		<div class="message-label">${role === "user" && msg.pending ? "you · sending…" : labelMap[role] ?? role}</div>
		<div class="message-content" dangerouslySetInnerHTML=${{ __html: role === "user" ? escapeHtml(content) : renderMarkdown(content) }} />
		${
			msg.attachments?.length > 0 &&
			html`
			<div class="message-attachments">
				${msg.attachments.map(
					(a) => html`
					<span key=${a.name} class="message-attachment-chip" title=${a.path}>
						<${icons.docFile} /><span class="message-attachment-name">${a.name}</span>
					</span>
				`,
				)}
			</div>
			`
		}
	</div>
`;
}
