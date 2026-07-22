/**
 * Bench registry — one entry per subdirectory under evals/benches/. This is
 * the single source of truth `run.ts`'s `--bench`/`--list` and `docs/eval-methodology.md`
 * both describe from: static benches contribute a fixed case list, generated
 * benches (currently just "mutation") build a fresh one per invocation from
 * `generate()` options.
 */

import type { EvalCase } from "../lib/runner.ts";
import { basicCases } from "./basic/cases.ts";
import { hashlineCases } from "./hashline/cases.ts";
import { type GenerateOptions, generateMutationCases } from "./mutation/cases.ts";

export interface Bench {
	id: string;
	description: string;
	/** Fixed, hand-authored cases — present on static benches. */
	cases?: EvalCase[];
	/** Builds a fresh case list per invocation — present on generated benches. */
	generate?: (opts: GenerateOptions) => EvalCase[];
}

export const BENCHES: Bench[] = [
	{
		id: "basic",
		description: "Fundamental agent capabilities (file ops, tool use) — hand-authored, grounded checks.",
		cases: basicCases,
	},
	{
		id: "hashline",
		description: "cast's hashline edit format — hand-authored regressions for patterns that broke in the wild.",
		cases: hashlineCases,
	},
	{
		id: "mutation",
		description:
			"Auto-generated edit-precision cases (oh-my-pi port): one mechanical AST bug injected into a real " +
			"src/ file, graded format-tolerantly. Needs --generate/-g (or a default is applied when selected via --bench).",
		generate: generateMutationCases,
	},
];

/** Benches included by default when neither --bench nor --generate is passed. */
export const DEFAULT_BENCH_IDS = BENCHES.filter((b) => b.cases).map((b) => b.id);

export function findBench(id: string): Bench | undefined {
	return BENCHES.find((b) => b.id === id);
}
