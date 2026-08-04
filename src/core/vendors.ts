/**
 * Reasoning configuration — derived directly from OpenRouter /v1/models metadata.
 *
 * Each model from OpenRouter includes a `reasoning` field:
 * {
 *   "mandatory": false,
 *   "default_enabled": true,
 *   "supported_efforts": ["high", "medium", "low"],
 *   "default_effort": "medium"
 * }
 *
 * No vendor detection, no overrides, no cache — the API tells us everything.
 */

// ============================================================================
// Model reasoning metadata (from OpenRouter /v1/models)
// ============================================================================

const LEADING_NL_RE = /^\n+/;

export interface ModelReasoningMeta {
	mandatory: boolean;
	defaultEnabled: boolean;
	supportedEfforts: string[];
	defaultEffort: string;
}

/** Request dialect for reasoning controls on OpenAI-compatible APIs.
 * `auto` follows the common OpenAI `reasoning_effort` convention and recognizes
 * the few endpoints whose public compatibility contract differs. */
export type ReasoningFormat =
	| "auto"
	| "generic"
	| "openai"
	| "openrouter"
	| "deepseek"
	| "kimi"
	| "qianfan"
	| "qwen"
	| "together"
	| "xai"
	| "zai"
	| "huawei"
	| "minimax";

export const REASONING_FORMAT_OPTIONS: Array<{ value: ReasoningFormat; label: string }> = [
	{ value: "auto", label: "Auto (OpenAI-compatible; detects known endpoints)" },
	{ value: "generic", label: "Generic OpenAI-compatible (omit controls when off)" },
	{ value: "openai", label: "OpenAI (reasoning_effort)" },
	{ value: "openrouter", label: "OpenRouter (reasoning.effort)" },
	{ value: "deepseek", label: "DeepSeek / Xiaomi MiMo (thinking.type)" },
	{ value: "kimi", label: "Kimi / Moonshot (thinking.type, preserved thinking)" },
	{ value: "qianfan", label: "Baidu Qianfan / ERNIE (enable_thinking)" },
	{ value: "qwen", label: "Qwen / DashScope (enable_thinking)" },
	{ value: "together", label: "Together (reasoning.enabled)" },
	{ value: "xai", label: "xAI / Grok (reasoning_effort)" },
	{ value: "zai", label: "Z.ai / GLM (thinking.type)" },
	{ value: "huawei", label: "Huawei ModelArts (chat_template_kwargs.enable_thinking)" },
	{ value: "minimax", label: "MiniMax (always-on reasoning)" },
];

export function resolveReasoningFormat(
	baseURL: string,
	configured: ReasoningFormat = "auto",
): Exclude<ReasoningFormat, "auto"> {
	if (configured !== "auto") return configured;
	const host = baseURL.toLowerCase();
	if (host.includes("openrouter")) return "openrouter";
	if (host.includes("xiaomimimo")) return "deepseek";
	if (host.includes("minimax")) return "minimax";
	if (host.includes("moonshot") || host.includes("kimi.com")) return "kimi";
	if (host.includes("deepseek")) return "deepseek";
	if (host.includes("qianfan") || host.includes("baidubce") || host.includes("baidu")) return "qianfan";
	if (host.includes("dashscope") || host.includes("alibaba")) return "qwen";
	if (host.includes("together")) return "together";
	if (host.includes("x.ai")) return "xai";
	if (host.includes("z.ai") || host.includes("bigmodel")) return "zai";
	if (host.includes("volces") || host.includes("volcengine")) return "deepseek";
	if (host.includes("huaweicloud")) return "huawei";
	return "generic";
}

/**
 * Extract reasoning metadata from OpenRouter model object.
 * Returns null if model doesn't support reasoning.
 */
export function extractReasoningMeta(model: Record<string, unknown>): ModelReasoningMeta | null {
	const r = model.reasoning as Record<string, unknown> | undefined;
	if (!r) return null;

	return {
		mandatory: r.mandatory === true,
		defaultEnabled: r.default_enabled === true,
		supportedEfforts: Array.isArray(r.supported_efforts) ? (r.supported_efforts as string[]) : [],
		defaultEffort: typeof r.default_effort === "string" ? r.default_effort : "medium",
	};
}

// ============================================================================
// Build request parameters
// ============================================================================

export interface ReasoningParams {
	body: Record<string, unknown>;
	enabled: boolean;
}

export function buildReasoningParams(effort: string, format: ReasoningFormat = "auto"): ReasoningParams {
	if (effort === "unknown") return { body: {}, enabled: false };
	const enabled = effort !== "off";
	const normalized = effort === "off" || effort === "on" ? undefined : effort;
	switch (format) {
		case "openrouter":
			return {
				body: {
					reasoning: enabled ? (normalized ? { effort: normalized } : { enabled: true }) : { enabled: false },
				},
				enabled,
			};
		case "deepseek":
			return {
				body: { thinking: { type: enabled ? "enabled" : "disabled" } },
				enabled,
			};
		case "kimi":
			return {
				// Kimi requires reasoning_content from tool-call turns to be replayed.
				// `keep: all` additionally preserves it across ordinary turns.
				body: { thinking: { type: enabled ? "enabled" : "disabled", ...(enabled ? { keep: "all" } : {}) } },
				enabled,
			};
		case "qianfan":
			return { body: { enable_thinking: enabled }, enabled };
		case "qwen":
			return {
				body: { enable_thinking: enabled, ...(normalized ? { reasoning_effort: normalized } : {}) },
				enabled,
			};
		case "together":
			return { body: { reasoning: { enabled }, ...(normalized ? { reasoning_effort: normalized } : {}) }, enabled };
		case "xai":
			return { body: { reasoning_effort: normalized ?? "high" }, enabled: true };
		case "zai":
			return {
				body: { thinking: { type: enabled ? "enabled" : "disabled", clear_thinking: false } },
				enabled,
			};
		case "huawei":
			return { body: { chat_template_kwargs: { enable_thinking: enabled } }, enabled };
		case "minimax": {
			// M3's `thinking` controls have a 3-state surface in the UI, but
			// the live API is more nuanced: when present, the server only
			// accepts `thinking: { type: "adaptive" }` or `thinking: { type:
			// "disabled" }` — `type: "enabled"` is rejected (400 with
			// "allowed: adaptive, disabled"). The "always-on" mode is the
			// default: omit the field entirely and the model runs in its
			// built-in reasoning-on behavior. `reasoning_split` stays on so
			// 思考 stays in its own stream channel regardless of mode.
			// Verified live against api.minimax.io.
			if (effort === "adaptive") {
				return {
					body: { reasoning_split: true, thinking: { type: "adaptive" } },
					enabled: true,
				};
			}
			if (effort === "disabled") {
				return {
					body: { reasoning_split: true, thinking: { type: "disabled" } },
					enabled: false,
				};
			}
			// "enabled" (default) — let the server run in its built-in always-on mode.
			return { body: { reasoning_split: true }, enabled: true };
		}
		case "generic":
			return enabled
				? { body: { reasoning_effort: normalized ?? "medium" }, enabled: true }
				: { body: {}, enabled: false };
		case "auto":
		case "openai":
			return { body: { reasoning_effort: enabled ? (normalized ?? "medium") : "none" }, enabled };
	}
}

// ============================================================================
// UI helpers
// ============================================================================

export function getReasoningOptions(meta: ModelReasoningMeta | null): Array<{ value: string; label: string }> {
	if (!meta) {
		return ["off", "low", "medium", "high", "max"].map((value) => ({
			value,
			label:
				value === "off"
					? "Off (provider default unknown)"
					: `${value.charAt(0).toUpperCase()}${value.slice(1)} (generic)`,
		}));
	}

	if (meta.supportedEfforts.length === 0) {
		// Model reports reasoning support but as a binary toggle only (e.g.
		// OpenRouter's `{ mandatory, default_enabled }` shape with no
		// `supported_efforts` list) — offer on/off instead of an effort menu.
		return [
			...(meta.mandatory ? [] : [{ value: "off", label: "Off (no reasoning)" }]),
			{ value: "on", label: `On${meta.defaultEnabled ? " (default)" : ""}` },
		];
	}

	const options: Array<{ value: string; label: string }> = meta.mandatory
		? []
		: [{ value: "off", label: "Off (no reasoning)" }];

	for (const effort of meta.supportedEfforts) {
		if (effort === "none") continue;
		const label = effort.charAt(0).toUpperCase() + effort.slice(1);
		options.push({
			value: effort,
			label: `${label}${effort === meta.defaultEffort ? " (default)" : ""}`,
		});
	}

	return options;
}

export function getReasoningOptionsForFormat(
	meta: ModelReasoningMeta | null,
	format: ReasoningFormat,
): Array<{ value: string; label: string }> {
	if (!meta && format === "minimax") {
		// M3 supports a 3-state `thinking` parameter (enabled/adaptive/disabled)
		// per huggingface.co/MiniMaxAI/MiniMax-M3 — not a binary on/off.
		return [
			{ value: "enabled", label: "Enabled" },
			{ value: "adaptive", label: "Adaptive" },
			{ value: "disabled", label: "Disabled" },
		];
	}
	if (!meta && ["deepseek", "kimi", "qianfan", "qwen", "together", "zai", "huawei"].includes(format)) {
		return [
			{ value: "off", label: "Off (no reasoning)" },
			{ value: "on", label: "On (provider default effort)" },
		];
	}
	if (!meta && format === "xai") {
		return ["low", "medium", "high"].map((value) => ({
			value,
			label: `${value.charAt(0).toUpperCase()}${value.slice(1)}${value === "high" ? " (default)" : ""}`,
		}));
	}
	return getReasoningOptions(meta);
}

// ============================================================================
// Parse <think> blocks from content (for raw Qwen/DeepSeek without OpenRouter)
// ============================================================================

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Length of the longest suffix of `buffer` that is also a prefix of `tag` —
 * i.e. how many trailing chars of `buffer` could be the start of `tag` if
 * the rest arrives in a later chunk. 0 when no such overlap exists.
 */
function partialTagSuffixLength(buffer: string, tag: string): number {
	const max = Math.min(buffer.length, tag.length - 1);
	for (let k = max; k > 0; k--) {
		if (buffer.slice(buffer.length - k) === tag.slice(0, k)) return k;
	}
	return 0;
}

export class ThinkBlockParser {
	private inThinkBlock = false;
	// Chunk boundaries never align with tag boundaries — a provider streaming
	// "...answer.</thi" then "nk>\n\nFinal: 360" is normal, not pathological.
	// `indexOf` on a single chunk can't see a tag split across two calls: the
	// closing-tag half in the first chunk was silently treated as unterminated
	// thinking, the parser never saw a matching "</think>" again, and every
	// real answer token from then on stayed classified as "thinking" — the
	// visible reply reads as empty while the whole answer hides in the
	// reasoning panel. A split "<think>" has the opposite failure: the reader
	// never recognizes the block opened, so the literal tag fragment and the
	// actual reasoning both leak into the visible reply. `buffer` holds back
	// only the minimal trailing slice that could still be a tag prefix, so a
	// split tag resolves correctly once its other half arrives.
	private buffer = "";
	// Set right after consuming a tag, cleared the moment real (non-newline)
	// text of that kind has been emitted. Models routinely emit a tag
	// immediately followed by "\n\n" as pure visual separation (confirmed
	// live: MiniMax-M3 sending "</think>\n\n# Heading...") — without this,
	// that separator newline becomes a real leading blank line in the
	// rendered reply/reasoning block, on top of the label/spacing the UI
	// already adds for the block itself.
	private thinkAtBlockStart = false;
	private contentAtBlockStart = false;

	private takeThinking(text: string): string | undefined {
		if (!text) return undefined;
		if (!this.thinkAtBlockStart) return text;
		const stripped = text.replace(LEADING_NL_RE, "");
		if (stripped) this.thinkAtBlockStart = false;
		return stripped || undefined;
	}

	private takeContent(text: string): string | undefined {
		if (!text) return undefined;
		if (!this.contentAtBlockStart) return text;
		const stripped = text.replace(LEADING_NL_RE, "");
		if (stripped) this.contentAtBlockStart = false;
		return stripped || undefined;
	}

	parseContent(text: string): { thinking?: string; content?: string } {
		this.buffer += text;
		let thinking: string | undefined;
		let content: string | undefined;

		// Bounded by construction: each iteration either finds a tag (consumes
		// past it) or hits the holdback branch and returns — never spins.
		for (;;) {
			if (this.inThinkBlock) {
				const endIdx = this.buffer.indexOf(THINK_CLOSE);
				if (endIdx !== -1) {
					const piece = this.takeThinking(this.buffer.slice(0, endIdx));
					if (piece) thinking = (thinking ?? "") + piece;
					this.buffer = this.buffer.slice(endIdx + THINK_CLOSE.length);
					this.inThinkBlock = false;
					this.contentAtBlockStart = true;
					continue;
				}
				const holdback = partialTagSuffixLength(this.buffer, THINK_CLOSE);
				const emitEnd = this.buffer.length - holdback;
				const piece = this.takeThinking(this.buffer.slice(0, emitEnd));
				if (piece) thinking = (thinking ?? "") + piece;
				this.buffer = this.buffer.slice(emitEnd);
				return { thinking, content };
			}
			const startIdx = this.buffer.indexOf(THINK_OPEN);
			if (startIdx !== -1) {
				const piece = this.takeContent(this.buffer.slice(0, startIdx));
				if (piece) content = (content ?? "") + piece;
				this.buffer = this.buffer.slice(startIdx + THINK_OPEN.length);
				this.inThinkBlock = true;
				this.thinkAtBlockStart = true;
				continue;
			}
			const holdback = partialTagSuffixLength(this.buffer, THINK_OPEN);
			const emitEnd = this.buffer.length - holdback;
			const piece = this.takeContent(this.buffer.slice(0, emitEnd));
			if (piece) content = (content ?? "") + piece;
			this.buffer = this.buffer.slice(emitEnd);
			return { thinking, content };
		}
	}

	/** Whatever's left in the holdback buffer at stream end was never a real
	 * tag (nothing more is coming to complete it) — flush it as whichever
	 * kind is currently open, instead of silently dropping trailing text. */
	flush(): { thinking?: string; content?: string } {
		const leftover = this.buffer;
		this.buffer = "";
		const wasInThinkBlock = this.inThinkBlock;
		this.inThinkBlock = false;
		if (!leftover) return {};
		return wasInThinkBlock ? { thinking: this.takeThinking(leftover) } : { content: this.takeContent(leftover) };
	}
}
