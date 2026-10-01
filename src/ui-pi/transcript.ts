import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type OpenFence, trailingOpenFence } from "../ui/markdown-terminal.ts";
import { theme } from "../ui/themes/index.ts";
import type { ChatMessage, RetryInfo, StreamingState } from "../ui/useAgentSession.ts";
import { blockLines, fenceAfter, messageLines } from "./lines.ts";
import { paint } from "./paint.ts";

/** A line of prose stops being readable far short of a wide terminal: past this the text keeps its measure and the rest stays empty. */
export const MAX_MEASURE = 100;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
	private spinner = 0;

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

	/** Advances the activity indicator; true when a row on screen changed. */
	tick(): boolean {
		this.spinner = (this.spinner + 1) % SPINNER_FRAMES.length;
		return this.state.streaming !== null;
	}

	invalidate(): void {
		this.cache = new WeakMap();
	}

	render(width: number): string[] {
		const { messages, streaming, error, retry, showReasoning } = this.state;
		const w = Math.max(20, width);
		const content = Math.min(w, MAX_MEASURE);
		const header = typeof this.header === "function" ? this.header(w) : this.header;
		const out: string[] = header.map((line) => truncateToWidth(line, w, "…"));
		messages.forEach((message, i) => {
			const fence = this.fences[i] ?? null;
			const key = `${content}|${showReasoning}|${fence ? `fence:${fence.language ?? ""}` : ""}`;
			let entry = this.cache.get(message);
			if (!entry || entry.key !== key) {
				entry = { key, lines: messageLines(message, { width: content, showReasoning, openFence: fence }) };
				this.cache.set(message, entry);
			}
			out.push(...entry.lines);
		});
		const colors = theme();
		if (error) out.push("", ...wrapTextWithAnsi(paint(`  ✗ ${error}`, { color: colors.error }), content));
		if (retry) {
			out.push(
				truncateToWidth(
					paint(`    Retrying (attempt ${retry.attempt}): ${retry.reason}`, { color: colors.warning }),
					content,
					"…",
				),
			);
		}
		if (streaming) {
			let fence: OpenFence | null = null;
			let runningTool = false;
			for (const block of streaming.blocks) {
				out.push(...blockLines(block, { width: content, showReasoning, openFence: fence }));
				if (block.kind !== "tool") fence = trailingOpenFence(block.text, fence);
				else if (block.call.status === "running") runningTool = true;
			}
			// Between a finished text block and the next tool call the model may still
			// be deciding; one activity row until something running can speak for itself.
			if (!runningTool) {
				const frame = this.spinner % SPINNER_FRAMES.length;
				out.push(`  ${paint(SPINNER_FRAMES[frame] ?? "", { color: colors.accent })}`);
			}
		}
		return out;
	}
}
