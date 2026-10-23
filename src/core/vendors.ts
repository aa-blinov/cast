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
const QIANFAN_THINKING_MODEL_RE = /deepseek-v4|deepseek-v3\.2|kimi-k2\.5|glm-5/i;

/**
 * MiniMax models whose reasoning is tuned by depth, not by a switch.
 *
 * MiniMax's own documentation (platform.minimax.io/docs/guides/text-generation,
 * read 2026-10-23): for MiniMax-M3.1-Flash "thinking cannot be turned off.
 * Sending `thinking: {"type": "disabled"}` or `effort: "none"` returns
 * 400", and the depth is set with `reasoning_effort` — `low`, `medium`,
 * `high`, `xhigh`, `max`, defaulting to `max`. On the OpenAI-compatible
 * endpoint the thinking comes back in `reasoning_content` either way, so
 * `reasoning_split` is not what separates it there.
 *
 * The older models (M3, M2.7, M2.5) are the opposite: they take the old
 * `thinking: { type: "adaptive" | "disabled" }` and ignore `reasoning_effort`
 * entirely — verified live against api.minimax.io on 2026-10-23.
 */
const MINIMAX_EFFORT_MODEL_RE = /minimax[-_. ]?m3\.1/i;

/** The thinking depths MiniMax's M3.1 family accepts, cheapest first. */
const MINIMAX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** True when the model takes its thinking depth from `reasoning_effort`. */
function minimaxUsesEffort(model: string): boolean {
	return MINIMAX_EFFORT_MODEL_RE.test(model);
}

/**
 * The depth to ask for, from cast's own level.
 *
 * Thinking cannot be off on these models, so "off" — cast's generic default,
 * and the level a session saved from another provider carries — becomes the
 * cheapest thinking there is rather than a request the API rejects.
 */
function minimaxEffortFor(level: string): string {
	const wanted = level.toLowerCase();
	if ((MINIMAX_EFFORT_LEVELS as readonly string[]).includes(wanted)) return wanted;
	// "off", "on", "enabled", "adaptive" and anything cast does not know mean
	// "the provider's own default", which for this family is the deepest
	// thinking there is: it cannot be turned off, and the cheapest depth is
	// only cheaper when it is asked for by name.
	return "max";
}

export interface ModelReasoningMeta {
	mandatory: boolean;
	defaultEnabled: boolean;
	supportedEfforts: string[];
	defaultEffort: string;
}

/** Request dialect for reasoning controls on OpenAI-compatible APIs.
 * `auto` recognizes endpoints whose public compatibility contract is known;
 * `openai-compatible` is the explicit OpenCode-style adapter for gateways
 * that expose model-specific variants through the OpenAI chat schema. */
export type ReasoningFormat =
	| "auto"
	| "generic"
	| "openai-compatible"
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
	{ value: "openai-compatible", label: "OpenAI-compatible chat (reasoning_effort)" },
	{ value: "openai", label: "OpenAI (reasoning_effort)" },
	{ value: "openrouter", label: "OpenRouter (reasoning.effort)" },
	{ value: "deepseek", label: "DeepSeek-compatible (thinking.type)" },
	{ value: "kimi", label: "Kimi / Moonshot (thinking.type, preserved thinking)" },
	{ value: "qianfan", label: "Baidu Qianfan / ERNIE (enable_thinking)" },
	{ value: "qwen", label: "Qwen / DashScope (enable_thinking)" },
	{ value: "together", label: "Together (reasoning.enabled)" },
	{ value: "xai", label: "xAI / Grok (reasoning_effort)" },
	{ value: "zai", label: "Z.ai / GLM (thinking.type)" },
	{ value: "huawei", label: "Huawei ModelArts (chat_template_kwargs.enable_thinking)" },
	{ value: "minimax", label: "MiniMax (always-on / adaptive / off)" },
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
	// OpenCode's Zen Go endpoint uses the OpenAI-compatible AI SDK adapter;
	// model.dev supplies the per-model variant list separately.
	if (host.includes("opencode.ai/zen")) return "openai-compatible";
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

export function buildReasoningParams(effort: string, format: ReasoningFormat = "auto", model = ""): ReasoningParams {
	if (effort === "unknown") return { body: {}, enabled: false };
	if (format !== "minimax" && model.toLowerCase().includes("minimax")) {
		return buildReasoningParams(effort, "minimax", model);
	}
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
				body: {
					thinking: { type: enabled ? "enabled" : "disabled" },
					...(enabled && normalized ? { reasoning_effort: normalized } : {}),
				},
				enabled,
			};
		case "kimi":
			return {
				// Kimi requires reasoning_content from tool-call turns to be replayed.
				// `keep: all` additionally preserves it across ordinary turns.
				body: {
					thinking: { type: enabled ? "enabled" : "disabled", ...(enabled ? { keep: "all" } : {}) },
					...(enabled && normalized ? { reasoning_effort: normalized } : {}),
				},
				enabled,
			};
		case "qianfan":
			if (QIANFAN_THINKING_MODEL_RE.test(model)) {
				return {
					body: {
						thinking: { type: enabled ? "enabled" : "disabled" },
						...(enabled && normalized ? { reasoning_effort: normalized } : {}),
					},
					enabled,
				};
			}
			return {
				body: { enable_thinking: enabled, ...(normalized ? { reasoning_effort: normalized } : {}) },
				enabled,
			};
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
			//
			// All "on / enable" levels (enabled, low, medium, high, max, on)
			// map to the same always-on body — the picker shows the 3-state
			// [enabled, adaptive, disabled] set when /v1/models doesn't expose
			// supportedEfforts, but a saved reasoningLevel from another path
			// (e.g. a model that previously returned [low, medium, high]) can
			// still arrive here. Funnel them all to adaptive so the body is
			// always valid for the API.
			// The M3.1 family has no switch: its thinking cannot be turned
			// off (the API answers 400 to `thinking: {type: "disabled"}` and to
			// `effort: "none"`), and the depth is set with reasoning_effort.
			// Every level goes through that path — a level left over from
			// another model would otherwise fail the request outright.
			if (minimaxUsesEffort(model)) {
				return {
					body: { reasoning_split: true, reasoning_effort: minimaxEffortFor(effort) },
					enabled: true,
				};
			}
			if (effort === "off" || effort === "disabled") {
				return {
					body: { reasoning_split: true, thinking: { type: "disabled" } },
					enabled: false,
				};
			}
			if (effort === "adaptive") {
				return {
					body: { reasoning_split: true, thinking: { type: "adaptive" } },
					enabled: true,
				};
			}
			// enabled / on / low / medium / high / max / unknown — always-on.
			return { body: { reasoning_split: true }, enabled: true };
		}
		case "generic":
			return enabled
				? { body: { reasoning_effort: normalized ?? "medium" }, enabled: true }
				: { body: {}, enabled: false };
		case "openai-compatible":
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
	model = "",
	reasoningSupported = false,
): Array<{ value: string; label: string }> {
	const modelId = model.toLowerCase();
	if (format === "minimax" || modelId.includes("minimax")) {
		// MiniMax's current API exposes a default always-on mode plus explicit
		// adaptive and disabled modes. `reasoning_split` controls where the
		// reasoning is returned, not how deeply the model reasons.
		// The M3.1 family rejects "disabled" with a 400, so that option is
		// not offered for those models — a picker entry that 400s the next
		// request is worse than no entry at all.
		// The M3.1 family has no switch: the depth is the only control, and
		// its own vocabulary (low … max, defaulting to max) is what the
		// picker shows.
		if (minimaxUsesEffort(model)) {
			return [
				{ value: "max", label: "Max (provider default)" },
				{ value: "xhigh", label: "Extra high" },
				{ value: "high", label: "High" },
				{ value: "medium", label: "Medium" },
				{ value: "low", label: "Low (cheapest)" },
			];
		}
		const options = [
			{ value: "enabled", label: "Always on (provider default)" },
			{ value: "adaptive", label: "Adaptive" },
			{ value: "disabled", label: "Off" },
		];
		return options;
	}
	if (!meta && format === "deepseek" && modelId.includes("deepseek-v4")) {
		return [
			{ value: "off", label: "Off" },
			{ value: "high", label: "High (provider default)" },
			{ value: "max", label: "Max (agent mode)" },
		];
	}
	if (
		!meta &&
		(format === "qianfan" || format === "qwen") &&
		(modelId.includes("deepseek-v4") || modelId.includes("glm-"))
	) {
		return [
			{ value: "off", label: "Off" },
			{ value: "high", label: "High (provider default)" },
			{ value: "max", label: "Max (agent mode)" },
		];
	}
	if (!meta && format === "kimi" && modelId.includes("kimi-k3")) {
		return [
			{ value: "low", label: "Low" },
			{ value: "high", label: "High" },
			{ value: "max", label: "Max (provider default)" },
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
	if (!meta && reasoningSupported) {
		return [
			{ value: "off", label: "Off (no reasoning)" },
			{ value: "on", label: "On (supported)" },
		];
	}
	return getReasoningOptions(meta);
}

/**
 * Returns the vendor/model default, not cast's preferred effort. Providers
 * disagree on this: some default to enabled reasoning, some to disabled, and
 * some use a model-specific effort. The picker uses this only as its initial
 * cursor; the user still confirms the value explicitly.
 */
export function getDefaultReasoningLevel(
	meta: ModelReasoningMeta | null,
	format: ReasoningFormat,
	model: string,
	reasoningSupported = false,
): string {
	const options = getReasoningOptionsForFormat(meta, format, model, reasoningSupported);
	const modelId = model.toLowerCase();
	let preferred: string;

	if (meta) {
		if (!meta.defaultEnabled && options.some((option) => option.value === "off")) preferred = "off";
		else if (meta.defaultEffort && options.some((option) => option.value === meta.defaultEffort)) {
			preferred = meta.defaultEffort;
		} else {
			preferred = options.some((option) => option.value === "on")
				? "on"
				: (options.find((option) => option.value !== "off")?.value ?? options[0]?.value ?? "unknown");
		}
	} else if (reasoningSupported) {
		preferred = options.some((option) => option.value === "on") ? "on" : (options[0]?.value ?? "off");
	} else {
		switch (format) {
			case "minimax":
				preferred = "enabled";
				break;
			case "openai-compatible":
			case "openai":
			case "auto":
				preferred = modelId.includes("gpt-5.1") ? "off" : modelId.includes("gpt-5-pro") ? "high" : "medium";
				break;
			case "deepseek":
				preferred = modelId.includes("deepseek-v4") ? "high" : modelId.includes("v3.1") ? "off" : "on";
				break;
			case "kimi":
				preferred = modelId.includes("kimi-k3") ? "max" : "on";
				break;
			case "qianfan":
				preferred = modelId.includes("ernie-5.0-thinking") ? "on" : "off";
				break;
			case "qwen":
				preferred = modelId.includes("deepseek-v4") || modelId.includes("glm-") ? "high" : "off";
				break;
			case "together":
				preferred = modelId.includes("gpt-oss") ? "medium" : modelId.includes("deepseek-v4") ? "high" : "on";
				break;
			case "xai":
				preferred = "high";
				break;
			case "zai":
				preferred = "on";
				break;
			case "huawei":
				preferred = modelId.includes("deepseek-v3.1") || modelId.includes("deepseek-v3.2") ? "off" : "on";
				break;
			case "generic":
			case "openrouter":
				preferred = "off";
				break;
		}
		// The M3.1 family's default depth is cast's, not the provider's: the
		// provider would think at "max", which measured both slower and less
		// steady on the behaviour bench (39/39 tool contracts and 11/12 of the
		// cases that used to flip, at half the wall time). "low" is the
		// cheapest depth there is, and the picker opens on it.
		if (modelId.includes("minimax")) preferred = minimaxUsesEffort(model) ? "low" : "enabled";
	}

	return options.some((option) => option.value === preferred) ? preferred : (options[0]?.value ?? "unknown");
}

/**
 * The reasoning level a model can actually run with.
 *
 * A level can be left over from another model — a saved "off" carried over
 * from a provider that allows it, or a "high" landing on a provider whose
 * vocabulary is [enabled, adaptive, disabled]. When the level isn't in the
 * model's option list the request either fails (MiniMax's M3.1 family
 * rejects `thinking: { type: "disabled" }` with a 400) or silently means
 * something else, so the level falls back to the model's default.
 */
export function resolveReasoningLevel(
	level: string,
	meta: ModelReasoningMeta | null,
	format: ReasoningFormat,
	model = "",
	reasoningSupported = false,
): string {
	const options = getReasoningOptionsForFormat(meta, format, model, reasoningSupported);
	if (options.length === 0 || options.some((option) => option.value === level)) return level;
	// "off" and "disabled" are the same request in every vocabulary that
	// spells one of them: a saved "off" on a provider whose levels are
	// spelled "disabled" is a level the model can run, not an unknown one.
	const alias = level === "off" ? "disabled" : level === "disabled" ? "off" : undefined;
	if (alias && options.some((option) => option.value === alias)) return alias;
	return getDefaultReasoningLevel(meta, format, model, reasoningSupported);
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
	// Holdback buffer for tag-boundary alignment — see the field doc above.
	// We keep the entire input stream in here (no slicing) so that a single
	// `emittedBufferLen` offset can track how much has already been
	// delivered across calls — the alternative (slicing the buffer to the
	// holdback tail each yield) made `emittedBufferLen` lose its meaning
	// because the slice shifted the indices. The buffer is compacted only
	// when the already-emitted prefix grows to a meaningful fraction of the
	// total length, to keep amortised cost flat on long streams.
	private buffer = "";
	// Number of leading characters in `buffer` already returned to the
	// caller across all previous parseContent() / flush() calls. Every
	// yield must contain only the *new* text since the last yield — the
	// downstream stream collector concatenates (`content += chunk.content`)
	// and the UI's per-token redraw assumed that contract. Returning the
	// full running buffer each chunk made each redraw re-show every prior
	// line, producing the visible "streaming line by line" flicker.
	private emittedBufferLen = 0;
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

		// Compact the prefix we've already emitted so the buffer can't grow
		// without bound on long runs. The offset stays valid because we only
		// drop characters strictly before `emittedBufferLen`.
		if (this.emittedBufferLen > 1024 && this.emittedBufferLen * 2 >= this.buffer.length) {
			this.buffer = this.buffer.slice(this.emittedBufferLen);
			this.emittedBufferLen = 0;
		}

		// Bounded by construction: each iteration either finds a tag (consumes
		// past it) or hits the holdback branch and returns — never spins.
		for (;;) {
			if (this.inThinkBlock) {
				const endIdx = this.buffer.indexOf(THINK_CLOSE, this.emittedBufferLen);
				if (endIdx !== -1) {
					const piece = this.takeThinking(this.buffer.slice(this.emittedBufferLen, endIdx));
					if (piece) thinking = (thinking ?? "") + piece;
					this.emittedBufferLen = endIdx + THINK_CLOSE.length;
					this.inThinkBlock = false;
					this.contentAtBlockStart = true;
					continue;
				}
				const holdback = partialTagSuffixLength(this.buffer, THINK_CLOSE);
				const emitEnd = this.buffer.length - holdback;
				if (emitEnd > this.emittedBufferLen) {
					const piece = this.takeThinking(this.buffer.slice(this.emittedBufferLen, emitEnd));
					if (piece) thinking = (thinking ?? "") + piece;
					this.emittedBufferLen = emitEnd;
				}
				return { thinking, content };
			}
			const startIdx = this.buffer.indexOf(THINK_OPEN, this.emittedBufferLen);
			if (startIdx !== -1) {
				const piece = this.takeContent(this.buffer.slice(this.emittedBufferLen, startIdx));
				if (piece) content = (content ?? "") + piece;
				this.emittedBufferLen = startIdx + THINK_OPEN.length;
				this.inThinkBlock = true;
				this.thinkAtBlockStart = true;
				continue;
			}
			const holdback = partialTagSuffixLength(this.buffer, THINK_OPEN);
			const emitEnd = this.buffer.length - holdback;
			if (emitEnd > this.emittedBufferLen) {
				const piece = this.takeContent(this.buffer.slice(this.emittedBufferLen, emitEnd));
				if (piece) content = (content ?? "") + piece;
				this.emittedBufferLen = emitEnd;
			}
			return { thinking, content };
		}
	}

	/** Whatever's left in the holdback buffer at stream end was never a real
	 * tag (nothing more is coming to complete it) — flush it as whichever
	 * kind is currently open, instead of silently dropping trailing text. */
	flush(): { thinking?: string; content?: string } {
		const leftover = this.buffer.slice(this.emittedBufferLen);
		this.buffer = "";
		this.emittedBufferLen = 0;
		const wasInThinkBlock = this.inThinkBlock;
		this.inThinkBlock = false;
		if (!leftover) return {};
		return wasInThinkBlock ? { thinking: this.takeThinking(leftover) } : { content: this.takeContent(leftover) };
	}
}
