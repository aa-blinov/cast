/**
 * Format-tolerant grading for auto-generated mutation tasks — port of
 * oh-my-pi's approach (typescript-edit-benchmark/src/verify.ts): run both
 * the expected and actual file through the *same* formatter before
 * comparing, so the agent's own whitespace/quote-style choices never count
 * as a failure, only real content mismatches do.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const BIOME_BIN = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "biome");

/**
 * Format `content` via the project's own biome config. `extension` picks the
 * language; the synthetic `--stdin-file-path` just needs to match
 * biome.json's `files.includes` glob (`src/**\/*.ts`) for biome to act on it
 * in stdin mode — nothing needs to really exist at that path.
 */
export function formatWithBiome(content: string, extension = "ts"): string {
	const result = spawnSync(BIOME_BIN, ["format", `--stdin-file-path=src/__eval_mutation__.${extension}`], {
		input: content,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`biome format failed (exit ${result.status}): ${result.stderr}`);
	}
	return result.stdout;
}

/** True if `a` and `b` are equivalent once both are run through the same formatter. */
export function formattedEqual(a: string, b: string, extension = "ts"): boolean {
	return formatWithBiome(a, extension) === formatWithBiome(b, extension);
}
