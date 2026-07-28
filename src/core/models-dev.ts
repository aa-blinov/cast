import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerFetch } from "./config.ts";

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
interface ModelsDevModel {
	limit?: { context?: number; output?: number };
}
interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}
export type ModelsDevCatalog = Record<string, ModelsDevProvider>;

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
		const res = await providerFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(10_000) });
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
