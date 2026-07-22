/**
 * Auto-generated edit-precision cases — see mutate.ts (same directory) for
 * the mutation engine and its port-of-oh-my-pi provenance. Unlike the
 * hand-authored cases in benches/hashline, benches/basic, these are produced
 * fresh from real files in this repo (`src/core` by default) every time
 * `generateMutationCases` runs — same idea as their React-file corpus, just
 * dogfooding cast's own source instead of vendoring someone else's.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fixturePath, writeFixture } from "../../lib/fixtures.ts";
import type { EvalCase } from "../../lib/runner.ts";
import { formattedEqual } from "./format-compare.ts";
import { mutateOne } from "./mutate.ts";

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

export interface GenerateOptions {
	/** How many mutation cases to produce. */
	count: number;
	/** Directory to pull source files from, relative to repo root. Default: src/core. */
	sourceDir?: string;
	/** Deterministic — same seed always produces the same set of cases. */
	seed?: number;
}

/**
 * Generates up to `count` mutation cases by trying files in `sourceDir` in a
 * seeded-shuffled order, skipping any file with no mutable sites (e.g. pure
 * type-only files with no comparisons/booleans/plausible numeric literals).
 * Stops once `count` is reached or every candidate file has been tried.
 */
export function generateMutationCases(opts: GenerateOptions): EvalCase[] {
	const sourceDir = opts.sourceDir ?? "src/core";
	const seed = opts.seed ?? 1;
	const repoRoot = join(import.meta.dirname, "..", "..", "..");
	const absSourceDir = join(repoRoot, sourceDir);

	const files = listTsFiles(absSourceDir).filter((f) => statSync(f).size < 40_000); // skip unwieldy giants
	// Seeded shuffle (Fisher-Yates with the same mulberry32-style stepper as
	// mutate.ts's site picker) so which files get used is reproducible too,
	// not just which site within a file.
	let shuffleState = seed;
	const shuffled = [...files];
	for (let i = shuffled.length - 1; i > 0; i--) {
		shuffleState = (shuffleState * 48271) % 2147483647;
		const j = shuffleState % (i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}

	const cases: EvalCase[] = [];
	for (let i = 0; i < shuffled.length && cases.length < opts.count; i++) {
		const filePath = shuffled[i]!;
		const original = readFileSync(filePath, "utf-8");
		const mutation = mutateOne(original, filePath, seed + i);
		if (!mutation) continue; // no mutable sites in this file — try the next one

		const relPath = relative(repoRoot, filePath);
		const fileName = basename(filePath);
		const id = `mutate-${mutation.info.category}-${fileName.replace(/\.ts$/, "")}-${seed + i}`;

		cases.push({
			id,
			description: `[${mutation.info.category}] ${relPath}:${mutation.info.lineNumber} — ${mutation.info.describe()}`,
			prompt:
				`${fixturePath(id, fileName)} has one bug: ${mutation.info.describe()} ` +
				`Find it and fix it — restore the original correct value. Do not change anything else in the file, ` +
				`and do not add comments explaining the fix.`,
			timeout: 180_000,
			setup: () => void writeFixture(id, { [fileName]: mutation.mutatedSource }),
			expect: {
				noErrors: true,
				verify: () => {
					const actual = readFileSync(fixturePath(id, fileName), "utf-8");
					if (formattedEqual(actual, original)) return undefined;
					return (
						`content doesn't match the original after formatting — mutated line ${mutation.info.lineNumber} was ` +
						`"${mutation.info.mutatedLine.trim()}", expected back to "${mutation.info.originalLine.trim()}"`
					);
				},
			},
		});
	}

	return cases;
}
