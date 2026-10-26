import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RealModelEvalInvocation =
	| { kind: "skip"; reason: string }
	| { kind: "run"; args: string[]; env: { PROVIDER_API_KEY: string; PROVIDER_BASE_URL: string } };

export function resolveRealModelEval(env: NodeJS.ProcessEnv): RealModelEvalInvocation {
	if (env.CAST_REAL_EVALS_ENABLED !== "true") return { kind: "skip", reason: "not enabled" };
	const model = env.CAST_EVAL_MODEL?.trim();
	const apiKey = env.CAST_EVAL_API_KEY?.trim();
	if (!model || !apiKey) throw new Error("CAST_EVAL_API_KEY and CAST_EVAL_MODEL are required when evals are enabled");

	const args = [
		"--import",
		"tsx",
		"evals/run.ts",
		"-m",
		model,
		"--bench",
		"behavior",
		"--cases",
		"required-read-tool",
		"--repeat",
		"3",
		"--concurrency",
		"1",
	];
	const output = env.CAST_EVAL_OUTPUT?.trim();
	if (output) args.push("--save", output);

	return {
		kind: "run",
		args,
		env: {
			PROVIDER_API_KEY: apiKey,
			PROVIDER_BASE_URL: env.CAST_EVAL_PROVIDER_URL?.trim() || "https://openrouter.ai/api/v1",
		},
	};
}

function main(): void {
	const invocation = resolveRealModelEval(process.env);
	if (invocation.kind === "skip") {
		console.log(`Real-model eval skipped: ${invocation.reason}. Set CAST_REAL_EVALS_ENABLED=true to enable it.`);
		return;
	}

	const child = spawn(process.execPath, invocation.args, {
		stdio: "inherit",
		env: { ...process.env, ...invocation.env },
	});
	child.once("error", (error) => {
		console.error(`Could not start real-model eval: ${error.message}`);
		process.exitCode = 1;
	});
	child.once("close", (code) => {
		process.exitCode = code ?? 1;
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
