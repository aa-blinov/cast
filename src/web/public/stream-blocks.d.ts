import type { ToolCallStatus } from "../../core/tools/shared.ts";

export interface StreamToolCall {
	id: string;
	name: string;
	args: string;
	status: ToolCallStatus;
	result?: string;
	images?: string[];
}

export type StreamBlock =
	| { kind: "thinking"; text: string; continued?: boolean }
	| { kind: "content"; text: string; continued?: boolean }
	| { kind: "tool"; call: StreamToolCall };

export interface StreamingState {
	blocks: StreamBlock[];
	pendingContentWhitespace?: string;
}

export interface AssistantCompletion {
	thinking?: string;
	content?: string;
	toolCalls?: Array<{ id?: string; name: string; arguments: string }>;
}

export type StreamEvent =
	| { type: "thinking"; text: string }
	| { type: "content"; text: string }
	| { type: "tool_start"; call: StreamToolCall }
	| { type: "tool_end"; id: string; status: ToolCallStatus; result?: string; images?: string[] };

export function appendTextBlock(blocks: StreamBlock[], kind: "thinking" | "content", text: string): StreamBlock[];
export function blocksFromAssistantCompletion(completion: AssistantCompletion): StreamBlock[];
export function reduceStreamEvent(state: StreamingState, event: StreamEvent): StreamingState;
