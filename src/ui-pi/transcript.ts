import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type OpenFence, trailingOpenFence } from "../ui/markdown-terminal.ts";
import { theme } from "../ui/themes/index.ts";
import type { ChatMessage, RetryInfo, StreamingState } from "../ui/useAgentSession.ts";
import { dots } from "./dots.ts";
import { blockLines, fenceAfter, INDENT, messageLines } from "./lines.ts";
import { paint } from "./paint.ts";
import { sanitize } from "./sanitize.ts";

/**
 * How long one frame may spend laying messages out again after the width (or the theme) changed. Laying out a whole
 * long history at once froze the screen for as long as that took (a second at a few hundred messages) on every step
 * of a window resize; past the budget the remaining messages keep the layout they had, and the next frame goes on.
 */
const LAYOUT_BUDGET_MS = 12;

/** The text follows the terminal's width and stops here: a line of prose is hard to read much past it, so on a wider terminal the rest stays empty. */
export const MAX_MEASURE = 120;

/** A message that cannot be laid out shows as one quiet row; it must not take every frame down with it. */
function safeMessageLines(message: ChatMessage, options: Parameters<typeof messageLines>[1]): string[] {
	try {
		return messageLines(message, options);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return [
			"",
			paint(`    [a ${message.role} message could not be shown: ${sanitize(reason)}]`, { color: theme().muted }),
		];
	}
}

export interface TranscriptState {
	messages: ChatMessage[];
	streaming: StreamingState | null;
	error: string | null;
	retry: RetryInfo | null;
	showReasoning: boolean;
}

/**
 * The whole conversation as one document. The scroll view around it owns the
 * viewport, so committed and live rows are not drawn differently: a finished
 * message is cached per (width, reasoning, fence) and only the streaming tail
 * is laid out again on each frame.
 */
export class Transcript implements Component {
	/** Rows above the first message: the banner, and what to do in an empty session. */
	/** Drawn above the conversation; a function when it should fit itself to the width. */
	header: string[] | ((width: number) => string[]) = [];
	private state: TranscriptState = { messages: [], streaming: null, error: null, retry: null, showReasoning: false };
	private fences: Array<OpenFence | null> = [];
	private cache = new WeakMap<ChatMessage, { key: string; lines: string[] }>();
	/** Bumped by `invalidate`: the cached layouts are out of date, but still there to show until they are redone. */
	private generation = 0;
	/** Per-frame layout budget; a test sets it to Infinity to get the finished layout in one render. */
	layoutBudgetMs = LAYOUT_BUDGET_MS;
	/** Called when a frame left messages on their old layout: the owner draws again soon, and the rest is laid out. */
	onStale: (() => void) | undefined;
	private streamCache = new WeakMap<StreamingState["blocks"][number], { key: string; lines: string[] }>();

	set(state: TranscriptState): void {
		if (state.messages !== this.state.messages) {
			const fences: Array<OpenFence | null> = [];
			let fence: OpenFence | null = null;
			for (const message of state.messages) {
				fences.push(fence);
				fence = fenceAfter(message, fence);
			}
			this.fences = fences;
		}
		this.state = state;
	}

	/** Whether the activity indicator (dots that follow the clock) is on screen and wants a redraw. */
	tick(): boolean {
		return this.state.streaming !== null;
	}

	invalidate(): void {
		// Not a fresh cache: the old layouts stay as what a frame shows while the new ones are being made.
		this.generation += 1;
		this.streamCache = new WeakMap();
	}

	render(width: number): string[] {
		const { messages, streaming, error, retry, showReasoning } = this.state;
		const w = Math.max(20, width);
		const content = Math.min(w, MAX_MEASURE);
		const header = typeof this.header === "function" ? this.header(w) : this.header;
		const out: string[] = header.map((line) => truncateToWidth(line, w, "…"));
		// Newest first, so what is on screen (the end of the conversation) is the first to be laid out again. A message
		// that was never laid out has nothing to fall back on and is always done; one that only changed its layout
		// (width, theme) is skipped once the budget is spent and keeps what it had.
		const laid: string[][] = new Array(messages.length);
		const deadline = performance.now() + this.layoutBudgetMs;
		let stale = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			const fence = this.fences[i] ?? null;
			const key = `${this.generation}|${content}|${showReasoning}|${fence ? `fence:${fence.language ?? ""}` : ""}`;
			let entry = this.cache.get(message);
			if (!entry || entry.key !== key) {
				if (entry && performance.now() > deadline) {
					stale = true;
				} else {
					entry = { key, lines: safeMessageLines(message, { width: content, showReasoning, openFence: fence }) };
					this.cache.set(message, entry);
				}
			}
			laid[i] = entry!.lines;
		}
		for (const lines of laid) {
			// Not push(...lines): a message of a few hundred thousand rows would overflow the stack.
			for (const line of lines) out.push(line);
		}
		if (stale) this.onStale?.();
		const colors = theme();
		if (error) out.push("", ...wrapTextWithAnsi(paint(`  ✗ ${sanitize(error)}`, { color: colors.error }), content));
		if (retry) {
			out.push(
				truncateToWidth(
					paint(`    Retrying (attempt ${retry.attempt}): ${sanitize(retry.reason)}`, { color: colors.warning }),
					content,
					"…",
				),
			);
		}
		if (streaming) {
			let fence: OpenFence | null = null;
			let runningTool = false;
			for (const block of streaming.blocks) {
				// A frame with no new token (the dots ticking) lays out nothing again: a block is replaced, not
				// edited, when text arrives, so the same object is the same text.
				const key = `${content}|${showReasoning}|${fence ? `fence:${fence.language ?? ""}` : ""}`;
				let hit = this.streamCache.get(block);
				if (!hit || hit.key !== key) {
					hit = { key, lines: blockLines(block, { width: content, showReasoning, openFence: fence }) };
					this.streamCache.set(block, hit);
				}
				for (const line of hit.lines) out.push(line);
				if (block.kind === "tool") {
					if (block.call.status === "running") runningTool = true;
				} else fence = trailingOpenFence(String(block.text ?? ""), fence);
			}
			// Between a finished text block and the next tool call the model may still
			// be deciding; one activity row until something running can speak for itself.
			if (!runningTool) {
				out.push(`${" ".repeat(INDENT)}${paint(dots().trimEnd(), { color: colors.accent })}`);
			}
		}
		return out;
	}
}
