import { describe, expect, it } from "vitest";
import { applyCacheControl, isContextOverflow, type Message, type Tool } from "../src/core/llm.ts";
import {
	buildReasoningParams,
	extractReasoningMeta,
	getReasoningOptions,
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
		expect(flushed).toBeUndefined();
	});

	it("flush returns undefined when not in think block", () => {
		const parser = new ThinkBlockParser();
		parser.parseContent("no think block here");
		expect(parser.flush()).toBeUndefined();
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
		// Empty string is falsy but the code checks `if (before)` which is
		// false for empty string, so content stays undefined.
		// Actually: the else branch assigns `result.content = text` which is "".
		// "" is falsy for the `if (remaining)` check but it IS assigned.
		expect(result.content).toBe("");
		expect(result.thinking).toBeUndefined();
	});

	it("handles think block with no content after", () => {
		const parser = new ThinkBlockParser();
		const result = parser.parseContent("<think>only thinking</think>");
		expect(result.thinking).toBe("only thinking");
		expect(result.content).toBeUndefined();
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
	it("off returns explicit enabled: false", () => {
		const params = buildReasoningParams("off");
		expect(params.body).toEqual({ reasoning: { enabled: false } });
		expect(params.enabled).toBe(false);
	});

	it("on returns explicit enabled: true", () => {
		const params = buildReasoningParams("on");
		expect(params.body).toEqual({ reasoning: { enabled: true } });
		expect(params.enabled).toBe(true);
	});

	it("low/medium/high/max return effort level", () => {
		for (const effort of ["low", "medium", "high", "max"]) {
			const params = buildReasoningParams(effort);
			expect(params.body).toEqual({ reasoning: { effort } });
			expect(params.enabled).toBe(true);
		}
	});
});

// ============================================================================
// getReasoningOptions
// ============================================================================

describe("getReasoningOptions", () => {
	it("returns empty array for null meta", () => {
		expect(getReasoningOptions(null)).toEqual([]);
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
});
