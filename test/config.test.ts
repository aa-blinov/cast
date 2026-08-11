import { describe, expect, it } from "vitest";
import { classifyProviderError, enrichModelsWithCatalog, loadConfig, lookupContextWindow } from "../src/core/config.ts";

// ============================================================================
// loadConfig
// ============================================================================

describe("loadConfig", () => {
	it("loads config from an explicit connection", () => {
		process.env.PROVIDER_BASE_URL = "https://api.openai.com/v1";
		process.env.PROVIDER_API_KEY = "sk-test";

		const config = loadConfig({ baseURL: "https://api.openai.com/v1", apiKey: "sk-test" });
		expect(config.baseURL).toBe("https://api.openai.com/v1");
		expect(config.apiKey).toBe("sk-test");
		expect(config.contextWindow).toBe(128_000);
		expect(config.maxResponseTokens).toBe(32_000);
		expect(config.defaultBashTimeout).toBe(180);
	});

	it("uses an explicit connection over env vars", () => {
		process.env.PROVIDER_BASE_URL = "https://env-should-be-ignored.example";
		process.env.PROVIDER_API_KEY = "env-key-ignored";

		const config = loadConfig({ baseURL: "https://explicit.example/v1", apiKey: "explicit-key" });
		expect(config.baseURL).toBe("https://explicit.example/v1");
		expect(config.apiKey).toBe("explicit-key");
	});
});

describe("classifyProviderError", () => {
	it("classifies a revoked/invalid key (401 by status) as auth", () => {
		expect(classifyProviderError(Object.assign(new Error("401 status code (no body)"), { status: 401 }))).toBe(
			"auth",
		);
	});

	it("classifies a 401 by wording when no status is attached", () => {
		expect(classifyProviderError(new Error("Unauthorized: invalid api key"))).toBe("auth");
	});

	it("classifies a 403 as permission", () => {
		expect(classifyProviderError(Object.assign(new Error("403 Forbidden"), { status: 403 }))).toBe("permission");
	});

	it("classifies network failures as unreachable", () => {
		expect(classifyProviderError(new Error("fetch failed"))).toBe("unreachable");
		expect(classifyProviderError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))).toBe(
			"unreachable",
		);
	});

	it("classifies the SDK's APIConnectionError wrapper as unreachable", () => {
		// The OpenAI SDK wraps network failures: the top message is just
		// "Connection error." and the real ECONNREFUSED sits in the cause chain
		// (verified against a live closed port). Both signals must classify.
		const wrapped = new Error("Connection error.", {
			cause: new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:59987") }),
		});
		expect(classifyProviderError(wrapped)).toBe("unreachable");
		// Even a severed cause chain still classifies via the wrapper's own message.
		expect(classifyProviderError(new Error("Connection error."))).toBe("unreachable");
		expect(classifyProviderError(new Error("Request timed out."))).toBe("unreachable");
	});

	it("defaults to unknown for anything unrecognized (e.g. no /v1/models 404)", () => {
		// A provider that just doesn't implement /v1/models must NOT be treated as
		// a connection failure — otherwise startup would nag for credentials that
		// are actually fine.
		expect(classifyProviderError(Object.assign(new Error("404 Not Found"), { status: 404 }))).toBe("unknown");
	});
});

describe("lookupContextWindow", () => {
	it("finds MiniMax-M3's real 1M window — its own /v1/models omits context_length entirely", () => {
		// Without this fallback entry, loadConfig's generic 128k default stood
		// in for the real 1,048,576 and tripped compaction ~8x earlier than
		// the model actually needs (verified live against api.minimax.io).
		expect(lookupContextWindow("MiniMax-M3")).toBe(1_000_000);
	});

	it("matches by substring, case-insensitively", () => {
		expect(lookupContextWindow("minimax-m3-highspeed")).toBe(1_000_000);
		expect(lookupContextWindow("provider/MINIMAX-M3")).toBe(1_000_000);
	});

	it("returns undefined for an unknown model — callers fall back to the generic default", () => {
		expect(lookupContextWindow("gpt-4o")).toBeUndefined();
		expect(lookupContextWindow("MiniMax-M2")).toBeUndefined();
	});
});

describe("enrichModelsWithCatalog", () => {
	it("uses models.dev as a fallback without replacing live provider metadata", () => {
		const models = enrichModelsWithCatalog(
			[
				{ id: "deepseek-v4-flash" },
				{
					id: "gpt-5",
					reasoning: {
						mandatory: false,
						defaultEnabled: false,
						supportedEfforts: ["low", "high"],
						defaultEffort: "low",
					},
					contextWindow: 200_000,
				},
			],
			{
				deepseek: {
					models: {
						"deepseek-v4-flash": {
							reasoning: true,
							limit: { context: 1_000_000 },
						},
					},
				},
				openai: { models: { "gpt-5": { reasoning: true, limit: { context: 400_000 } } } },
			},
		);

		expect(models[0]).toMatchObject({
			reasoning: {
				supportedEfforts: [],
			},
			reasoningSupported: true,
			contextWindow: 1_000_000,
		});
		expect(models[1]).toMatchObject({
			reasoning: { defaultEffort: "low" },
			reasoningSupported: true,
			contextWindow: 200_000,
		});
	});
});
