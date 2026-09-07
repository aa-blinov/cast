import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/**
 * Third-party, community-curated catalog of model metadata (pricing,
 * context/output limits, reasoning params) across many providers —
 * https://models.dev/api.json. Cast's own KNOWN_MODEL_CONTEXT_WINDOWS table
 * (config.ts) only covers the handful of models someone's manually verified
 * against official docs; this fills gaps for everything else, at the cost of
 * being crowd-sourced rather than authoritative — a model can appear under
 * several resellers with disagreeing numbers, or not at all (verified: the
 * official api.minimax.io provider itself isn't listed, only Fireworks/W&B/
 * CrossModel reselling the same model with three different context values).
 */
export interface ModelsDevReasoningOption {
	type: "toggle" | "effort";
	values?: string[];
}

interface ModelsDevModel {
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	limit?: { context?: number; output?: number };
}
interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

export interface ModelsDevModelMetadata {
	reasoning?: boolean;
	reasoningOptions?: ModelsDevReasoningOption[];
	contextWindow?: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = "https://models.dev/api.json";

function cachePath(): string {
	const dir = join(homedir(), ".cast", "cache");
	mkdirSync(dir, { recursive: true });
	return join(dir, "models-dev.json");
}

function readCache(path: string): ModelsDevCatalog | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as ModelsDevCatalog;
	} catch {
		return undefined;
	}
}

/**
 * Fetches the catalog, using a 24h-old disk cache when fresh (metadata like
 * this changes rarely — no need to hit the network on every startup). Never
 * throws: startup must not hard-fail because a third-party metadata site is
 * down. Falls back to a stale cache on fetch failure, then to undefined
 * (callers already have their own next fallback — see config.ts's
 * lookupContextWindow chain).
 */
export async function fetchModelsDevCatalog(): Promise<ModelsDevCatalog | undefined> {
	const path = cachePath();
	try {
		const stat = statSync(path);
		if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
			const cached = readCache(path);
			if (cached) return cached;
		}
	} catch {
		// No cache yet — fall through to fetch.
	}

	try {
		const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const text = await res.text();
		const catalog = JSON.parse(text) as ModelsDevCatalog;
		writeFileSync(path, text, "utf-8");
		return catalog;
	} catch {
		return readCache(path);
	}
}

/**
 * Matches a model id against every provider's model list in the catalog
 * (case-insensitive, substring both ways — model ids get provider-specific
 * prefixes like `accounts/fireworks/models/` or suffixes like `-highspeed`).
 * When the same model shows up under multiple resellers with different
 * numbers (observed for minimax-m3: 262k/512k/1024k, none matching the
 * vendor's own advertised 1M), returns the *minimum* — an underestimate
 * just compacts a bit early, an overestimate risks a real context-overflow
 * error from the provider.
 */
export function lookupContextWindowFromCatalog(modelId: string, catalog: ModelsDevCatalog): number | undefined {
	const needle = modelId.toLowerCase();
	let min: number | undefined;
	for (const provider of Object.values(catalog)) {
		for (const [key, model] of Object.entries(provider.models ?? {})) {
			const k = key.toLowerCase();
			if (!k.includes(needle) && !needle.includes(k)) continue;
			const context = model.limit?.context;
			if (typeof context === "number" && context > 0) {
				min = min === undefined ? context : Math.min(min, context);
			}
		}
	}
	return min;
}

/**
 * Looks up capability metadata independently from the provider endpoint. The
 * catalog can contain the same model under several resellers, so a positive
 * reasoning capability wins if any matching entry advertises it.
 */
export function lookupModelMetadataFromCatalog(
	modelId: string,
	catalog: ModelsDevCatalog,
): ModelsDevModelMetadata | undefined {
	const needle = modelId.toLowerCase();
	const exact: ModelsDevModel[] = [];
	const fuzzy: ModelsDevModel[] = [];

	for (const provider of Object.values(catalog)) {
		for (const [key, model] of Object.entries(provider.models ?? {})) {
			const normalizedKey = key.toLowerCase();
			if (normalizedKey === needle) exact.push(model);
			else if (normalizedKey.includes(needle) || needle.includes(normalizedKey)) fuzzy.push(model);
		}
	}

	const matches = exact.length > 0 ? exact : fuzzy;
	if (matches.length === 0) return undefined;

	const reasoning = matches.some((model) => model.reasoning === true)
		? true
		: matches.some((model) => model.reasoning === false)
			? false
			: undefined;
	const contextWindow = lookupContextWindowFromCatalog(modelId, catalog);
	const reasoningOptions = matches.find((model) => model.reasoning_options?.length)?.reasoning_options;

	if (reasoning === undefined && reasoningOptions === undefined && contextWindow === undefined) return undefined;
	return { reasoning, reasoningOptions, contextWindow };
}

/**
 * Per-million-token prices for a model, from the catalog.
 *
 * The provider's own `usage.cost` is the authority when it sends one (only
 * some gateways do — OpenRouter, mainly). Everything else showed $0.00: on a
 * real store, 524 of 542 sessions with token counts had zero cost recorded,
 * including 453 on a model whose prices are right here in the catalog.
 *
 * ponytail: base tier only — the catalog also carries context-tier pricing
 * (over 200k tokens costs double on some models); add tier selection if the
 * number needs to be exact rather than close.
 */
export function lookupCostFromCatalog(
	modelId: string,
	catalog: ModelsDevCatalog,
): { input: number; output: number; cacheRead: number } | undefined {
	// Exact id match only. The substring matching the context-window lookup
	// uses is fine for a limit — it takes the minimum, so a wrong match is
	// merely conservative — but this is money: "gpt-5" matched a cheaper
	// gpt-5-* entry and priced 1M tokens at $0.09 instead of $2.47. An
	// unpriced model reports nothing, which is honest; a wrong price is not.
	// The same id appears under several resellers at different prices — one of
	// them free — so take the dearest of the exact matches. An estimate that
	// understates what a turn cost is worse than one that overstates it, and
	// the provider's own `usage.cost` overrides this whenever it sends one.
	const needle = modelId.toLowerCase();
	let dearest: { input: number; output: number; cacheRead: number } | undefined;
	for (const provider of Object.values(catalog)) {
		for (const [key, model] of Object.entries(provider.models ?? {})) {
			if (key.toLowerCase() !== needle) continue;
			const cost = (model as { cost?: { input?: number; output?: number; cache_read?: number } }).cost;
			if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number") continue;
			const candidate = { input: cost.input, output: cost.output, cacheRead: cost.cache_read ?? cost.input };
			if (!dearest || candidate.input + candidate.output > dearest.input + dearest.output) dearest = candidate;
		}
	}
	return dearest;
}

/** USD for one request, from cached catalog prices. Undefined when unpriced. */
export function estimateRequestCost(
	modelId: string,
	usage: { promptTokens: number; completionTokens: number; cacheReadTokens?: number },
): number | undefined {
	const catalog = readCache(cachePath());
	if (!catalog) return undefined;
	const price = lookupCostFromCatalog(modelId, catalog);
	if (!price) return undefined;
	const cacheRead = Math.min(usage.cacheReadTokens ?? 0, usage.promptTokens);
	const uncached = Math.max(0, usage.promptTokens - cacheRead);
	return (
		(uncached * price.input) / 1_000_000 +
		(cacheRead * price.cacheRead) / 1_000_000 +
		(usage.completionTokens * price.output) / 1_000_000
	);
}
