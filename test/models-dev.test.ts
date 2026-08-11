import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fetchImpl: typeof fetch;
const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => fetchImpl(...args)) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const { fetchModelsDevCatalog, lookupContextWindowFromCatalog, lookupModelMetadataFromCatalog } = await import(
	"../src/core/models-dev.ts"
);

const CATALOG_FIXTURE = {
	fireworks: { models: { "minimax-m3": { limit: { context: 512_000 } } } },
	wandb: { models: { "MiniMaxAI/MiniMax-M3": { limit: { context: 262_144 } } } },
	crossmodel: { models: { "minimax/minimax-m3": { limit: { context: 1_024_000 } } } },
	openai: { models: { "gpt-4o": { limit: { context: 128_000 } } } },
};

describe("lookupContextWindowFromCatalog", () => {
	it("takes the minimum across resellers disagreeing on the same model's context (safer than overestimating)", () => {
		// Real data, verified against https://models.dev/api.json: minimax-m3
		// shows up under three resellers with three different numbers, none of
		// which match the vendor's own advertised 1,048,576 — there's no way
		// to know which reseller is right, so the safe direction is to
		// under-, not over-, estimate (overestimating risks a real
		// context-overflow error from the provider; underestimating just
		// compacts a bit early).
		expect(lookupContextWindowFromCatalog("MiniMax-M3", CATALOG_FIXTURE)).toBe(262_144);
	});

	it("matches case-insensitively and through provider-specific prefixes/suffixes", () => {
		expect(lookupContextWindowFromCatalog("gpt-4o", CATALOG_FIXTURE)).toBe(128_000);
		expect(lookupContextWindowFromCatalog("GPT-4O", CATALOG_FIXTURE)).toBe(128_000);
	});

	it("returns undefined when nothing in the catalog matches", () => {
		expect(lookupContextWindowFromCatalog("claude-opus-9", CATALOG_FIXTURE)).toBeUndefined();
	});

	it("ignores entries with no limit.context", () => {
		const catalog = { p: { models: { m: {} } } };
		expect(lookupContextWindowFromCatalog("m", catalog)).toBeUndefined();
	});

	it("returns reasoning capability and effort options", () => {
		const catalog = {
			deepseek: {
				models: {
					"deepseek-v4-flash": {
						reasoning: true,
						reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
						limit: { context: 1_000_000 },
					},
				},
			},
		};
		expect(lookupModelMetadataFromCatalog("deepseek-v4-flash", catalog)).toEqual({
			reasoning: true,
			reasoningOptions: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
			contextWindow: 1_000_000,
		});
	});
});

describe("fetchModelsDevCatalog", () => {
	let fakeHome: string;
	let realHome: string | undefined;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-models-dev-test-"));
		process.env.HOME = fakeHome;
	});
	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("fetches and caches to disk on a cold cache", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify(CATALOG_FIXTURE), { status: 200 }));
		fetchImpl = fetchSpy;

		const catalog = await fetchModelsDevCatalog();
		expect(catalog).toEqual(CATALOG_FIXTURE);
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// Second call within the TTL must not hit the network again.
		fetchImpl = vi.fn(async () => {
			throw new Error("should not be called — cache should have served this");
		});
		const cached = await fetchModelsDevCatalog();
		expect(cached).toEqual(CATALOG_FIXTURE);
	});

	it("re-fetches once the cache is older than the TTL", async () => {
		fetchImpl = async () => new Response(JSON.stringify(CATALOG_FIXTURE), { status: 200 });
		await fetchModelsDevCatalog();

		const path = join(fakeHome, ".cast", "cache", "models-dev.json");
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago, past the 24h TTL
		utimesSync(path, old, old);

		const updated = { ...CATALOG_FIXTURE, newprovider: { models: { x: { limit: { context: 1 } } } } };
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify(updated), { status: 200 }));
		fetchImpl = fetchSpy;

		const catalog = await fetchModelsDevCatalog();
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(catalog).toEqual(updated);
	});

	it("never throws — falls back to a stale cache when the network fetch fails", async () => {
		fetchImpl = async () => new Response(JSON.stringify(CATALOG_FIXTURE), { status: 200 });
		await fetchModelsDevCatalog();

		const path = join(fakeHome, ".cast", "cache", "models-dev.json");
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(path, old, old);

		fetchImpl = async () => {
			throw new Error("network down");
		};
		const catalog = await fetchModelsDevCatalog();
		expect(catalog).toEqual(CATALOG_FIXTURE);
	});

	it("returns undefined (not a throw) with no cache and no reachable network", async () => {
		fetchImpl = async () => {
			throw new Error("network down");
		};
		await expect(fetchModelsDevCatalog()).resolves.toBeUndefined();
	});

	it("returns undefined (not a throw) on a non-2xx response", async () => {
		fetchImpl = async () => new Response("not found", { status: 404 });
		await expect(fetchModelsDevCatalog()).resolves.toBeUndefined();
	});
});
