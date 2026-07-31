import type { EvalCase } from "../../../lib/runner.ts";
import { allBehaviorCases } from "../chain/cases.ts";

/** Single-turn tool contracts. Multi-turn stateful workflows belong in ../chain/. */
const CORE_CASE_IDS = new Set([
	"required-read-tool",
	"direct-request-stays-build",
	"read-range-uses-offset-limit",
	"grep-argument-is-grounded",
	"glob-argument-is-grounded",
	"write-creates-parent-directories",
]);

export const coreCases: EvalCase[] = allBehaviorCases.filter((evalCase) => CORE_CASE_IDS.has(evalCase.id));
