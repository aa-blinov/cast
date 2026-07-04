import type { ModelInfo } from "./config.ts";

/**
 * Populated whenever /v1/models has been fetched (selectModel, or the
 * background prefetch in main()). Empty until then, in which case the
 * completer below is a no-op. Kept behind get/set instead of a plain export
 * because ES module bindings for `let` exports can't be reassigned from
 * importing modules.
 */
let modelsCache: ModelInfo[] = [];

export function getModelsCache(): ModelInfo[] {
	return modelsCache;
}

export function setModelsCache(models: ModelInfo[]): void {
	modelsCache = models;
}
