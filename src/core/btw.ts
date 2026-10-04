import type { AppConfig } from "./config.ts";
import {
	createClient,
	type Message,
	promptCacheRequestBody,
	resolvePromptCacheStrategy,
	streamAndCollect,
	stripHermesToolCalls,
	type Usage,
} from "./llm.ts";
import { estimateTokens } from "./session.ts";

/**
 * `/btw <question>`: a question asked on the side. It is answered by the model from what the conversation already
 * holds, with no tools, and neither the question nor the answer joins the conversation, so it costs the work in
 * progress nothing but the tokens of the answer. It works while a turn is running.
 */

const SIDE_QUESTION_REMINDER =
	"<system-reminder>\nThis is a side question the user asked with /btw while the work goes on. Answer it from what is already in this conversation, briefly. You have no tools in this reply: do not write a tool call in any form, answer in plain words. Neither the question nor your answer stays in the conversation. If the answer is not in the conversation, say so instead of guessing.\n</system-reminder>";

/** A block of the turn in progress, in the shape both the daemon and the terminal keep it in. */
export interface InFlightBlock {
	kind: string;
	text?: string;
	call?: { name: string; args?: string; status?: string; result?: string };
}

const IN_FLIGHT_MAX_CHARS = 4_000;
const TOOL_ARGS_MAX_CHARS = 200;
const TOOL_RESULT_MAX_CHARS = 300;
const ANSWER_MAX_TOKENS = 4_000;
/** The share of the model's window the question may fill: the answer and the request's own framing need the rest. */
const WINDOW_SHARE = 0.9;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * What the turn in progress has done so far, as text. A turn works on its own copy of the conversation and writes it
 * back at the end, so the saved messages stop where the turn began: without this, "what are you doing right now?" would
 * be answered from before the work started.
 */
export function describeInFlight(blocks: InFlightBlock[] | undefined): string {
	if (!blocks?.length) return "";
	const lines: string[] = [];
	for (const block of blocks) {
		if (block.kind === "content" && block.text?.trim()) lines.push(`The assistant said: ${block.text.trim()}`);
		else if (block.kind === "tool" && block.call) {
			const args = block.call.args ? ` ${clip(block.call.args, TOOL_ARGS_MAX_CHARS)}` : "";
			const state =
				block.call.status === "running" || !block.call.status ? "is running" : `finished (${block.call.status})`;
			const result = block.call.result ? ` Result: ${clip(block.call.result, TOOL_RESULT_MAX_CHARS)}` : "";
			lines.push(`The tool ${block.call.name}${args} ${state}.${result}`);
		}
	}
	if (lines.length === 0) return "";
	const text = lines.join("\n");
	// The end is the part closest to now.
	return text.length > IN_FLIGHT_MAX_CHARS ? `…${text.slice(-IN_FLIGHT_MAX_CHARS)}` : text;
}

/**
 * The conversation as far as it is complete: from the start up to the last message that leaves no tool call without
 * its result. A provider refuses a history that ends in a call nobody answered.
 */
export function completeHistory(messages: Message[]): Message[] {
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "system" || message.role === "developer") continue;
		if (message.role === "assistant" && "tool_calls" in message && message.tool_calls?.length) {
			const wanted = new Set(message.tool_calls.map((c) => c.id));
			let j = i + 1;
			while (j < messages.length && messages[j]!.role === "tool") {
				wanted.delete((messages[j] as { tool_call_id?: string }).tool_call_id ?? "");
				j++;
			}
			if (wanted.size > 0) break;
		}
		out.push(message);
	}
	return out;
}

/** The request for a side question: the conversation, then the question with its framing. */
export function sideQuestionMessages(
	systemPrompt: string,
	history: Message[],
	question: string,
	inFlight = "",
): Message[] {
	const progress = inFlight
		? `\n<system-reminder>\nThe turn in progress, which the history above does not hold yet:\n${inFlight}\n</system-reminder>\n`
		: "";
	return [
		{ role: "system", content: systemPrompt },
		...completeHistory(history),
		{ role: "user", content: `${SIDE_QUESTION_REMINDER}${progress}\n${question}` },
	];
}

export interface SideQuestionInput {
	config: AppConfig;
	model: string;
	systemPrompt: string;
	/** The saved conversation. */
	history: Message[];
	/** What the running turn has done, when one is running (see describeInFlight). */
	inFlight?: string;
	sessionId?: string;
	signal?: AbortSignal;
}

export interface SideAnswer {
	text: string;
	usage?: Usage;
}

export class SideQuestionError extends Error {}

/** Asks the model the question and returns its answer; nothing is written anywhere. */
export async function askSideQuestion(input: SideQuestionInput, question: string): Promise<SideAnswer> {
	const request = sideQuestionMessages(input.systemPrompt, input.history, question, input.inFlight);
	if (estimateTokens(request) > input.config.contextWindow * WINDOW_SHARE) {
		throw new SideQuestionError("The conversation is too long to ask about on the side: run /compact first.");
	}
	const client = createClient(input.config);
	// The same prefix the turns send (system prompt, then history), so a provider that caches prefixes serves it from
	// there.
	const cacheBody = promptCacheRequestBody(resolvePromptCacheStrategy(input.config.baseURL, input.sessionId));
	const ask = async (messages: Message[]) => {
		try {
			return await streamAndCollect(
				client,
				input.model,
				messages,
				[],
				Math.min(input.config.maxResponseTokens, ANSWER_MAX_TOKENS),
				input.signal,
				undefined,
				undefined,
				{},
				undefined,
				cacheBody,
				undefined,
				input.sessionId ? { sessionId: input.sessionId, purpose: "btw" } : undefined,
			);
		} catch (error) {
			if (input.signal?.aborted) throw new SideQuestionError("Stopped.");
			throw new SideQuestionError(error instanceof Error ? error.message : String(error));
		}
	};
	let done = await ask(request);
	// A model with no tools sometimes writes a call out anyway, as markup; that is not an answer. Once more, told so.
	let text = stripHermesToolCalls(done.content).trim();
	if (!text && done.content.trim()) {
		const first = done.usage;
		done = await ask([
			...request,
			{ role: "assistant", content: stripHermesToolCalls(done.content) || "(a tool call)" },
			{
				role: "user",
				content: "There are no tools here. Answer the question in plain words, from the conversation only.",
			},
		]);
		text = stripHermesToolCalls(done.content).trim();
		if (first && done.usage) done = { ...done, usage: addTokens(first, done.usage) };
		if (!text) {
			return {
				text: "(the model tried to call a tool, which this reply does not have; ask something the conversation can answer)",
				usage: done.usage,
			};
		}
	}
	return {
		text: text || "(the model gave no answer: its reply may have gone to reasoning; ask again, shorter)",
		usage: done.usage,
	};
}

/** Two requests of one question, billed as one. */
function addTokens(a: Usage, b: Usage): Usage {
	return {
		...b,
		promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
		completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
		totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
		...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
	};
}
