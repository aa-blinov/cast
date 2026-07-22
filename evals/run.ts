#!/usr/bin/env node --import tsx

/**
 * Eval runner CLI.
 *
 * Usage:
 *   node --import tsx evals/run.ts [options]
 *
 * Options:
 *   --model, -m <model>    Model to use (required)
 *   --bench <id[,id...]>   Run only these benches (see evals/benches/, --list to enumerate)
 *   --cases, -c <filter>   Further filter to cases matching this id prefix
 *   --verbose, -v          Show per-case output
 *   --save, -s <path>      Save results to JSON file
 *   --list                 List available benches and cases
 *   --trace <file|latest>  Troubleshoot a recorded run — see --case
 */

import { resolve } from "node:path";
import { BENCHES, DEFAULT_BENCH_IDS, findBench } from "./benches/index.ts";
import { cleanupFixtures } from "./lib/fixtures.ts";
import { printHistory, recordCompare, recordCompareRepeated, recordRun } from "./lib/results.ts";
import {
	compareModels,
	compareModelsRepeated,
	type EvalCase,
	printCompareReport,
	printRepeatedCompareReport,
	printReport,
	type RunnerOptions,
	runSuite,
	saveCompareResults,
	saveResults,
} from "./lib/runner.ts";
import { listCaseIds, printTrace, resolveRunFile } from "./lib/trace-view.ts";

// Fixture files live under a per-process temp dir (see evals/lib/fixtures.ts) — wipe
// it on every exit path (success, --list, error, Ctrl+C) so runs don't leave
// garbage behind in /tmp.
process.on("exit", cleanupFixtures);

// ============================================================================
// CLI
// ============================================================================

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	let model: string | undefined;
	let compareList: string | undefined;
	let provider: string | undefined;
	let persona: string | undefined;
	let benchFilter: string[] | undefined;
	let caseFilter: string | undefined;
	let verbose = false;
	let savePath: string | undefined;
	let listOnly = false;
	let historyOnly = false;
	let concurrency = 10;
	let generateCount = 0;
	let generateSeed = 1;
	let generateSourceDir: string | undefined;
	let repeat = 1;
	let traceFile: string | undefined;
	let traceCaseId: string | undefined;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--model":
			case "-m":
				model = args[++i];
				break;
			case "--compare":
				compareList = args[++i];
				break;
			case "--provider":
			case "-p":
				provider = args[++i];
				break;
			case "--persona":
			case "-P":
				persona = args[++i];
				break;
			case "--bench":
			case "-b":
				benchFilter = (args[++i] ?? "")
					.split(",")
					.map((b) => b.trim())
					.filter(Boolean);
				break;
			case "--cases":
			case "-c":
				caseFilter = args[++i];
				break;
			case "--verbose":
			case "-v":
				verbose = true;
				break;
			case "--save":
			case "-s":
				savePath = args[++i];
				break;
			case "--concurrency":
			case "-j":
				concurrency = parseInt(args[++i] ?? "10", 10);
				break;
			case "--generate":
			case "-g":
				generateCount = parseInt(args[++i] ?? "0", 10);
				break;
			case "--seed":
				generateSeed = parseInt(args[++i] ?? "1", 10);
				break;
			case "--source-dir":
				generateSourceDir = args[++i];
				break;
			case "--repeat":
			case "-r":
				repeat = parseInt(args[++i] ?? "1", 10);
				break;
			case "--list":
				listOnly = true;
				break;
			case "--history":
				historyOnly = true;
				break;
			case "--trace":
				traceFile = args[++i];
				break;
			case "--case":
				traceCaseId = args[++i];
				break;
			case "--help":
			case "-h":
				printHelp();
				return;
		}
	}

	if (historyOnly) {
		printHistory();
		return;
	}

	if (traceFile) {
		let filePath: string;
		try {
			filePath = resolveRunFile(traceFile);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
		if (!traceCaseId) {
			console.log(`Cases in ${filePath}:\n`);
			for (const id of listCaseIds(filePath)) console.log(`  ${id}`);
			console.log(`\nPass --case <id> to see its full turn-by-turn trace.`);
			console.log(`Add -m <model> to narrow a --compare file down to one model's attempt(s).`);
			return;
		}
		printTrace(filePath, traceCaseId, model);
		return;
	}

	// Which benches to pull cases from — explicit --bench, or every static
	// (non-generated) bench by default so a plain run stays hand-authored-only
	// unless asked otherwise.
	const benchIds = benchFilter ?? DEFAULT_BENCH_IDS;
	const cases: EvalCase[] = [];
	for (const id of benchIds) {
		const bench = findBench(id);
		if (!bench) {
			console.error(`Unknown bench: ${id}`);
			console.error(`Available benches: ${BENCHES.map((b) => b.id).join(", ")}`);
			process.exit(1);
		}
		if (bench.cases) cases.push(...bench.cases);
	}

	// The "mutation" bench is generated, not static — pulled in by an explicit
	// --generate/-g count (works regardless of --bench, for backward
	// compatibility), or by naming it via --bench with a sensible default
	// count so `--bench mutation` alone isn't a silent no-op.
	const wantsMutation = generateCount > 0 || benchIds.includes("mutation");
	if (wantsMutation) {
		const mutationBench = findBench("mutation")!;
		const count = generateCount > 0 ? generateCount : 10;
		cases.push(...mutationBench.generate!({ count, seed: generateSeed, sourceDir: generateSourceDir }));
	}

	if (listOnly) {
		console.log("Available benches (see evals/benches/<id>/, or docs/eval-methodology.md):\n");
		for (const bench of BENCHES) {
			const note = bench.generate ? " [generated — needs --generate/-g, or a default applies via --bench]" : "";
			console.log(`  ${bench.id.padEnd(12)} ${bench.description}${note}`);
		}
		console.log(`\nCases in the current selection (${benchIds.join(", ")}${wantsMutation ? ", mutation" : ""}):\n`);
		for (const c of cases) {
			console.log(`  ${c.id.padEnd(25)} ${c.description}`);
		}
		console.log(`\nTotal: ${cases.length} cases`);
		if (!wantsMutation) {
			console.log(`(add --generate <n>, or --bench mutation, to also list freshly-generated mutation cases)`);
		}
		return;
	}

	if (!model && !compareList) {
		console.error("Error: --model or --compare is required");
		console.error("Usage: node --import tsx evals/run.ts -m <model> [-v] [-s results.json]");
		console.error("       node --import tsx evals/run.ts --compare <model1,model2,...> [-v] [-s results.json]");
		process.exit(1);
	}

	// Further filter by case id prefix, on top of the bench selection
	let filteredCases = cases;
	if (caseFilter) {
		filteredCases = cases.filter((c) => c.id.startsWith(caseFilter));
		if (filteredCases.length === 0) {
			console.error(`No cases match filter: ${caseFilter}`);
			console.error("Use --list to see available benches and cases.");
			process.exit(1);
		}
	}

	// Set PROVIDER_BASE_URL and PROVIDER_API_KEY if not set
	if (!process.env.PROVIDER_BASE_URL) {
		process.env.PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
	}

	const cwd = resolve(".");

	if (compareList) {
		const models = compareList
			.split(",")
			.map((m) => m.trim())
			.filter(Boolean);
		if (models.length < 2) {
			console.error("Error: --compare needs at least 2 comma-separated models");
			process.exit(1);
		}

		console.log(
			`\nComparing ${filteredCases.length} eval cases across ${models.length} models: ${models.join(", ")}${provider ? ` (provider: ${provider})` : ""}${persona ? ` (persona: ${persona})` : ""}${repeat > 1 ? ` (${repeat} runs/case)` : ""} (concurrency: ${concurrency})\n`,
		);

		// repeat>1 always routes through the repeated-compare path — a
		// single-model repeated run is just that path with a 1-element model
		// list, so there's no separate "repeated single run" implementation to
		// keep in sync.
		if (repeat > 1) {
			const compare = await compareModelsRepeated(filteredCases, models, {
				cwd,
				verbose,
				concurrency,
				provider,
				persona,
				repeat,
			});
			printRepeatedCompareReport(compare);

			const recordedPath = recordCompareRepeated(compare, caseFilter);
			console.log(`Recorded: ${recordedPath}`);

			if (Object.values(compare.suites).some((s) => s.casesPassed < s.casesTotal)) {
				process.exit(1);
			}
			return;
		}

		const compare = await compareModels(filteredCases, models, { cwd, verbose, concurrency, provider, persona });
		printCompareReport(compare);

		const recordedPath = recordCompare(compare, caseFilter);
		console.log(`Recorded: ${recordedPath}`);
		if (savePath) {
			saveCompareResults(compare, savePath);
			console.log(`Results also saved to: ${savePath}`);
		}

		if (Object.values(compare.suites).some((s) => s.failed > 0)) {
			process.exit(1);
		}
		return;
	}

	console.log(
		`\nRunning ${filteredCases.length} eval cases with model: ${model}${provider ? ` (provider: ${provider})` : ""}${persona ? ` (persona: ${persona})` : ""}${repeat > 1 ? ` (${repeat} runs/case)` : ""} (concurrency: ${concurrency})\n`,
	);

	if (repeat > 1) {
		const compare = await compareModelsRepeated(filteredCases, [model!], {
			cwd,
			verbose,
			concurrency,
			provider,
			persona,
			repeat,
		});
		printRepeatedCompareReport(compare);

		const recordedPath = recordCompareRepeated(compare, caseFilter);
		console.log(`Recorded: ${recordedPath}`);

		if (compare.suites[model!]!.casesPassed < compare.suites[model!]!.casesTotal) {
			process.exit(1);
		}
		return;
	}

	const options: RunnerOptions & { concurrency: number } = {
		model: model!,
		cwd,
		verbose,
		concurrency,
		provider,
		persona,
	};

	const suite = await runSuite(filteredCases, options);

	printReport(suite);

	const recordedPath = recordRun(suite, caseFilter);
	console.log(`\nRecorded: ${recordedPath}`);
	if (savePath) {
		saveResults(suite, savePath);
		console.log(`Results also saved to: ${savePath}`);
	}

	// Exit with failure if any case failed
	if (suite.failed > 0) {
		process.exit(1);
	}
}

function printHelp(): void {
	console.log(`
eval-runner — Run agent eval cases and track regressions

Usage:
  node --import tsx evals/run.ts -m <model> [options]
  node --import tsx evals/run.ts --compare <model1,model2,...> [options]

Options:
  --model, -m <model>    Model to use (required unless --compare)
  --compare <m1,m2,...>  Run the same cases once per model, same harness — a side-by-side
                          pass/fail + turns + duration table instead of one model's summary.
  --provider, -p <name>  Provider entry from settings providers[] (default: active provider)
  --persona, -P <name>   Persona system prompt to run with (default: senior)
  --bench, -b <id,...>   Only run these benches (default: every static bench — see --list).
                          Benches live under evals/benches/<id>/; see docs/eval-methodology.md.
  --cases, -c <filter>   Further filter the selected benches' cases to this id prefix
  --generate, -g <n>     Pull n fresh cases from the "mutation" bench (mutate.ts) — real files
                          from --source-dir, one mechanical bug each. Implies the mutation bench
                          even without --bench mutation; combine with --bench mutation -c mutate
                          to run ONLY the generated ones.
  --seed <n>             Seed for --generate (default: 1) — same seed, same mutations.
  --source-dir <path>    Source dir --generate pulls files from (default: src/core).
  --repeat, -r <n>       Run each case n times (fresh session each attempt) instead of once —
                          reports N/n per case plus a ⚠ when attempts disagreed, so a real
                          effect can be told apart from a one-off flake. Works with -m or
                          --compare (a single model with --repeat is compareModelsRepeated
                          with one model, same report shape).
  --verbose, -v          Show per-case output
  --concurrency, -j <n>  Parallel case execution (default: 10)
  --save, -s <path>      Also save results to this exact JSON path (every run is auto-recorded
                          to evals/results/runs/ regardless — this is an extra, fixed-path copy)
  --list                 List available benches and their cases
  --history              Show recorded runs from evals/results/index.json
  --trace <file|latest>  Troubleshoot a recorded run: full turn-by-turn record (thinking,
                          commentary, tool args + actual tool output) for one case. <file> is
                          "latest", a path, or a bare filename under evals/results/runs/. Omit
                          --case to list the case ids in that file first. Add -m <model> to
                          narrow a --compare file down to one model's attempt(s).
  --case <id>            Case id to show with --trace
  --help, -h             Show this help

Environment variables:
  PROVIDER_BASE_URL      OpenAI-compatible endpoint (default: OpenRouter)
  PROVIDER_API_KEY       API key

Examples:
  # Run every static bench (basic + hashline)
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v

  # Run just one bench
  node --import tsx evals/run.ts -m gpt-4o --bench hashline -v

  # Save results for regression tracking (also auto-recorded either way)
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v -s evals/results/latest.json

  # Compare two models on the same bench, same harness
  node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench hashline -v

  # 20 fresh auto-generated edit-precision cases from src/core, compared across models
  node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench mutation -g 20 -v

  # Same compare, but 3 attempts per case per model — tells a real gap from noise
  node --import tsx evals/run.ts --compare mimo-v2.5,mimo-v2.5-pro --bench mutation -g 15 --seed 7 -r 3 -v

  # List available benches and cases (pass --generate too to preview generated ones)
  node --import tsx evals/run.ts --list

  # What's been run before
  node --import tsx evals/run.ts --history

  # Troubleshoot: list the cases in the latest recorded run
  node --import tsx evals/run.ts --trace latest

  # Full turn-by-turn trace for one case (thinking, tool args, actual tool output)
  node --import tsx evals/run.ts --trace latest --case glob-then-grep

  # Same, narrowed to one model from a --compare file
  node --import tsx evals/run.ts --trace latest --case glob-then-grep -m mimo-v2.5-pro
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
