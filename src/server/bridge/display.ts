/**
 * Display-message types and the helpers that fold raw OpenAI wire format
 * (assistant tool_calls + tool result messages, image-bearing user messages,
 * <system-reminder> blocks) into the UI-friendly shape the web client expects.
 *
 * Moved out of server/bridge.ts to keep that file's createServerBridge
 * closure focused on transport and session-state wiring. bridge.ts
 * re-exports the public names (toDisplayMessages, reconcileActiveStream)
 * and imports the types back for the WebAgentSession interface and the
 * shared-view sanitiser, so nothing else in the codebase needs to change.
 */

import type { Message } from "../../core/llm.ts";
import type { TurnMeta } from "../../core/session.ts";
import { extractSystemReminders } from "../../core/system-reminder.ts";
import { type CompletedToolCallStatus, completedToolCallStatus } from "../../core/tools/shared.ts";

export interface DisplayToolCall {
	id: string;
	name: string;
	args: string;
	status: CompletedToolCallStatus;
	result: string;
	/** Set for a `read` on an image file — the photo it returned, so the UI
	 * can show it inside this card instead of as an unexplained separate
	 * message below (see toDisplayMessages' castToolCallId handling). */
	images?: string[];
}

export type DisplayStreamBlock =
	| { order: number; kind: "thinking" | "content"; text: string }
	| {
			order: number;
			kind: "tool";
			call: Omit<DisplayToolCall, "status"> & { status: "running" | CompletedToolCallStatus };
	  };

export function appendActiveText(
	blocks: DisplayStreamBlock[] | undefined,
	kind: "thinking" | "content",
	text: string,
	order: number,
): DisplayStreamBlock[] {
	const current = blocks ?? [];
	for (let i = current.length - 1; i >= 0; i--) {
		const block = current[i];
		if (block.kind === "tool") break;
		if (block.kind === kind) {
			return [...current.slice(0, i), { ...block, text: block.text + text }, ...current.slice(i + 1)];
		}
	}
	return [...current, { order, kind, text }];
}

/** UI-friendly shape — matches what the client already builds live from SSE
 * events (see app.js's "assistant_message" handler), so a history reload
 * (GET /api/sessions/:id) renders identically to a freshly-streamed turn. */
export interface DisplayMessage {
	role: string;
	content: string | null;
	clientMessageId?: string;
	/** Persistent row sequence, used by the web client to retain DOM identity
	 * when an SSE reconnect refreshes the latest history page. */
	seq?: number;
	toolCalls?: DisplayToolCall[];
	thinking?: string;
	turnMeta?: TurnMeta;
	/** data: URLs from a `read` on an image file (see loop.ts's imageDataUrl
	 * handling) — carried on the synthetic `role: "user"` message the loop
	 * pushes after such a tool result, since a plain string `content` can't
	 * hold both text and inline images. */
	images?: string[];
}

export function reconcileActiveStream(
	messages: DisplayMessage[],
	stream: DisplayStreamBlock[] | null | undefined,
): { messages: DisplayMessage[]; streaming: DisplayStreamBlock[] | null } {
	if (!stream || stream.length === 0) return { messages, streaming: null };
	const activeContentBlock = stream.find((block) => block.kind === "content");
	const activeContent = activeContentBlock && "text" in activeContentBlock ? activeContentBlock.text : undefined;
	const activeThinking = stream
		.filter((block) => block.kind === "thinking" && "text" in block)
		.map((block) => ("text" in block ? block.text : ""))
		.join("");
	const activeTools = stream.filter(
		(block): block is Extract<DisplayStreamBlock, { kind: "tool" }> => block.kind === "tool",
	);
	const activeToolIds = new Set(activeTools.map((block) => block.call.id));
	let targetIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (
			message.role === "assistant" &&
			((activeContent !== undefined && message.content === activeContent) ||
				message.toolCalls?.some((call) => activeToolIds.has(call.id)))
		) {
			targetIndex = i;
			break;
		}
	}
	if (targetIndex < 0) return { messages, streaming: stream };
	const nextMessages = messages.slice();
	const target = { ...nextMessages[targetIndex]! };
	if (activeThinking && !target.thinking) target.thinking = activeThinking;
	if (target.content == null && activeContent !== undefined) target.content = activeContent;
	if (target.toolCalls) {
		target.toolCalls = target.toolCalls.map((call) => {
			const activeTool = activeTools.find((block) => block.call.id === call.id);
			return activeTool ? { ...call, result: activeTool.call.result, images: activeTool.call.images } : call;
		});
	}
	nextMessages[targetIndex] = target;
	const remaining = stream.filter((block) => {
		if (block.kind === "thinking") return false;
		if (block.kind === "content") return target.content !== block.text;
		return block.kind !== "tool" || !activeToolIds.has(block.call.id);
	});
	return { messages: nextMessages, streaming: remaining.length > 0 ? remaining : null };
}

/**
 * Session storage keeps the raw OpenAI wire format: assistant messages carry
 * `tool_calls` (snake_case, `{id, function:{name,arguments}}`) with their
 * results as separate trailing `{role:"tool", tool_call_id, content}`
 * messages, and a tool-only turn's `content` is the sentinel `null` (see
 * core/loop.ts) rather than an empty string. Sent as-is, the client would
 * stringify that `null` into the literal text "null" and have no `toolCalls`
 * array to render a card from. This folds each assistant message's tool
 * calls and their matching results together and drops the (i.e. already
 * merged-in) `tool` messages entirely. `reasoning` (SessionState's sidecar
 * map, index -> thinking text — see core/session.ts) reattaches each
 * assistant message's reasoning so a reload looks the same as a live turn.
 * `turnMeta` is the same kind of sidecar map for the "provider – model – Ns"
 * footer under whichever assistant message actually ended a turn.
 */
export function toDisplayMessages(
	messages: Message[],
	reasoning?: Record<number, string>,
	turnMeta?: Record<number, TurnMeta>,
	// Both needed to build an out-of-band image URL (`/api/sessions/:id/image?
	// seq=&idx=`) instead of inlining the data: URL — a handful of read photos
	// otherwise turns every session load into a multi-MB JSON payload. Falls
	// back to inlining when either is missing (e.g. a message not yet
	// persisted, so it has no seq — happens during a live-streaming turn).
	sessionId?: string,
	seqs?: number[],
	imageApiPrefix = "/api",
): DisplayMessage[] {
	// Pre-index tool results by call_id — turns O(N*M) lookups into O(M).
	const toolResults = new Map<string, Message>();
	for (const m of messages) {
		if (m.role === "tool" && "tool_call_id" in m && m.tool_call_id) toolResults.set(m.tool_call_id, m);
	}
	// Same, for a `read`-on-image-file's synthetic image_url message (see
	// loop.ts's castToolCallId) — keyed so the image renders inside the
	// originating ToolCard instead of as an unexplained message below it.
	// Resolved once here (URL vs inline, per this function's own rule) so the
	// second pass below can just look it up.
	const imagesByToolCallId = new Map<string, string[]>();
	messages.forEach((m, i) => {
		if (m.role !== "user" || !Array.isArray(m.content)) return;
		const toolCallId = (m as { castToolCallId?: string }).castToolCallId;
		if (!toolCallId) return;
		const dataUrls = (m.content as Array<{ type?: string; image_url?: { url?: string } }>)
			.filter((p) => p.type === "image_url" && p.image_url?.url)
			.map((p) => p.image_url!.url!);
		if (dataUrls.length === 0) return;
		const seq = seqs?.[i];
		imagesByToolCallId.set(
			toolCallId,
			sessionId && seq !== undefined
				? dataUrls.map((_, idx) => `${imageApiPrefix}/sessions/${sessionId}/image?seq=${seq}&idx=${idx}`)
				: dataUrls,
		);
	});
	const out: DisplayMessage[] = [];
	messages.forEach((m, i) => {
		if (m.role === "tool") return;
		if (m.role === "assistant" && "tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) {
			const toolCalls: DisplayToolCall[] = m.tool_calls
				.filter((tc) => tc.type === "function")
				.map((tc) => {
					const resultMsg = toolResults.get(tc.id);
					const images = imagesByToolCallId.get(tc.id);
					return {
						id: tc.id,
						name: tc.function.name,
						args: tc.function.arguments,
						status: completedToolCallStatus((resultMsg as { castIsError?: boolean } | undefined)?.castIsError),
						result: resultMsg ? String(resultMsg.content ?? "") : "",
						...(images ? { images } : {}),
					};
				});
			out.push({
				role: "assistant",
				content: typeof m.content === "string" ? m.content : null,
				seq: seqs?.[i],
				toolCalls,
				thinking: reasoning?.[i],
				turnMeta: turnMeta?.[i],
			});
			return;
		}
		// Array `content` on a role:"user" message is either a `read`-on-
		// image-file's synthetic relay (no text part — see loop.ts's
		// castToolCallId comment; already attributed to its ToolCard above,
		// skipped here so it doesn't also render as a separate floating
		// message) or a real turn with an attached photo (a text part is
		// always present, even empty — see bridge.ts's buildUserContent).
		// Sessions saved before castToolCallId existed have neither tag, so
		// they still fall through to the inline rendering below.
		if (m.role === "user" && Array.isArray(m.content)) {
			const toolCallId = (m as { castToolCallId?: string }).castToolCallId;
			if (toolCallId && imagesByToolCallId.has(toolCallId)) return;
			const parts = m.content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
			const dataUrls = parts.filter((p) => p.type === "image_url" && p.image_url?.url).map((p) => p.image_url!.url!);
			// Present-but-empty text (a caption-less real send — see buildUserContent,
			// which always includes this part) must stay distinguishable from no
			// text part at all (the tool-only relay) — the client uses exactly this
			// null-vs-string distinction to label the message "you" vs "image (read)".
			const textPartObj = parts.find((p) => p.type === "text");
			let textPart = textPartObj ? (textPartObj.text ?? "") : null;
			if (dataUrls.length > 0) {
				// A message with both images and an attached document (see
				// inputs.ts) carries its <system-reminder> inside this same text
				// part — extract it the same way the plain-string branch below
				// does, so it surfaces as a separate notice instead of leaking
				// raw <system-reminder> tags into the visible bubble.
				if (m.role === "user" && textPart) {
					const extracted = extractSystemReminders(textPart);
					for (const body of extracted.reminders) out.push({ role: "warning", content: `[system] ${body}` });
					textPart = extracted.cleaned || (textPart ? "" : null);
				}
				const seq = seqs?.[i];
				const images =
					sessionId && seq !== undefined
						? dataUrls.map((_, idx) => `${imageApiPrefix}/sessions/${sessionId}/image?seq=${seq}&idx=${idx}`)
						: dataUrls;
				out.push({
					role: m.role,
					content: textPart,
					seq: seqs?.[i],
					images,
					...((m as Message & { castClientMessageId?: string }).castClientMessageId
						? { clientMessageId: (m as Message & { castClientMessageId?: string }).castClientMessageId }
						: {}),
				});
				return;
			}
		}
		// Extract <system-reminder> blocks and render them as warning
		// messages instead of raw XML. These are internal protocol
		// (compaction, date-rollover, interrupt reminders, attached-file
		// notices) injected as role:"user" because the wire format has no
		// dedicated role.
		let content = typeof m.content === "string" ? m.content : null;
		if (m.role === "user" && content) {
			const { cleaned, reminders } = extractSystemReminders(content);
			// Show each reminder as a styled warning message
			for (const body of reminders) {
				if (body) out.push({ role: "warning", content: `[system] ${body}` });
			}
			if (cleaned) {
				content = cleaned;
			} else if (reminders.length > 0) {
				// Entire message was system-reminder — skip the user message
				// but reminders already added above
				return;
			}
		}
		out.push({
			role: m.role,
			content,
			seq: seqs?.[i],
			...((m as Message & { castClientMessageId?: string }).castClientMessageId
				? { clientMessageId: (m as Message & { castClientMessageId?: string }).castClientMessageId }
				: {}),
			thinking: m.role === "assistant" ? reasoning?.[i] : undefined,
			turnMeta: m.role === "assistant" ? turnMeta?.[i] : undefined,
		});
	});
	return out;
}
