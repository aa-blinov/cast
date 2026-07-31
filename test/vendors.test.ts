import { describe, expect, it } from "vitest";
import { applyCacheControl, isContextOverflow, type Message, type Tool } from "../src/core/llm.ts";
import {
	buildReasoningParams,
	extractReasoningMeta,
	getReasoningOptions,
	getReasoningOptionsForFormat,
	resolveReasoningFormat,
	ThinkBlockParser,
} from "../src/core/vendors.ts";

// ============================================================================
// isContextOverflow
// ============================================================================

describe("isContextOverflow", () => {
	it("returns true for code field context_length_exceeded", () => {
		expect(isContextOverflow({ code: "context_length_exceeded" })).toBe(true);
	});

	it("returns true for status 413", () => {
		expect(isContextOverflow({ status: 413 })).toBe(true);
	});

	it("returns true for each regex pattern", () => {
		const patterns = [
			"prompt is too long",
			"input is too long for requested model",
			"exceeds the context window",
			"input token count exceeds the maximum",
			"maximum prompt length is 12345",
			"reduce the length of the messages",
			"maximum context length is 12345 tokens",
			"exceeds the limit of 12345",
			"exceeds the available context size",
			"greater than the context length",
			"context window exceeds limit",
			"exceeded model token limit",
			"context_length_exceeded",
			"context length exceeded",
			"request entity too large",
			"context length is only 12345 tokens",
			"input length exceeds context length",
			"prompt too long; exceeded max context length",
			"prompt too long; exceeded context length",
			"too large for model with 12345 maximum context length",
			"model_context_window_exceeded",
		];
		for (const msg of patterns) {
			expect(isContextOverflow(new Error(msg))).toBe(true);
		}
	});

	it("returns true for 400 (no body) pattern", () => {
		expect(isContextOverflow(new Error("400 (no body)"))).toBe(true);
		expect(isContextOverflow(new Error("413 status code (no body)"))).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isContextOverflow(new Error("something went wrong"))).toBe(false);
		expect(isContextOverflow({ code: "ECONNRESET" })).toBe(false);
		expect(isContextOverflow({ status: 500 })).toBe(false);
	});

	it("returns false for null/undefined", () => {
		expect(isContextOverflow(null)).toBe(false);
		expect(isContextOverflow(undefined)).toBe(false);
	});
});

// ============================================================================
// applyCacheControl
// ============================================================================

describe("applyCacheControl", () => {
	it("adds cache_control to the first system message in the returned copy", () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
		];
		const tools: Tool[] = [];
		const out = applyCacheControl(messages, tools);

		const sysContent = out.messages[0]!.content;
		expect(Array.isArray(sysContent)).toBe(true);
		const parts = sysContent as Array<{ type: string; text: string; cache_control?: { type: string } }>;
		expect(parts[0]!.cache_control).toEqual({ type: "ephemeral" });
	});

	it("does not mutate the input messages or tools (session state stays clean)", () => {
		// The originals are the same objects saveSession persists — the
		// structured-content shape leaking into the session file bricks it on
		// providers whose chat template expects plain string content.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hello" },
		];
		const tools: Tool[] = [{ type: "function", function: { name: "bash", parameters: {} } }];
		applyCacheControl(messages, tools);

		expect(messages[0]!.content).toBe("sys");
		expect(messages[1]!.content).toBe("hello");
		expect((tools[0] as any).cache_control).toBeUndefined();
	});

	it("adds cache_control to the last tool definition in the returned copy", () => {
		const messages: Message[] = [{ role: "system", content: "sys" }];
		const tools: Tool[] = [
			{ type: "function", function: { name: "bash", parameters: {} } },
			{ type: "function", function: { name: "read", parameters: {} } },
		];
		const out = applyCacheControl(messages, tools);

		expect((out.tools[0] as any).cache_control).toBeUndefined();
		expect((out.tools[1] as any).cache_control).toEqual({ type: "ephemeral" });
	});

	it("adds cache_control to the last user or assistant message", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "first" },
			{ role: "assistant", content: "response" },
			{ role: "user", content: "last" },
		];
		const tools: Tool[] = [];
		const out = applyCacheControl(messages, tools);

		// Last user message should have cache_control
		const lastUser = out.messages[3]!.content;
		expect(Array.isArray(lastUser)).toBe(true);
		const parts = lastUser as Array<{ type: string; text: string; cache_control?: { type: string } }>;
		expect(parts[0]!.cache_control).toEqual({ type: "ephemeral" });

		// First user message should not
		const firstUser = out.messages[1]!.content;
		expect(typeof firstUser).toBe("string");
	});

	it("skips empty system messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "" },
			{ role: "user", content: "Hello" },
		];
		const tools: Tool[] = [];
		const out = applyCacheControl(messages, tools);

		// Empty system message stays empty (not converted)
		expect(out.messages[0]!.content).toBe("");
		// User message gets the marker instead
		const userContent = out.messages[1]!.content;
		expect(Array.isArray(userContent)).toBe(true);
	});

	it("handles array content by adding marker to last text part, without mutating the original parts", () => {
		const original = [
			{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
			{ type: "text", text: "What is this?" },
		];
		const messages: Message[] = [{ role: "user", content: original as never }];
		const tools: Tool[] = [];
		const out = applyCacheControl(messages, tools);

		const content = out.messages[0]!.content as Array<{
			type: string;
			text?: string;
			cache_control?: { type: string };
		}>;
		expect(content[0]!.cache_control).toBeUndefined(); // image part
		expect(content[1]!.cache_control).toEqual({ type: "ephemeral" }); // text part
		expect((original[1] as any).cache_control).toBeUndefined(); // input untouched
	});

	it("no-op when tools array is empty", () => {
		const messages: Message[] = [{ role: "system", content: "sys" }];
		const out = applyCacheControl(messages, []);
		// Should not throw; system message still gets marker in the copy
		expect(Array.isArray(out.messages[0]!.content)).toBe(true);
	});
});

// ============================================================================
// ThinkBlockParser
// ============================================================================

describe("ThinkBlockParser", () => {
	it("parses a single complete think block in one chunk", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("before<think>thinking content</think>after");
		expect(result.thinking).toBe("thinking content");
		expect(result.content).toBe("beforeafter");
	});

	it("handles content before the think block", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("hello<think>world</think>");
		expect(result.content).toBe("hello");
		expect(result.thinking).toBe("world");
	});

	it("handles a think block split across multiple chunks", () => {
		const parser = new ThinkBlockParser();
		const r1 = parser.parseContent("<think>start of thinking");
		expect(r1.thinking).toBe("start of thinking");
		expect(r1.content).toBeUndefined();

		const r2 = parser.parseContent(" middle");
		expect(r2.thinking).toBe(" middle");

		const r3 = parser.parseContent(" end</think>after");
		// Each chunk returns only its own portion — the caller accumulates.
		expect(r3.thinking).toBe(" end");
		expect(r3.content).toBe("after");
	});

	it("flush returns remaining buffer when stream ends mid-think", () => {
		const parser = new ThinkBlockParser();
		parser.parseContent("<think>incomplete");
		// Intermediate chunks already yielded their portions; flush is a no-op.
		const flushed = parser.flush();
		expect(flushed).toEqual({});
	});

	it("flush returns undefined when not in think block", () => {
		const parser = new ThinkBlockParser();
		parser.parseContent("no think block here");
		expect(parser.flush()).toEqual({});
	});

	it("handles plain content with no think blocks", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("just regular text");
		expect(result.content).toBe("just regular text");
		expect(result.thinking).toBeUndefined();
	});

	it("handles empty string", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("");
		expect(result.content).toBeUndefined();
		expect(result.thinking).toBeUndefined();
	});

	it("handles think block with no content after", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("<think>only thinking</think>");
		expect(result.thinking).toBe("only thinking");
		expect(result.content).toBeUndefined();
	});

	// Regression coverage for a real, live-confirmed bug: MiniMax-M3 (and any
	// other raw-<think>-tag provider) streams in chunks that don't line up
	// with tag boundaries. A naive per-chunk indexOf() can't see a tag split
	// across two parseContent() calls.
	describe("tag split across chunk boundaries", () => {
		it("resolves a </think> split across chunks instead of swallowing the rest of the reply as thinking", () => {
			// Before the fix: chunk 1's indexOf("</think>") fails (only "</thi" is
			// present), the parser stays in the think block forever, and every
			// later chunk — including "nk>" itself and the whole real answer —
			// gets misclassified as thinking. The visible reply reads as empty.
			const parser = new ThinkBlockParser();
			const r1 = parser.parseContent("<think>reasoning...</thi");
			const r2 = parser.parseContent("nk>\n\nFinal: 360");
			const r3 = parser.parseContent(" and done.");
			expect(r1.thinking).toBe("reasoning...");
			expect(r2.content).toBe("Final: 360");
			expect(r3.content).toBe(" and done.");
			// The literal tag fragment "nk>" must never leak into either output.
			expect((r1.thinking ?? "") + (r2.thinking ?? "") + (r3.thinking ?? "")).not.toContain("nk>");
		});

		it("resolves a <think> split across chunks instead of leaking the tag and the reasoning into the reply", () => {
			// Before the fix: chunk 1's indexOf("<think>") fails (only "<thi" is
			// present), so the parser never realizes a think block opened — the
			// tag fragment and the actual reasoning both show up as visible content.
			const parser = new ThinkBlockParser();
			const r1 = parser.parseContent("<thi");
			const r2 = parser.parseContent("nk>reasoning here</think>answer");
			expect(r1.content).toBeUndefined();
			expect(r2.thinking).toBe("reasoning here");
			expect(r2.content).toBe("answer");
		});

		it("resolves a split tag even when chunks arrive one character at a time", () => {
			const parser = new ThinkBlockParser();
			const text = "<think>hidden reasoning</think>visible answer";
			let thinking = "";
			let content = "";
			for (const ch of text) {
				const r = parser.parseContent(ch);
				if (r.thinking) thinking += r.thinking;
				if (r.content) content += r.content;
			}
			expect(thinking).toBe("hidden reasoning");
			expect(content).toBe("visible answer");
		});

		it("does not hold back text that merely resembles a tag prefix but never completes one", () => {
			// "< think tank>" contains "<" followed eventually by "think" but with
			// a space — never a real "<think>" — so it must flow through as
			// ordinary content, and flush() must not need to rescue anything.
			const parser = new ThinkBlockParser();
			const result = parser.parseContent("price is < think tank>");
			expect(result.content).toBe("price is < think tank>");
			expect(parser.flush()).toEqual({});
		});
	});

	// Regression coverage for the second half of the same live bug report:
	// providers commonly emit "</think>\n\n" (or "<think>\n\n") as pure visual
	// separation from the tag — left unstripped, that becomes a real leading
	// blank line in the rendered reasoning/reply block, on top of whatever
	// spacing the UI already adds around the block itself.
	describe("leading-newline trim at a block's start", () => {
		it("strips newlines right after </think> from the start of the reply", () => {
			const parser = new ThinkBlockParser();
			const result = parser.parseContent("<think>r</think>\n\n# Heading\n\nBody");
			expect(result.content).toBe("# Heading\n\nBody");
		});

		it("strips newlines right after <think> from the start of the reasoning", () => {
			const parser = new ThinkBlockParser();
			const result = parser.parseContent("<think>\n\nreasoning text</think>answer");
			expect(result.thinking).toBe("reasoning text");
			expect(result.content).toBe("answer");
		});

		it("only trims once per block — a legitimate blank line further into the same block is preserved", () => {
			const parser = new ThinkBlockParser();
			const result = parser.parseContent("<think>r</think>Para one.\n\nPara two.");
			expect(result.content).toBe("Para one.\n\nPara two.");
		});

		it("keeps holding back a leading newline split across chunks until real text arrives", () => {
			const parser = new ThinkBlockParser();
			const r1 = parser.parseContent("<think>r</think>\n");
			const r2 = parser.parseContent("\nReal content");
			expect(r1.content).toBeUndefined();
			expect(r2.content).toBe("Real content");
		});
	});
});

// ============================================================================
// extractReasoningMeta
// ============================================================================

describe("extractReasoningMeta", () => {
	it("returns null when no reasoning field", () => {
		expect(extractReasoningMeta({ id: "gpt-4o" })).toBeNull();
	});

	it("returns correct meta for full object", () => {
		const meta = extractReasoningMeta({
			reasoning: {
				mandatory: false,
				default_enabled: true,
				supported_efforts: ["high", "medium", "low"],
				default_effort: "medium",
			},
		});
		expect(meta).toEqual({
			mandatory: false,
			defaultEnabled: true,
			supportedEfforts: ["high", "medium", "low"],
			defaultEffort: "medium",
		});
	});

	it("handles missing supported_efforts (returns empty array)", () => {
		const meta = extractReasoningMeta({
			reasoning: { mandatory: false, default_enabled: false },
		});
		expect(meta?.supportedEfforts).toEqual([]);
	});

	it("handles missing default_effort (defaults to medium)", () => {
		const meta = extractReasoningMeta({
			reasoning: { mandatory: false, default_enabled: false, supported_efforts: ["high"] },
		});
		expect(meta?.defaultEffort).toBe("medium");
	});

	it("handles non-boolean mandatory (defaults to false)", () => {
		const meta = extractReasoningMeta({
			reasoning: { mandatory: "yes", default_enabled: false },
		});
		expect(meta?.mandatory).toBe(false);
	});
});

// ============================================================================
// buildReasoningParams
// ============================================================================

describe("buildReasoningParams", () => {
	it("detects Xiaomi MiMo Token Plan as DeepSeek-compatible", () => {
		expect(resolveReasoningFormat("https://token-plan-sgp.xiaomimimo.com/v1")).toBe("deepseek");
	});

	it("detects Kimi, Z.ai, and xAI endpoint dialects", () => {
		expect(resolveReasoningFormat("https://api.moonshot.ai/v1")).toBe("kimi");
		expect(resolveReasoningFormat("https://open.bigmodel.cn/api/paas/v4")).toBe("zai");
		expect(resolveReasoningFormat("https://api.x.ai/v1")).toBe("xai");
		expect(resolveReasoningFormat("https://qianfan.baidubce.com/v2")).toBe("qianfan");
		expect(resolveReasoningFormat("https://ark.cn-beijing.volces.com/api/v3")).toBe("deepseek");
		expect(resolveReasoningFormat("https://api.modelarts.huaweicloud.com/v1")).toBe("huawei");
	});

	it("does not send undocumented reasoning controls to MiniMax", () => {
		expect(resolveReasoningFormat("https://api.minimax.io/v1")).toBe("minimax");
		expect(buildReasoningParams("on", "minimax").body).toEqual({});
		expect(getReasoningOptionsForFormat(null, "minimax").map((option) => option.value)).toEqual(["on"]);
	});

	it("off returns explicit enabled: false", () => {
		const params = buildReasoningParams("off", "openai");
		expect(params.body).toEqual({ reasoning_effort: "none" });
		expect(params.enabled).toBe(false);
	});

	it("on returns explicit enabled: true", () => {
		const params = buildReasoningParams("on", "openai");
		expect(params.body).toEqual({ reasoning_effort: "medium" });
		expect(params.enabled).toBe(true);
	});

	it("low/medium/high/max return effort level", () => {
		for (const effort of ["low", "medium", "high", "max"]) {
			const params = buildReasoningParams(effort, "openai");
			expect(params.body).toEqual({ reasoning_effort: effort });
			expect(params.enabled).toBe(true);
		}
	});

	it("omits reasoning controls by default for unknown OpenAI-compatible endpoints", () => {
		expect(resolveReasoningFormat("https://api.mistral.ai/v1")).toBe("generic");
		expect(buildReasoningParams("off", "generic").body).toEqual({});
	});

	it("uses the configured OpenRouter dialect", () => {
		expect(buildReasoningParams("high", "openrouter").body).toEqual({ reasoning: { effort: "high" } });
		expect(buildReasoningParams("off", "openrouter").body).toEqual({ reasoning: { enabled: false } });
	});

	it("uses binary controls for DeepSeek and Qwen-compatible providers", () => {
		expect(buildReasoningParams("on", "deepseek").body).toEqual({ thinking: { type: "enabled" } });
		expect(buildReasoningParams("off", "qwen").body).toEqual({ enable_thinking: false });
	});

	it("uses Kimi preserved thinking and xAI's supported effort field", () => {
		expect(buildReasoningParams("on", "kimi").body).toEqual({ thinking: { type: "enabled", keep: "all" } });
		expect(buildReasoningParams("medium", "xai").body).toEqual({ reasoning_effort: "medium" });
	});

	it("uses Qianfan and Huawei's documented thinking fields", () => {
		expect(buildReasoningParams("on", "qianfan").body).toEqual({ enable_thinking: true });
		expect(buildReasoningParams("off", "huawei").body).toEqual({
			chat_template_kwargs: { enable_thinking: false },
		});
	});
});

// ============================================================================
// getReasoningOptions
// ============================================================================

describe("getReasoningOptions", () => {
	it("returns generic choices when metadata is absent", () => {
		expect(getReasoningOptions(null).map((option) => option.value)).toEqual(["off", "low", "medium", "high", "max"]);
	});

	it("returns on/off for binary toggle (no supported_efforts)", () => {
		const options = getReasoningOptions({
			mandatory: false,
			defaultEnabled: true,
			supportedEfforts: [],
			defaultEffort: "medium",
		});
		expect(options).toHaveLength(2);
		expect(options[0]!.value).toBe("off");
		expect(options[1]!.value).toBe("on");
		expect(options[1]!.label).toContain("default");
	});

	it("returns off + all supported efforts", () => {
		const options = getReasoningOptions({
			mandatory: false,
			defaultEnabled: true,
			supportedEfforts: ["low", "medium", "high"],
			defaultEffort: "medium",
		});
		expect(options).toHaveLength(4);
		expect(options[0]!.value).toBe("off");
		expect(options[1]!.value).toBe("low");
		expect(options[2]!.value).toBe("medium");
		expect(options[2]!.label).toContain("default");
		expect(options[3]!.value).toBe("high");
	});

	it("does not offer disable for a mandatory reasoning model", () => {
		const options = getReasoningOptions({
			mandatory: true,
			defaultEnabled: true,
			supportedEfforts: ["low", "medium", "high"],
			defaultEffort: "medium",
		});
		expect(options.map((option) => option.value)).toEqual(["low", "medium", "high"]);
	});

	it("does not offer unsupported generic effort levels for binary provider dialects", () => {
		expect(getReasoningOptionsForFormat(null, "kimi").map((option) => option.value)).toEqual(["off", "on"]);
		expect(getReasoningOptionsForFormat(null, "zai").map((option) => option.value)).toEqual(["off", "on"]);
		expect(getReasoningOptionsForFormat(null, "xai").map((option) => option.value)).toEqual([
			"low",
			"medium",
			"high",
		]);
	});
});
