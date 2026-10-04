import type { StreamingState } from "../server/public/stream-blocks.js";

export interface ToolProgressEvent {
	id: string;
	progress: number;
	total?: number;
	message?: string;
}

const MESSAGE_CHARS = 40;

const count = (n: number): string => String(Math.round(n * 100) / 100);

/** "3/10 step name": how far a long MCP call has got, in plain ASCII for the end of its row. */
export function formatToolProgress(event: Pick<ToolProgressEvent, "progress" | "total" | "message">): string {
	const steps =
		event.total && event.total > 0 ? `${count(event.progress)}/${count(event.total)}` : count(event.progress);
	const message = (event.message ?? "").replace(/\s+/g, " ").trim();
	const shown = message.length > MESSAGE_CHARS ? `${message.slice(0, MESSAGE_CHARS - 3)}...` : message;
	return shown ? `${steps} ${shown}` : steps;
}

/** Sets the progress text on the running tool row the event names; no such row (an old event) leaves the state as it was. */
export function applyToolProgress(state: StreamingState, event: ToolProgressEvent): StreamingState {
	const target = state.blocks.find((b) => b.kind === "tool" && b.call.id === event.id && b.call.status === "running");
	if (!target) return state;
	const toolProgress = formatToolProgress(event);
	return {
		...state,
		blocks: state.blocks.map((b) =>
			b === target && b.kind === "tool" ? { ...b, call: { ...b.call, toolProgress } } : b,
		),
	};
}
