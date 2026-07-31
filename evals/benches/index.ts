/**
 * Bench registry — one entry per subdirectory under evals/benches/. This is
 * the single source of truth `run.ts`'s `--bench`/`--list` and `docs/eval-methodology.md`
 * both describe from: static benches contribute a fixed case list, generated
 * benches contribute fixed behavioral contracts.
 */

import type { EvalCase } from "../lib/runner.ts";
import { chainCases } from "./behavior/chain/cases.ts";
import { coreCases } from "./behavior/core/cases.ts";

export interface Bench {
	id: string;
	description: string;
	/** Fixed, hand-authored cases. */
	cases: EvalCase[];
}

export const BENCHES: Bench[] = [
	{
		id: "behavior",
		description: "Real-agent behavioral contracts: tool traces, mode transitions, and grounded file changes.",
		cases: [...coreCases, ...chainCases],
	},
];

/**
 * The default is the complete behavior suite.
 */
export const DEFAULT_BENCH_IDS = ["behavior"];

export function findBench(id: string): Bench | undefined {
	return BENCHES.find((b) => b.id === id);
}
