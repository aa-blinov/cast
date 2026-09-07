import { describe, expect, it } from "vitest";
import { lookupCostFromCatalog } from "../src/core/models-dev.ts";

/**
 * Cost came only from the provider's own `usage.cost`, which most
 * OpenAI-compatible gateways never send. On a real store that left 524 of 542
 * sessions with token counts recorded at $0.00 — including 453 on a model
 * whose prices are in the cached catalog all along.
 */
describe("lookupCostFromCatalog", () => {
	const catalog = {
		cheapreseller: {
			models: {
				"model-x": { cost: { input: 0, output: 0 } },
				"gpt-5-mini": { cost: { input: 0.05, output: 0.4 } },
			},
		},
		official: {
			models: {
				"model-x": { cost: { input: 0.3, output: 1.2, cache_read: 0.06 } },
				"gpt-5": { cost: { input: 1.375, output: 10.96, cache_read: 0.156 } },
				free: { cost: { input: 0, output: 0, cache_read: 0 } },
			},
		},
	} as never;

	it("matches the id exactly — a substring match priced gpt-5 at a mini's rate", () => {
		// "gpt-5" used to match "gpt-5-mini" and price 1M tokens at $0.09
		// instead of $2.47. Wrong money is worse than no money.
		expect(lookupCostFromCatalog("gpt-5", catalog)).toEqual({ input: 1.375, output: 10.96, cacheRead: 0.156 });
	});

	it("takes the dearest of several resellers, so an estimate never understates", () => {
		expect(lookupCostFromCatalog("model-x", catalog)).toEqual({ input: 0.3, output: 1.2, cacheRead: 0.06 });
	});

	it("treats an all-zero entry as a real free price, not a missing one", () => {
		expect(lookupCostFromCatalog("free", catalog)).toEqual({ input: 0, output: 0, cacheRead: 0 });
	});

	it("reports nothing for a model it does not know", () => {
		expect(lookupCostFromCatalog("no-such-model", catalog)).toBeUndefined();
	});

	it("falls back to the input rate when the catalog omits cache_read", () => {
		expect(lookupCostFromCatalog("gpt-5-mini", catalog)?.cacheRead).toBe(0.05);
	});
});
