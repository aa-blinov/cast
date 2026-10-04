import type {
	CreateMessageRequest,
	CreateMessageResult,
	ElicitRequest,
	ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Message } from "./llm.ts";
import type { ConfirmBash } from "./tools/shared.ts";

/** What a server may ask for during a tool call: a model answer, or a person's input. */
export interface McpInteraction {
	sample: (
		serverName: string,
		params: CreateMessageRequest["params"],
		signal: AbortSignal,
	) => Promise<CreateMessageResult>;
	elicit: (serverName: string, params: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>;
}

/** Shows a server's form to the person and returns what they did. Absent where nobody can be asked. */
export type AskMcpForm = (
	serverName: string,
	params: ElicitRequest["params"],
	signal: AbortSignal,
) => Promise<ElicitResult>;

export interface McpInteractionDeps {
	/** One model call with the conversation the server sent, returning the text and why it stopped. */
	complete: (
		messages: Message[],
		maxTokens: number,
		signal: AbortSignal,
	) => Promise<{ text: string; truncated: boolean }>;
	model: string;
	/** Sampling spends the person's tokens on a server's say-so, so it is asked first. */
	confirm?: ConfirmBash;
	/** A mode that runs everything unasked has already given that answer. */
	bypass: boolean;
	askForm?: AskMcpForm;
}

const PREVIEW_CHARS = 300;

type SamplingContent = CreateMessageRequest["params"]["messages"][number]["content"];

function samplingText(content: SamplingContent): string {
	const blocks = Array.isArray(content) ? content : [content];
	return blocks.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
}

function toChatMessages(params: CreateMessageRequest["params"]): Message[] {
	const out: Message[] = [];
	if (params.systemPrompt) out.push({ role: "system", content: params.systemPrompt });
	for (const message of params.messages) {
		const blocks = Array.isArray(message.content) ? message.content : [message.content];
		const hasImage = blocks.some((b) => b.type === "image");
		if (message.role === "assistant" || !hasImage) {
			out.push({ role: message.role, content: samplingText(message.content) });
			continue;
		}
		out.push({
			role: "user",
			content: blocks.map((b) =>
				b.type === "image"
					? { type: "image_url" as const, image_url: { url: `data:${b.mimeType};base64,${b.data}` } }
					: { type: "text" as const, text: b.type === "text" ? b.text : `[${b.type}]` },
			),
		});
	}
	return out;
}

export function createMcpInteraction(deps: McpInteractionDeps): McpInteraction {
	return {
		async sample(serverName, params, signal) {
			if (!deps.confirm && !deps.bypass) {
				throw new McpError(
					ErrorCode.InvalidRequest,
					"Sampling needs the person's approval, and none can be asked here",
				);
			}
			if (deps.confirm) {
				const last = params.messages.at(-1);
				const preview = last ? samplingText(last.content).replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS) : "";
				const allowed = await deps.confirm(
					`MCP sampling: ${serverName} asks the model: ${preview}`,
					`The MCP server "${serverName}" wants an answer from your model (${params.messages.length} message${params.messages.length === 1 ? "" : "s"}, up to ${params.maxTokens} tokens). It is billed to your provider.`,
					undefined,
					signal,
				);
				if (!allowed) throw new McpError(ErrorCode.InvalidRequest, "The person declined the sampling request");
			}
			const { text, truncated } = await deps.complete(toChatMessages(params), params.maxTokens, signal);
			return {
				role: "assistant",
				model: deps.model,
				content: { type: "text", text },
				stopReason: truncated ? "maxTokens" : "endTurn",
			};
		},
		async elicit(serverName, params, signal) {
			// Nobody to ask is a "no", which a server has to handle anyway, not a failure of the call.
			if (!deps.askForm) return { action: "decline" };
			return await deps.askForm(serverName, params, signal);
		},
	};
}
