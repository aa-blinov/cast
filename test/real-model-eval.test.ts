import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveRealModelEval } from "../scripts/real-model-eval.ts";

describe("real-model CI eval", () => {
	it("does nothing unless the repository explicitly enables real-model requests", () => {
		expect(resolveRealModelEval({})).toEqual({ kind: "skip", reason: "not enabled" });
	});

	it("requires credentials and a model when enabled", () => {
		expect(() => resolveRealModelEval({ CAST_REAL_EVALS_ENABLED: "true" })).toThrow(
			"CAST_EVAL_API_KEY and CAST_EVAL_MODEL are required",
		);
		expect(() => resolveRealModelEval({ CAST_REAL_EVALS_ENABLED: "true", CAST_EVAL_API_KEY: "secret" })).toThrow(
			"CAST_EVAL_API_KEY and CAST_EVAL_MODEL are required",
		);
	});

	it("passes provider credentials only through the child environment", () => {
		const result = resolveRealModelEval({
			CAST_REAL_EVALS_ENABLED: "true",
			CAST_EVAL_API_KEY: "secret-value",
			CAST_EVAL_MODEL: "provider/model:variant",
			CAST_EVAL_PROVIDER_URL: "https://provider.example/v1",
			CAST_EVAL_OUTPUT: "eval-report.json",
		});

		expect(result).toMatchObject({
			kind: "run",
			args: [
				"--import",
				"tsx",
				"evals/run.ts",
				"-m",
				"provider/model:variant",
				"--bench",
				"behavior",
				"--cases",
				"required-read-tool",
				"--repeat",
				"3",
				"--concurrency",
				"1",
				"--save",
				"eval-report.json",
			],
			env: {
				PROVIDER_API_KEY: "secret-value",
				PROVIDER_BASE_URL: "https://provider.example/v1",
			},
		});
		if (result.kind !== "run") throw new Error("expected eval to run");
		expect(result.args.join(" ")).not.toContain("secret-value");
	});

	it("runs as an opt-in CI job and keeps forked pull requests away from secrets", () => {
		const workflow = parse(readFileSync(join(process.cwd(), ".github/workflows/real-model-eval.yml"), "utf8")) as {
			on: Record<string, unknown>;
			jobs: Record<
				string,
				{
					if: string;
					steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
				}
			>;
		};
		const job = workflow.jobs.evaluate;
		const runStep = job.steps.find((step) => step.name === "Run repeated real-model behavior check");

		expect(workflow.on.workflow_dispatch).toBeDefined();
		expect(job.if).toContain("vars.CAST_REAL_EVALS_ENABLED");
		expect(job.if).toContain("head.repo.fork == false");
		expect(runStep?.run).toBe("node --import tsx scripts/real-model-eval.ts");
		expect(runStep?.env?.CAST_EVAL_API_KEY).toBe("$" + "{{ secrets.CAST_EVAL_API_KEY }}");
		expect(runStep?.env?.CAST_EVAL_MODEL).toContain("vars.CAST_EVAL_MODEL");
	});
});
