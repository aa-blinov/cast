import OpenAI, {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIUserAbortError,
	InternalServerError,
	RateLimitError,
} from "openai";
import type { ChatCompletionFunctionTool, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { type AppConfig, providerFetch } from "./config.ts";
import { ThinkBlockParser } from "./vendors.ts";

export type Message = ChatCompletionMessageParam;
/** Cast sends only OpenAI function tools; custom tools have a different wire shape. */
export type Tool = ChatCompletionFunctionTool;

export function createClient(config: AppConfig, override?: { baseURL: string; apiKey: string }): OpenAI {
	// The SDK's bundled node-fetch shim can turn a stream that dies mid-flight
	// into an *uncaught* "Premature close" exception instead of a rejection our
	// retry logic can catch (confirmed by testing against a server that cuts
	// the connection after headers). Node's native fetch doesn't have that
	// failure mode, so use it explicitly rather than relying on the shim.
	return new OpenAI({
		baseURL: override?.baseURL ?? config.baseURL,
		apiKey: override?.apiKey ?? config.apiKey,
		fetch: providerFetch,
		// No SDK-level retries: its internal retry sleeps on a plain
		// setTimeout that the abort signal can't interrupt (openai v7
		// client.mjs retryRequest), so a 429 with a long retry-after would sit
		// uninterruptible before streamChat's own abortable loop ever saw it.
		// streamAndCollect/streamChat own all retrying — abortable, and shared
		// by the main loop, compaction, and hooks.
		maxRetries: 0,
	});
}

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Real cost in USD, when the provider reports one (e.g. OpenRouter) — not universal. */
	cost?: number;
	/** Tokens served from provider's prompt cache (cache hit). */
	cacheReadTokens?: number;
	/** Tokens written to provider's prompt cache (cache miss / new entry). */
	cacheWriteTokens?: number;
	/** Input tokens that were neither cached read nor cached write (full price). */
	uncachedTokens?: number;
}

export interface StreamChunk {
	content?: string;
	thinking?: string;
	/** Native DeepSeek-compatible reasoning trace that must be replayed on a
	 * tool-call assistant message by providers that require native reasoning traces. */
	reasoningContent?: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		arguments: string;
	}>;
	finishReason?: string;
	/** Emitted instead of a real chunk when a transient error is about to be
	 * retried. No attempt cap for genuinely transient errors (rate limits,
	 * 5xx, connection drops) — retries for as long as the error stays
	 * classified retryable rather than giving up after a fixed count. */
	retrying?: { attempt: number; reason: string };
	/** Present on the final chunk when the provider honors `stream_options.include_usage`. */
	usage?: Usage;
}

export type PromptCacheMode = "automatic" | "explicit";

export interface PromptCacheStrategy {
	mode: PromptCacheMode;
	promptCacheKey?: string;
	stickySessionId?: string;
}

/**
 * Select only cache controls documented by the endpoint family. Automatic
 * prefix caches need no wire marker, so unknown gateways receive the exact
 * same request shape they received before this feature.
 */
export function resolvePromptCacheStrategy(baseURL: string, sessionId?: string): PromptCacheStrategy {
	const host = baseURL.toLowerCase();
	const stableSessionId = sessionId?.trim();

	if (host.includes("openrouter")) {
		return {
			mode: "explicit",
			...(stableSessionId ? { stickySessionId: stableSessionId } : {}),
		};
	}

	if (host.includes("api.openai.com")) {
		return {
			mode: "automatic",
			...(stableSessionId ? { promptCacheKey: `cast:${stableSessionId}` } : {}),
		};
	}

	return { mode: "automatic" };
}

/** Build provider-specific top-level fields without mutating reasoning config. */
export function promptCacheRequestBody(strategy: PromptCacheStrategy): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	if (strategy.promptCacheKey) body.prompt_cache_key = strategy.promptCacheKey;
	if (strategy.stickySessionId) body.session_id = strategy.stickySessionId;
	return body;
}

// ============================================================================
// Retry — all retrying lives here, in streamChat's own loop (the client is
// created with maxRetries: 0 so the SDK's uninterruptible internal retry never
// runs — see createClient). What the loop covers: 429/5xx/connection failures
// at the initial-request level (before any bytes are read) AND a stream dying
// mid-flight. We only retry the latter if nothing has been yielded yet in the
// *current* attempt — once real tokens have reached the caller (and likely
// been printed), restarting from scratch would duplicate output, so a later
// failure is surfaced as-is.
// ============================================================================

// No cap on retry *count* for a genuinely transient error (rate limit, 5xx,
// connection drop) — keeps retrying for as long as the error stays
// classified retryable rather than giving up after a fixed number of
// attempts. cast previously hard-stopped at 3 (~3.5s of total backoff) and
// surfaced an error to the user even for sustained rate-limiting a provider
// would clear on its own given more time; the abort signal (checked before
// every retry) is what actually bounds this, same as it already bounds the
// rest of the agent loop.
const RETRY_BASE_DELAY_MS = 500;
// Backoff per attempt still grows (and is still capped) — only the attempt
// *count* is uncapped. Without this ceiling, 2^(attempt-1)*500ms blows past
// any reasonable wait within a dozen attempts.
const RETRY_MAX_DELAY_MS = 30_000;
// A transient provider failure may be retried, but it must not leave a turn
// pending forever. This deadline covers the retry/backoff phase only; a stream
// that is already producing tokens is allowed to finish normally.
const RETRY_DEADLINE_MS = 120_000;

// Quota/billing exhaustion surfaces as the exact same 429 RateLimitError as a
// transient "too many requests" — the SDK doesn't distinguish them by class,
// only by the error body's `code` (OpenAI's `insufficient_quota`) or wording
// (gateways vary). Without this exclusion, retries (now uncapped — see
// RETRY_MAX_DELAY_MS above) would retry indefinitely on something that won't
// resolve until the account's quota/billing changes.
const NON_RETRYABLE_QUOTA_PATTERN = /insufficient_quota|quota exceeded|out of budget|billing/i;

// Context overflow detection.
// Matches every provider's wording when the conversation exceeds the model's
// context window. Used to trigger auto-compaction instead of surfacing a raw
// error to the user.
const CONTEXT_OVERFLOW_PATTERNS: RegExp[] = [
	/prompt is too long/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/context[_ ]length[_ ]exceeded/i,
	/request entity too large/i,
	/context length is only \d+ tokens/i,
	/input length.*exceeds.*context length/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
];
const CONTEXT_OVERFLOW_NO_BODY_PATTERN = /^4(00|13)\s*(status code)?\s*\(no body\)/i;
const RETRYABLE_NETWORK_PATTERN = /terminated|socket hang up|other side closed|fetch failed/i;
const UNAUTHORIZED_MESSAGE_PATTERN = /\b401\b|unauthorized|invalid api key|incorrect api key/i;
const FORBIDDEN_MESSAGE_PATTERN = /\b403\b|forbidden/i;

export function isContextOverflow(error: unknown): boolean {
	const code = (error as { code?: string } | undefined)?.code;
	if (code === "context_length_exceeded") return true;
	const status = (error as { status?: number } | undefined)?.status;
	if (status === 413) return true;
	const message = error instanceof Error ? error.message : String(error);
	if (CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(message))) return true;
	if (CONTEXT_OVERFLOW_NO_BODY_PATTERN.test(message)) return true;
	return false;
}

/**
 * Also used outside this module (see index.ts) to recognize this same class
 * of error when it escapes as an uncaught exception instead of a rejection —
 * confirmed by testing that a connection dying mid-stream *after* some
 * content already arrived can throw from deep inside undici with no pending
 * read to reject, bypassing this file's own try/catch entirely.
 */
export function isRetryableStreamError(error: unknown): boolean {
	if (error instanceof APIUserAbortError) return false;

	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "insufficient_quota" || NON_RETRYABLE_QUOTA_PATTERN.test(message)) return false;

	if (
		error instanceof RateLimitError ||
		error instanceof InternalServerError ||
		error instanceof APIConnectionTimeoutError ||
		error instanceof APIConnectionError
	) {
		return true;
	}

	if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE" || code === "UND_ERR_SOCKET") return true;

	return RETRYABLE_NETWORK_PATTERN.test(message);
}

/**
 * How long to wait before the next retry. Provider-supplied `retry-after-ms`
 * / `retry-after` response headers win when present (a 429 telling you
 * exactly when its window resets is more accurate than guessing). Otherwise
 * capped exponential backoff.
 */
export function retryDelayMs(attempt: number, error: unknown): number {
	const headers = (error as { headers?: Headers } | undefined)?.headers;
	if (headers && typeof headers.get === "function") {
		const ms = headers.get("retry-after-ms");
		if (ms) {
			const parsed = Number.parseFloat(ms);
			if (!Number.isNaN(parsed)) return Math.min(parsed, RETRY_MAX_DELAY_MS);
		}
		const seconds = headers.get("retry-after");
		if (seconds) {
			const parsedSeconds = Number.parseFloat(seconds);
			if (!Number.isNaN(parsedSeconds)) return Math.min(Math.ceil(parsedSeconds * 1000), RETRY_MAX_DELAY_MS);
			// HTTP-date form, e.g. "Wed, 21 Oct 2026 07:28:00 GMT".
			const parsedDate = Date.parse(seconds) - Date.now();
			if (!Number.isNaN(parsedDate) && parsedDate > 0) return Math.min(parsedDate, RETRY_MAX_DELAY_MS);
		}
	}
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/**
 * Turn a raw turn-failure error into something a user can act on. The SDK
 * surfaces auth/quota failures as terse strings — often just "401 status code
 * (no body)" for gateways that send no body — which don't tell the user their
 * key was rejected or what to do next. Map the actionable cases (revoked/invalid
 * key, no permission, exhausted quota) explicitly and point at the command that
 * fixes each; anything unrecognized falls through to the original message so no
 * information is lost. Classify by status/code first (reliable when present),
 * then by wording (the fallback for wrapped or body-less gateway errors).
 */
export function describeTurnError(error: unknown): string {
	const status = (error as { status?: number } | undefined)?.status;
	const code = (error as { code?: string } | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);

	// Quota/billing exhaustion — the key is valid, the account is out of credit.
	// Checked before the status codes because it rides in on a 429 that would
	// otherwise read as a transient rate limit.
	if (code === "insufficient_quota" || NON_RETRYABLE_QUOTA_PATTERN.test(message)) {
		return "Provider quota/billing exhausted — the API key is valid but out of credit. Check your provider account.";
	}

	// 401 — key rejected: revoked, expired, or wrong.
	if (status === 401 || UNAUTHORIZED_MESSAGE_PATTERN.test(message)) {
		return "API key rejected (401) — it may be revoked, expired, or incorrect. Run /provider to update it.";
	}

	// 403 — authenticated but not permitted for this model/endpoint.
	if (status === 403 || FORBIDDEN_MESSAGE_PATTERN.test(message)) {
		return "Access denied (403) — the API key lacks permission for this model or endpoint. Try /provider or pick another model with /model.";
	}

	return message;
}

/**
 * Sleep that resolves early on abort — the retry backoff must not leave a turn
 * uninterruptible for up to RETRY_MAX_DELAY_MS (30s). Without this, Esc during
 * a backoff does nothing visible until the timer fires, then the next request
 * fails on the already-aborted signal; the user perceives "Esc didn't abort".
 * Rejects with the abort reason so the retry loop's catch rethrows it.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(reasonOf(signal));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(reasonOf(signal!));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function reasonOf(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error(typeof reason === "string" ? reason : "Aborted");
}

/** Placeholder for an assistant turn that produced neither text nor tool calls. */
export const EMPTY_ASSISTANT_PLACEHOLDER = "(no response)";

/**
 * Guard against malformed assistant messages reaching the provider.
 *
 * 1. A turn that streamed only reasoning or ended on error/abort before any
 *    output leaves `content: null` and no `tool_calls`. Many providers reject
 *    that shape outright — substituting a non-empty placeholder keeps the
 *    message list valid without dropping history.
 *
 * 2. Tool call arguments that are truncated (streaming cut off mid-generation)
 *    produce invalid JSON in `tc.function.arguments`. The provider accepts the
 *    raw string, but re-sending it wastes tokens on a doomed retry and the
 *    subsequent tool result already carries the error. Replace truncated args
 *    with a minimal valid JSON error so the request stays well-formed.
 */
function sanitizeMessages(messages: Message[]): Message[] {
	return messages.map((m) => {
		// Drop cast-only UI metadata before it reaches the provider.
		if (m.role === "tool" && m && typeof m === "object" && "castIsError" in m) {
			const tool = m as { role: "tool"; tool_call_id: string; content: string; castIsError?: boolean };
			return { role: "tool", tool_call_id: tool.tool_call_id, content: tool.content };
		}
		// Same for the `castToolCallId` tag on a `read`-on-image-file's
		// synthetic image_url message (see loop.ts) — UI-only, lets the client
		// attribute the image back to its tool card instead of a provider
		// receiving a field it never asked for.
		if (m.role === "user" && m && typeof m === "object" && "castToolCallId" in m) {
			const withTag = m as { role: "user"; content: unknown; castToolCallId?: string };
			return { role: "user", content: withTag.content } as Message;
		}
		// Client message IDs are persisted for idempotent daemon retries, but are
		// transport metadata rather than model context.
		if (m.role === "user" && m && typeof m === "object" && "castClientMessageId" in m) {
			const withId = m as { role: "user"; content: unknown; castClientMessageId?: string };
			return { role: "user", content: withId.content } as Message;
		}
		if (m.role !== "assistant") return m;
		const hasToolCalls = "tool_calls" in m && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
		const hasContent = typeof m.content === "string" ? m.content.length > 0 : Boolean(m.content);

		// Fix malformed tool call arguments in-place
		if (hasToolCalls) {
			for (const tc of m.tool_calls!) {
				if (tc.type !== "function") continue;
				try {
					const parsed: unknown = JSON.parse(tc.function.arguments);
					// Valid JSON but not an object (e.g. a bare array the model
					// emitted for an array-typed parameter): some providers'
					// chat templates iterate arguments as a mapping and 400 the
					// whole request ("Can only get item pairs from a mapping").
					// Wrap so the history stays replayable everywhere.
					if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
						tc.function.arguments = JSON.stringify({ value: parsed });
					}
				} catch {
					tc.function.arguments = '{"error": "arguments were truncated"}';
				}
			}
		}

		if (hasToolCalls || hasContent) return m;
		return { ...m, content: EMPTY_ASSISTANT_PLACEHOLDER };
	});
}

/**
 * Stream chat completions with vendor-agnostic thinking support.
 */
export async function* streamChat(
	client: OpenAI,
	model: string,
	messages: Message[],
	tools: Tool[],
	maxTokens: number,
	signal?: AbortSignal,
	reasoningBody: Record<string, unknown> = {},
	promptCacheBody: Record<string, unknown> = {},
): AsyncGenerator<StreamChunk> {
	const params: OpenAI.ChatCompletionCreateParamsStreaming = {
		model,
		messages: sanitizeMessages(messages),
		tools: tools.length > 0 ? tools : undefined,
		max_tokens: maxTokens,
		stream: true,
		// Standard OpenAI-compatible field for getting token counts on a
		// streaming response (delivered on a final chunk with empty choices).
		// Providers that don't understand it just ignore the extra key.
		stream_options: { include_usage: true },
	};

	// Merge vendor-specific reasoning parameters
	if (Object.keys(reasoningBody).length > 0) {
		Object.assign(params, reasoningBody);
	}
	if (Object.keys(promptCacheBody).length > 0) {
		Object.assign(params, promptCacheBody);
	}

	let attempt = 0;
	let yieldedAny = false;
	let retryStartedAt: number | undefined;

	// Stream reads are inherently sequential — the next chunk depends on server push.
	while (true) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: streaming requires sequential read
			const stream = await client.chat.completions.create(params, { signal });

			const toolCallAccumulator = new Map<number, { id: string; name: string; arguments: string }>();
			const thinkParser = new ThinkBlockParser();
			// MiniMax's `reasoning_details` stream is cumulative rather than a
			// token delta. Keep its previous full value so callers receive only
			// the suffix once, like every other reasoning transport.
			let previousReasoningDetails = "";

			for await (const chunk of stream) {
				const result: StreamChunk = {};

				// Usage arrives on its own trailing chunk with empty `choices` for
				// some providers, and alongside the final content delta for others —
				// check it before the no-delta early exit below so neither shape is missed.
				if (chunk.usage) {
					const usageAny = chunk.usage as unknown as Record<string, unknown>;
					const promptTokensDetails = usageAny.prompt_tokens_details as
						| { cached_tokens?: number; cache_write_tokens?: number }
						| undefined;
					// Universal cache token extraction — covers:
					//   1. OpenAI/vLLM:       prompt_tokens_details.cached_tokens
					//   2. OpenRouter/Anthropic: prompt_cache_hit_tokens
					//   3. Native Anthropic:  cache_read_input_tokens / cache_creation_input_tokens
					const cacheReadTokens =
						promptTokensDetails?.cached_tokens ??
						(typeof usageAny.prompt_cache_hit_tokens === "number"
							? usageAny.prompt_cache_hit_tokens
							: undefined) ??
						(typeof usageAny.cache_read_input_tokens === "number" ? usageAny.cache_read_input_tokens : undefined);
					const cacheWriteTokens =
						promptTokensDetails?.cache_write_tokens ??
						(typeof usageAny.cache_creation_input_tokens === "number"
							? usageAny.cache_creation_input_tokens
							: undefined);
					result.usage = {
						promptTokens: chunk.usage.prompt_tokens,
						completionTokens: chunk.usage.completion_tokens,
						// Recomputed rather than trusting the raw total_tokens field —
						// pi's own openai-completions.ts does the same (its `totalTokens:
						// input + outputTokens + cacheReadTokens + cacheWriteTokens`
						// simplifies to exactly promptTokens + completionTokens, since
						// `input` there is promptTokens minus both cache fields). Some
						// OpenAI-compatible gateways report a total_tokens that doesn't
						// actually match prompt+completion; recomputing avoids surfacing
						// a "Total" that visibly disagrees with the two numbers next to it.
						totalTokens: chunk.usage.prompt_tokens + chunk.usage.completion_tokens,
						cost: typeof usageAny.cost === "number" ? usageAny.cost : undefined,
						cacheReadTokens: cacheReadTokens ?? undefined,
						cacheWriteTokens: cacheWriteTokens ?? undefined,
						uncachedTokens: Math.max(
							0,
							chunk.usage.prompt_tokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0),
						),
					};
				}

				const delta = chunk.choices[0]?.delta;
				if (!delta) {
					if (result.usage) {
						yieldedAny = true;
						yield result;
					}
					continue;
				}

				// 1. Reasoning in delta fields. OpenRouter streams it as
				//    `delta.reasoning`; DeepSeek/Qwen/GLM and most other
				//    OpenAI-compatible reasoners use `delta.reasoning_content` (the
				//    de-facto standard R1 popularized) — without this branch their
				//    thinking is silently dropped, since /v1/models exposes no
				//    reasoning metadata to even flag them as reasoning models.
				const deltaAny = delta as Record<string, unknown>;
				if (typeof deltaAny.reasoning === "string" && deltaAny.reasoning) {
					result.thinking = deltaAny.reasoning;
				} else if (typeof deltaAny.reasoning_content === "string" && deltaAny.reasoning_content) {
					result.thinking = deltaAny.reasoning_content;
					result.reasoningContent = deltaAny.reasoning_content;
				} else if (Array.isArray(deltaAny.reasoning_details)) {
					const fullReasoning = deltaAny.reasoning_details
						.flatMap((detail): string[] => {
							if (!detail || typeof detail !== "object") return [];
							const text = (detail as Record<string, unknown>).text;
							return typeof text === "string" ? [text] : [];
						})
						.join("");
					if (fullReasoning) {
						const next = fullReasoning.startsWith(previousReasoningDetails)
							? fullReasoning.slice(previousReasoningDetails.length)
							: fullReasoning;
						previousReasoningDetails = fullReasoning;
						if (next) {
							result.thinking = next;
							result.reasoningContent = next;
						}
					}
				}

				// 2. Parse content for <think>...</think> blocks (Qwen/DeepSeek raw).
				//    The parser still tracks state (open/close tags) so it can strip
				//    them from content, but only contributes thinking when no native
				//    reasoning field is present — otherwise the same text arrives twice.
				if (delta.content) {
					const parsed = thinkParser.parseContent(delta.content);
					if (parsed.thinking && !result.thinking) result.thinking = parsed.thinking;
					if (parsed.content) result.content = parsed.content;
				}

				// Tool calls
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index;
						if (!toolCallAccumulator.has(idx)) {
							toolCallAccumulator.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" });
						}
						const acc = toolCallAccumulator.get(idx)!;
						if (tc.id) acc.id = tc.id;
						if (tc.function?.name) acc.name = tc.function.name;
						if (tc.function?.arguments) acc.arguments += tc.function.arguments;
					}
				}

				const finishReason = chunk.choices[0]?.finish_reason;
				if (finishReason) {
					result.finishReason = finishReason;
					if (toolCallAccumulator.size > 0) {
						result.toolCalls = [...toolCallAccumulator.values()];
					}
				}

				yieldedAny = true;
				yield result;
			}

			// Flush whatever the tag-boundary holdback buffer was still sitting
			// on — the stream ended, so it was never a split tag after all;
			// deliver it as whichever kind was open instead of dropping it.
			const remaining = thinkParser.flush();
			if (remaining.thinking || remaining.content) {
				yieldedAny = true;
				yield { thinking: remaining.thinking, content: remaining.content };
			}
			return;
		} catch (error) {
			if (yieldedAny || signal?.aborted || !isRetryableStreamError(error)) {
				throw error;
			}
			retryStartedAt ??= Date.now();
			attempt++;
			if (Date.now() - retryStartedAt >= RETRY_DEADLINE_MS) {
				throw new Error(`Provider retry deadline exceeded (${RETRY_DEADLINE_MS / 1000}s)`);
			}
			const reason = error instanceof Error ? error.message : String(error);
			yield { retrying: { attempt, reason } };
			const remaining = RETRY_DEADLINE_MS - (Date.now() - retryStartedAt);
			// Abortable: Esc during a backoff must cancel the retry immediately,
			// not wait out the timer (up to 30s) and fail on the next request.
			await abortableSleep(Math.min(retryDelayMs(attempt, error), Math.max(0, remaining)), signal);
		}
	}
}

export interface CompletionResult {
	content: string;
	thinking: string;
	reasoningContent: string;
	toolCalls?: Array<{ id: string; name: string; arguments: string }>;
	finishReason: string;
	usage?: Usage;
	/**
	 * Wall-clock time from the first streamed chunk to the last, in ms —
	 * undefined if nothing ever streamed (e.g. the request failed before any
	 * chunk arrived). Deliberately excludes time-to-first-token/prefill
	 * latency: tokens / (tsLastByte - tsFirstByte) measures decoding
	 * throughput, not request latency.
	 */
	generationMs?: number;
	/**
	 * True when the stream ended on an abort *before* a natural finish_reason
	 * arrived — i.e. genuinely cut short. False for a turn that completed and
	 * only then caught a late abort signal, so the loop commits it normally
	 * instead of labeling a finished answer "Aborted".
	 */
	interrupted?: boolean;
	/**
	 * True when the stream ended mid-response with neither a finish_reason nor a
	 * usage summary and no user abort — a silent provider drop/truncation that
	 * would otherwise look like a clean completion. Lets the UI flag it
	 * ("[disconnected]") so a cut-off answer isn't mistaken for a normal exit.
	 */
	disconnected?: boolean;
}

/** Coerce a Hermes-XML parameter value (always captured as text) to a JSON
 * scalar: Python-ish None → null, booleans, integers, and floats; everything
 * else stays a string (so "in_progress", ISO dates, free text pass through). */
const INTEGER_LITERAL_PATTERN = /^-?\d+$/;
const DECIMAL_LITERAL_PATTERN = /^-?\d*\.\d+$/;

function coerceHermesValue(raw: string): unknown {
	const v = raw.trim();
	if (v === "None" || v === "null") return null;
	if (v === "true") return true;
	if (v === "false") return false;
	if (INTEGER_LITERAL_PATTERN.test(v)) return Number(v);
	if (DECIMAL_LITERAL_PATTERN.test(v)) return Number(v);
	return v;
}

/**
 * Recover tool calls a model emitted as Hermes-style XML in its text content —
 * `<function=NAME><parameter=KEY>VALUE</parameter>…</function>`, optionally
 * wrapped in `<tool_call>`. Some providers produce calls this
 * way and the provider's OpenAI-compat layer then returns truncated/invalid
 * JSON in tool_calls.arguments; cast would reject that and the model would retry
 * the same broken shape indefinitely. Returns [] when there is no such block.
 *
 * `validNames`, when given, restricts recovery to calls whose NAME is a real
 * available tool. This is what keeps ordinary prose that merely *mentions*
 * `<function=…>` (e.g. an assistant explaining this very feature, or a changelog
 * entry) from being misread as a live tool call — a false positive that
 * produces a bogus tool call the provider then rejects with `400 Param
 * Incorrect` on the next request.
 */
export function parseHermesToolCalls(
	content: string,
	validNames?: Set<string>,
): Array<{ id: string; name: string; arguments: string }> {
	const calls: Array<{ id: string; name: string; arguments: string }> = [];
	let i = 0;
	for (const m of content.matchAll(/<function=([^>\s]+)\s*>([\s\S]*?)<\/function>/g)) {
		const name = m[1]!;
		if (validNames && !validNames.has(name)) continue;
		const params: Record<string, unknown> = {};
		for (const pm of m[2]!.matchAll(/<parameter=([^>\s]+)\s*>([\s\S]*?)<\/parameter>/g)) {
			params[pm[1]!] = coerceHermesValue(pm[2]!);
		}
		calls.push({ id: `hermes_${i++}`, name, arguments: JSON.stringify(params) });
	}
	return calls;
}

/** Strip recovered Hermes XML tool-call blocks (and their `<tool_call>` wrapper)
 * from content so they aren't shown to the user as literal markup. */
export function stripHermesToolCalls(content: string): string {
	return content
		.replace(/<function=[^>\s]+\s*>[\s\S]*?<\/function>/g, "")
		.replace(/<\/?tool_call>/g, "")
		.trim();
}

/** True when a tool_calls[].arguments string is a usable JSON object. Empty,
 * truncated (`{"x":`), or non-object payloads are not. */
function isValidJsonObject(s: string): boolean {
	try {
		const v = JSON.parse(s);
		return typeof v === "object" && v !== null;
	} catch {
		return false;
	}
}

export async function streamAndCollect(
	client: OpenAI,
	model: string,
	messages: Message[],
	tools: Tool[],
	maxTokens: number,
	signal?: AbortSignal,
	onToken?: (token: string) => void,
	onThinking?: (token: string) => void,
	reasoningBody: Record<string, unknown> = {},
	onRetry?: (attempt: number, reason: string) => void,
	promptCacheBody: Record<string, unknown> = {},
): Promise<CompletionResult> {
	let content = "";
	let thinking = "";
	let reasoningContent = "";
	let toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined;
	let finishReason = "stop";
	let usage: Usage | undefined;
	let firstChunkAt: number | undefined;
	// Whether the provider actually sent a terminal finish_reason. A mid-stream
	// abort can end the async iterator cleanly with none — distinguishing "cut
	// short" from "finished, then the user hit Esc a beat late" so the latter
	// isn't mislabeled aborted.
	let sawFinish = false;

	for await (const chunk of streamChat(
		client,
		model,
		messages,
		tools,
		maxTokens,
		signal,
		reasoningBody,
		promptCacheBody,
	)) {
		if (chunk.retrying) {
			onRetry?.(chunk.retrying.attempt, chunk.retrying.reason);
			continue;
		}
		firstChunkAt ??= Date.now();

		if (chunk.usage) usage = chunk.usage;
		// Thinking before content so a single chunk that closes the <think> tag and
		// immediately starts the answer (common for Qwen/DeepSeek/MiniMax-M3) creates
		// the thinking block first and appends content after it — the other order
		// puts the content block first and the thinking block behind it.
		if (chunk.thinking) {
			thinking += chunk.thinking;
			onThinking?.(chunk.thinking);
		}
		if (chunk.reasoningContent) reasoningContent += chunk.reasoningContent;
		if (chunk.content) {
			content += chunk.content;
			onToken?.(chunk.content);
		}
		if (chunk.toolCalls) toolCalls = chunk.toolCalls;
		if (chunk.finishReason) {
			finishReason = chunk.finishReason;
			sawFinish = true;
		}
	}
	// Capture wall-clock end after the stream is fully consumed (tsLastByte
	// on done) rather than on the last chunk.
	const lastChunkAt = firstChunkAt !== undefined ? Date.now() : undefined;

	const generationMs =
		firstChunkAt !== undefined && lastChunkAt !== undefined ? lastChunkAt - firstChunkAt : undefined;
	// Interrupted only when the signal is set AND the stream never reached a
	// natural end — a turn that finished right before the abort landed is a
	// completed turn, not an aborted one.
	const interrupted = Boolean(signal?.aborted && !sawFinish);
	// Disconnected: content started streaming but the stream ended with neither a
	// finish_reason nor a usage summary, and the user didn't abort — the provider
	// dropped/truncated it. Requiring "no usage" as well as "no finish_reason"
	// avoids false-flagging providers that omit finish_reason but still send a
	// terminal usage chunk (include_usage) on a genuinely complete turn.
	const disconnected = Boolean(!sawFinish && !signal?.aborted && firstChunkAt !== undefined && usage === undefined);

	// Hermes-XML tool-call recovery. When the structured tool_calls are missing
	// or carry malformed JSON (truncated `arguments`), but the content holds an
	// XML call NAMING A REAL TOOL, parse it into a proper tool call and drop the
	// markup from the visible content. Without this, providers that mis-serialize
	// such calls can trap the model in a retry loop on "arguments were
	// malformed". Gating on the real tool names is what stops prose that merely
	// mentions `<function=…>` (e.g. the assistant describing this feature) from
	// being turned into a bogus tool call the provider then 400s on.
	const validToolNames = new Set(
		tools.map((t) => (t.type === "function" ? t.function.name : undefined)).filter((n): n is string => Boolean(n)),
	);
	const malformed = !toolCalls?.length || toolCalls.some((tc) => !isValidJsonObject(tc.arguments));
	let recoveredHermes = false;
	if (malformed && content.includes("<function=")) {
		const recovered = parseHermesToolCalls(content, validToolNames);
		if (recovered.length > 0) {
			toolCalls = recovered;
			finishReason = "tool_calls";
			content = stripHermesToolCalls(content);
			recoveredHermes = true;
		}
	}

	// When valid structured tool_calls are present but content also contains the
	// duplicate Hermes XML markup (some providers emit both), strip
	// the XML so it doesn't leak into the transcript. Only strip real tool-call
	// blocks — a `<function=NAME>` naming an actual tool — so prose that mentions
	// the tag survives untouched. Skip when we already stripped during recovery.
	if (!recoveredHermes && toolCalls?.length && content.includes("<function=")) {
		const embedded = parseHermesToolCalls(content, validToolNames);
		if (embedded.length > 0) {
			content = stripHermesToolCalls(content);
		}
	}

	return {
		content,
		thinking,
		reasoningContent,
		toolCalls,
		finishReason,
		usage,
		generationMs,
		interrupted,
		disconnected,
	};
}

// ============================================================================
// Prompt caching — explicit cache_control markers are reserved for the
// OpenRouter/Anthropic-compatible path. Providers such as MiniMax and OpenAI
// use automatic prefix matching, so their request shape must stay native.
//
// Three breakpoints, matching pi's openai-completions.ts strategy:
//   1. System prompt — caches persona + instructions + context files
//   2. Last tool definition — caches the full tool definitions array
//   3. Last user/assistant message — caches conversation prefix up to the
//      growing tail, so each new turn only pays for the delta
// ============================================================================

interface CacheControlEphemeral {
	type: "ephemeral";
}

type ContentPartWithCacheControl = {
	type: "text";
	text: string;
	cache_control?: CacheControlEphemeral;
};

type ToolWithCacheControl = ChatCompletionFunctionTool & {
	cache_control?: CacheControlEphemeral;
};

const CACHE_CONTROL: CacheControlEphemeral = { type: "ephemeral" };

/**
 * Return a copy of `message` with a cache_control marker on its (last) text
 * content part, or null when there is nothing to mark. Never mutates the
 * input: the caller's messages are the same objects saveSession persists,
 * and writing the request-only structured-content shape into the session
 * file bricks it on providers whose chat template expects plain strings.
 */
function withCacheControlOnText(
	message: Extract<ChatCompletionMessageParam, { role: "system" | "user" | "assistant" | "developer" }>,
): ChatCompletionMessageParam | null {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) return null;
		return {
			...message,
			content: [{ type: "text", text: content, cache_control: CACHE_CONTROL }] as ContentPartWithCacheControl[],
		} as ChatCompletionMessageParam;
	}
	if (Array.isArray(content)) {
		for (let i = content.length - 1; i >= 0; i--) {
			const part = content[i];
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				(part as unknown as Record<string, unknown>).type === "text"
			) {
				const parts = content.slice();
				parts[i] = { ...(part as object), cache_control: CACHE_CONTROL } as ContentPartWithCacheControl;
				return { ...message, content: parts } as ChatCompletionMessageParam;
			}
		}
	}
	return null;
}

/**
 * Apply explicit cache_control markers to messages and tools when the selected
 * provider supports them, returning request-ready copies. Automatic-prefix
 * providers get the original plain-message shape. Call right before sending
 * each LLM request; inputs stay untouched so session state never absorbs the
 * provider-specific structured-content shape.
 */
export function applyCacheControl(
	messages: Message[],
	tools: Tool[],
	cacheMessageIndex?: number,
	mode: PromptCacheMode = "explicit",
): { messages: Message[]; tools: Tool[] } {
	const outMessages = messages.slice();
	if (mode !== "explicit") return { messages: outMessages, tools };

	// 1. System prompt — first system/developer message
	for (let i = 0; i < outMessages.length; i++) {
		const message = outMessages[i]!;
		if (message.role === "system" || message.role === "developer") {
			const marked = withCacheControlOnText(message);
			if (marked) outMessages[i] = marked as Message;
			break;
		}
	}

	// 2. Last tool definition
	let outTools = tools;
	if (tools.length > 0) {
		outTools = tools.slice();
		outTools[outTools.length - 1] = {
			...tools[tools.length - 1]!,
			cache_control: CACHE_CONTROL,
		} as ToolWithCacheControl;
	}

	// 3. The fork boundary, when supplied, otherwise the last user or assistant
	// message. Marking the boundary lets a maintenance fork reuse the immutable
	// parent prefix while its maintenance instruction remains uncached tail.
	const start =
		cacheMessageIndex === undefined ? outMessages.length - 1 : Math.min(cacheMessageIndex, outMessages.length - 1);
	for (let i = start; i >= 0; i--) {
		const message = outMessages[i]!;
		if (message.role === "user" || message.role === "assistant") {
			const marked = withCacheControlOnText(message);
			if (marked) {
				outMessages[i] = marked as Message;
				break;
			}
		}
	}

	return { messages: outMessages, tools: outTools };
}
