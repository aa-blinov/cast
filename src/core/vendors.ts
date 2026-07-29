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

export interface ModelReasoningMeta {
	mandatory: boolean;
	defaultEnabled: boolean;
	supportedEfforts: string[];
	defaultEffort: string;
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

export function buildReasoningParams(effort: string): ReasoningParams {
	if (effort === "unknown") {
		// Provider didn't report reasoning capabilities. Some models (e.g.
		// MiniMax-M3) nevertheless default to reasoning ON when no params are
		// sent — explicitly disable so the user isn't surprised by <think>
		// blocks wrapping answers they expected to be plain.
		return { body: { reasoning: { enabled: false } }, enabled: false };
	}
	if (effort === "off") {
		// Must be explicit. Some models (e.g. OpenRouter's `default_enabled:
		// true` ones) reason by default when the `reasoning` key is omitted
		// entirely — an empty body doesn't turn reasoning off, it just leaves
		// the provider's own default in place. Confirmed live: omitting the
		// key returns a populated `reasoning` field even though we asked for
		// "off". Sending `enabled: false` on a model with no reasoning support
		// at all is a harmless no-op (verified against gpt-4o-mini).
		return { body: { reasoning: { enabled: false } }, enabled: false };
	}
	if (effort === "on") {
		// Binary-toggle models (see getReasoningOptions) don't take an effort
		// level — just turn reasoning on.
		return { body: { reasoning: { enabled: true } }, enabled: true };
	}
	return {
		body: { reasoning: { effort } },
		enabled: true,
	};
}

// ============================================================================
// UI helpers
// ============================================================================

export function getReasoningOptions(meta: ModelReasoningMeta | null): Array<{ value: string; label: string }> {
	if (!meta) return [];

	if (meta.supportedEfforts.length === 0) {
		// Model reports reasoning support but as a binary toggle only (e.g.
		// OpenRouter's `{ mandatory, default_enabled }` shape with no
		// `supported_efforts` list) — offer on/off instead of an effort menu.
		return [
			{ value: "off", label: "Off (no reasoning)" },
			{ value: "on", label: `On${meta.defaultEnabled ? " (default)" : ""}` },
		];
	}

	const options: Array<{ value: string; label: string }> = [{ value: "off", label: "Off (no reasoning)" }];

	for (const effort of meta.supportedEfforts) {
		const label = effort.charAt(0).toUpperCase() + effort.slice(1);
		options.push({
			value: effort,
			label: `${label}${effort === meta.defaultEffort ? " (default)" : ""}`,
		});
	}

	return options;
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
		const stripped = text.replace(/^\n+/, "");
		if (stripped) this.thinkAtBlockStart = false;
		return stripped || undefined;
	}

	private takeContent(text: string): string | undefined {
		if (!text) return undefined;
		if (!this.contentAtBlockStart) return text;
		const stripped = text.replace(/^\n+/, "");
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
