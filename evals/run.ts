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
 *   --cases, -c <filter>   Filter to cases matching this id (comma-separated exact ids or prefixes)
 *   --verbose, -v          Show per-case output
 *   --save, -s <path>      Save results to JSON file
 *   --list                 List available benches and cases
 *   --trace <file|latest>  Troubleshoot a recorded run — see --case
 *   --save-baseline        Save the run's result as a baseline (--baseline <name> to pick a custom one)
 *   --baseline <name>      Compare result against this saved baseline (default name = <bench>-<model>)
 *   --regression-threshold <pp>  Pass-rate drop (in pp) that counts as a regression (default: 5)
 *   --list-baselines       List all saved baselines
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BENCHES, DEFAULT_BENCH_IDS, findBench } from "./benches/index.ts";
import {
	compareToBaseline,
	formatDelta,
	listBaselineHistory,
	listBaselines,
	resolveBaseline,
	saveBaseline,
	toComparableSuiteResult,
} from "./lib/baseline.ts";
import { cleanupFixtures } from "./lib/fixtures.ts";
import {
	printHistory,
	recordCompare,
	recordCompareRepeated,
	recordRepeatedBaseline,
	recordRun,
} from "./lib/results.ts";
import {
	compareModels,
	compareModelsRepeated,
	type EvalCase,
	printCompareReport,
	printRepeatedCompareReport,
	printReport,
	type ProviderConnection,
	type RepeatedSuiteResult,
	type RunnerOptions,
	runSuite,
	saveCompareResults,
	saveResults,
} from "./lib/runner.ts";
import { buildScoreboardEntry, mergeScoreboardEntry, readScoreboard, upsertScoreboard } from "./lib/scoreboard.ts";
import { listCaseIds, printTrace, resolveRunFile } from "./lib/trace-view.ts";

// Fixture files live under a per-process temp dir (see evals/lib/fixtures.ts) — wipe
// it on every exit path (success, --list, error, Ctrl+C) so runs don't leave
// garbage behind in /tmp.
process.on("exit", cleanupFixtures);

// ============================================================================
// CLI
// ============================================================================

/**
 * Writes/updates one scoreboard entry per model in `compare` — see
 * `evals/lib/scoreboard.ts` for why this only ever runs from a --repeat
 * result (validated before either call site below is reached), never a
 * single run.
 *
 * `isFullRun` (no `--cases` filter) fully replaces each model's entry;
 * otherwise (a cherry-picked rerun — e.g. a couple of cases that flaked on a
 * network error) merges the fresh per-case results into whatever's already
 * there, so the rest of the suite's data isn't lost. A partial rerun for a
 * model with no prior entry has nothing to merge into and is rejected —
 * run the full suite once first.
 */
function updateScoreboard(
	compare: Parameters<typeof buildScoreboardEntry>[0],
	benchIds: string[],
	isFullRun: boolean,
	targets?: Record<string, { model: string; provider?: string }>,
): void {
	const existingAll = readScoreboard();
	for (const modelName of compare.models) {
		const fresh = buildScoreboardEntry(compare, modelName, benchIds);
		// `--compare provider:model` keys `compare.models`/`compare.suites` by the
		// raw "provider:model" entry (needed to resolve each model's connection
		// during the run) — but the scoreboard should key by the bare model name
		// only, so the same model always lands in one row regardless of which
		// provider ran it.
		const cleanName = targets?.[modelName]?.model ?? modelName;
		fresh.model = cleanName;
		// Entries written before `results` existed (aggregates only, no raw
		// per-case data) can't be merged into — treat them the same as no
		// entry at all rather than crashing on a missing array.
		const rawExisting = existingAll[cleanName];
		const existing = rawExisting && Array.isArray(rawExisting.results) ? rawExisting : undefined;
		if (!isFullRun && !existing) {
			console.error(
				`--scoreboard --cases has no existing (mergeable) entry for "${cleanName}" — run the full suite once first.`,
			);
			process.exit(1);
		}
		const entry = mergeScoreboardEntry(existing, fresh, isFullRun);
		const path = upsertScoreboard(entry);
		const pct = (entry.score * 100).toFixed(1);
		const badge = entry.certified ? " ✓ certified" : "";
		const scope = isFullRun ? "" : ` (merged ${fresh.results.length}/${entry.casesTotal} cases)`;
		console.log(`Scoreboard updated (${modelName}): ${path} — ${pct}% (${entry.casesPassed}/${entry.casesTotal})${badge}${scope}`);
	}
}

/**
 * `--baseline <name>` comparison for a `--repeat` result — the non-repeat
 * path already had this (see `compareToBaseline` below `main`); repeat runs
 * only had `--save-baseline` wired, never the compare-against-existing-name
 * side, so a `--repeat --baseline x` run silently did nothing. Uses
 * `toComparableSuiteResult` (baseline.ts) to adapt the repeated shape without
 * faking full `RunResult` objects. Returns whether a regression was flagged,
 * for the caller's exit code.
 */
function checkRepeatedBaseline(
	suite: RepeatedSuiteResult,
	benchIds: string[],
	name: string,
	threshold: number,
	alpha: number,
): boolean {
	if (benchIds.length !== 1) {
		console.error(`--baseline with --repeat requires exactly one --bench (got ${benchIds.length}: ${benchIds.join(", ")})`);
		process.exit(1);
	}
	const resolved = resolveBaseline(name, suite.model);
	if (!resolved) {
		console.error(`No baseline named "${name}" found. Run with --save-baseline first, or check --list-baselines.`);
		process.exit(1);
	}
	const delta = compareToBaseline(toComparableSuiteResult(suite), benchIds[0]!, resolved.name, { threshold, alpha });
	if (!delta) {
		console.error(`Baseline "${resolved.name}" could not be compared — did you save it?`);
		process.exit(1);
	}
	console.log("");
	console.log("=".repeat(60));
	console.log(`REGRESSION CHECK (${suite.model})`);
	console.log("=".repeat(60));
	console.log(formatDelta(delta, threshold));
	if (delta.hasRegression) {
		if (delta.significance.sampleSizeSufficient && delta.significance.isSignificant) {
			console.log(`\n✗ Statistically significant regression detected (p=${delta.significance.pValue.toFixed(4)} < α=${alpha})`);
		} else {
			console.log(`\n✗ Regression detected (threshold: ${threshold * 100}pp)`);
		}
	}
	return delta.hasRegression;
}

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
	let rateLimitDelayMs = 0;
	let repeat = 1;
	let traceFile: string | undefined;
	let traceCaseId: string | undefined;
	let saveBaselineFlag = false;
	let baselineName: string | undefined;
	let regressionThreshold = 0.05;
	let significanceAlpha = 0.05;
	let listBaselinesFlag = false;
	let listBaselineHistoryName: string | undefined;
	let scoreboardFlag = false;

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
			case "--rate-limit-delay":
				rateLimitDelayMs = parseInt(args[++i] ?? "0", 10);
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
			case "--save-baseline":
				saveBaselineFlag = true;
				break;
			case "--baseline":
				baselineName = args[++i];
				break;
			case "--regression-threshold":
				regressionThreshold = parseFloat(args[++i] ?? "0.05");
				break;
			case "--significance-alpha":
				significanceAlpha = parseFloat(args[++i] ?? "0.05");
				break;
			case "--list-baselines":
				listBaselinesFlag = true;
				break;
			case "--baseline-history":
				listBaselineHistoryName = args[++i] ?? "";
				break;
			case "--scoreboard":
				scoreboardFlag = true;
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

	if (listBaselinesFlag) {
		const baselines = listBaselines();
		if (baselines.length === 0) {
			console.log("No saved baselines yet — run with --save-baseline first.");
			return;
		}
		console.log(`\n${baselines.length} saved baseline(s):\n`);
		for (const b of baselines) {
			const modelsStr = b.model;
			const benchStr = b.bench;
			const rate = `${b.passed}/${b.total} (${(b.passRate * 100).toFixed(1)}%)`;
			const commitStr = b.commit ? ` @${b.commit}` : "";
			console.log(`  ${b.name.padEnd(28)} ${benchStr.padEnd(12)} ${modelsStr.padEnd(14)} ${rate}${commitStr}`);
		}
		console.log();
		return;
	}

	if (listBaselineHistoryName !== undefined) {
		const history = listBaselineHistory(listBaselineHistoryName);
		if (history.length === 0) {
			console.log(`No history for "${listBaselineHistoryName}". Run --save-baseline at least once to record one.`);
			return;
		}
		console.log(`\nHistory for "${listBaselineHistoryName}" (${history.length} snapshot(s), newest first):\n`);
		console.log("  timestamp                   pass rate    passed/total  commit");
		for (const b of history) {
			const ts = b.timestamp.replace("T", " ").replace(/\..+$/, "").replace(/Z$/, "");
			const rate = `${(b.passRate * 100).toFixed(1)}%`;
			const commit = b.commit ?? "-";
			console.log(`  ${ts.padEnd(26)}${rate.padStart(8)}    ${`${b.passed}/${b.total}`.padStart(11)}   ${commit}`);
		}
		console.log();
		console.log(`  (use --baseline ${listBaselineHistoryName} to compare against the latest)`);
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

	// Which benches to pull cases from — explicit --bench, or the behavior
	// contracts by default.
	const benchIds = benchFilter ?? DEFAULT_BENCH_IDS;
	const cases: EvalCase[] = [];
	for (const id of benchIds) {
		const bench = findBench(id);
		if (!bench) {
			console.error(`Unknown bench: ${id}`);
			console.error(`Available benches: ${BENCHES.map((b) => b.id).join(", ")}`);
			process.exit(1);
		}
		cases.push(...bench.cases);
	}

	if (listOnly) {
		console.log("Available benches (see evals/benches/<id>/, or docs/eval-methodology.md):\n");
		for (const bench of BENCHES) console.log(`  ${bench.id.padEnd(12)} ${bench.description}`);
		console.log(`\nCases in the current selection (${benchIds.join(", ")}):\n`);
		for (const c of cases) {
			console.log(`  ${c.id.padEnd(25)} ${c.description}`);
		}
		console.log(`\nTotal: ${cases.length} cases`);
		return;
	}

	if (!model && !compareList) {
		console.error("Error: --model or --compare is required");
		console.error("Usage: node --import tsx evals/run.ts -m <model> [-v] [-s results.json]");
		console.error("       node --import tsx evals/run.ts --compare <model1,model2,...> [-v] [-s results.json]");
		process.exit(1);
	}

	// A single (or barely-repeated) stochastic run can't support a
	// certification claim — the scoreboard is only ever built from a
	// --repeat >= 3 result, matching the "run --repeat 3 before calling a
	// change a regression" convention (docs/eval-methodology.md). A
	// --cases-filtered run is allowed (e.g. rerunning a couple of cases that
	// flaked on a network error) but merges into an existing entry rather
	// than standing alone as the model's score — see updateScoreboard.
	if (scoreboardFlag && repeat < 3) {
		console.error("--scoreboard requires --repeat >= 3 (fewer attempts can't support a certification score)");
		process.exit(1);
	}

	// Further filter by case id, on top of the bench selection. Comma-separated:
	// each part matches either an exact id (cherry-pick a handful of unrelated
	// cases, e.g. after a partial network-error rerun) or a prefix (existing
	// behavior, e.g. "plan-" for every plan-mode case).
	let filteredCases = cases;
	if (caseFilter) {
		const filterParts = caseFilter
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
		filteredCases = cases.filter((c) => filterParts.some((f) => c.id === f || c.id.startsWith(f)));
		if (filteredCases.length === 0) {
			console.error(`No cases match filter: ${caseFilter}`);
			console.error("Use --list to see available benches and cases.");
			process.exit(1);
		}
	}

	// Capture provider credentials before switching HOME. The agent, bash, and
	// local MCP processes then inherit an isolated home and cannot touch the
	// developer's global ~/.cast while the runner still has explicit credentials.
	const settingsPath = join(homedir(), ".cast", "settings.json");
	const settings = (existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {}) as {
		providerUrl?: string;
		apiKey?: string;
		modelProvider?: string;
		providers?: Array<{ name: string; url: string; apiKey: string }>;
	};
	const providerConnections: Record<string, ProviderConnection> = Object.fromEntries(
		(settings.providers ?? []).map((entry) => [entry.name, { baseURL: entry.url, apiKey: entry.apiKey }]),
	);
	const envConnection =
		process.env.PROVIDER_BASE_URL && process.env.PROVIDER_API_KEY
			? { baseURL: process.env.PROVIDER_BASE_URL, apiKey: process.env.PROVIDER_API_KEY }
			: undefined;
	const selectedProvider = provider ?? (envConnection ? undefined : settings.modelProvider);
	const defaultConnection = selectedProvider
		? providerConnections[selectedProvider]
		: envConnection
			? envConnection
			: settings.providerUrl && settings.apiKey
				? { baseURL: settings.providerUrl, apiKey: settings.apiKey }
				: undefined;
	if (!defaultConnection && Object.keys(providerConnections).length === 0) {
		console.error("Eval settings need providerUrl/apiKey or at least one named provider in ~/.cast/settings.json");
		process.exit(1);
	}
	const originalHome = process.env.HOME;
	const evalHome = mkdtempSync(join(tmpdir(), "cast-eval-home-"));
	mkdirSync(join(evalHome, ".cast"), { recursive: true });
	process.env.HOME = evalHome;
	process.on("exit", () => {
		process.env.HOME = originalHome;
		rmSync(evalHome, { recursive: true, force: true });
	});

	// Set PROVIDER_BASE_URL and PROVIDER_API_KEY if not set
	if (!process.env.PROVIDER_BASE_URL) {
		process.env.PROVIDER_BASE_URL = "https://openrouter.ai/api/v1";
	}

	const cwd = resolve(".");

	if (compareList) {
		const targets = Object.fromEntries(
			compareList
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
				.map((entry) => {
					const separator = entry.indexOf(":");
					if (separator < 1 || separator === entry.length - 1) return [entry, { model: entry }] as const;
					return [entry, { provider: entry.slice(0, separator), model: entry.slice(separator + 1) }] as const;
				}),
		);
		const models = Object.keys(targets);
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
				connection: defaultConnection,
				connections: providerConnections,
				verbose,
				concurrency,
				provider: selectedProvider,
				targets,
				persona,
				repeat,
				rateLimitDelayMs,
			});
			printRepeatedCompareReport(compare);

			const recordedPath = recordCompareRepeated(compare, caseFilter);
			console.log(`Recorded: ${recordedPath}`);

			if (scoreboardFlag) updateScoreboard(compare, benchIds, !caseFilter, targets);

			if (saveBaselineFlag) {
				if (models.length !== 1) {
					console.error(`--save-baseline with --repeat requires a single model; got ${models.length}`);
					process.exit(1);
				}
				if (benchIds.length !== 1) {
					console.error(
						`--save-baseline with --repeat requires exactly one --bench (got ${benchIds.length}: ${benchIds.join(", ")})`,
					);
					process.exit(1);
				}
				const repeatBaselineName = baselineName ?? `basic-m3-r${repeat}`;
				const baselinePath = recordRepeatedBaseline(compare, repeatBaselineName);
				console.log(`Baseline saved (from repeated run): ${baselinePath}`);
				console.log(
					`  ${compare.suites[models[0]!]!.results.filter((r) => r.consistent && r.passed > 0).length}/${compare.cases.length} consistent-pass cases (of ${compare.suites[models[0]!]!.results.length} total)`,
				);
			}

			let repeatedRegression = false;
			if (baselineName) {
				if (models.length !== 1) {
					console.error(`--baseline with --repeat requires a single model; got ${models.length}`);
					process.exit(1);
				}
				repeatedRegression = checkRepeatedBaseline(
					compare.suites[models[0]!]!,
					benchIds,
					baselineName,
					regressionThreshold,
					significanceAlpha,
				);
			}

			if (repeatedRegression || Object.values(compare.suites).some((s) => s.casesPassed < s.casesTotal)) {
				process.exit(1);
			}
			return;
		}

		const compare = await compareModels(filteredCases, models, {
			cwd,
			connection: defaultConnection,
			connections: providerConnections,
			verbose,
			concurrency,
			provider: selectedProvider,
			targets,
			persona,
			rateLimitDelayMs,
		});
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
			connection: defaultConnection,
			connections: providerConnections,
			verbose,
			concurrency,
			provider: selectedProvider,
			persona,
			repeat,
			rateLimitDelayMs,
		});
		printRepeatedCompareReport(compare);

		const recordedPath = recordCompareRepeated(compare, caseFilter);
		console.log(`Recorded: ${recordedPath}`);

		if (scoreboardFlag) updateScoreboard(compare, benchIds, !caseFilter);

		if (saveBaselineFlag) {
			if (benchIds.length !== 1) {
				console.error(
					`--save-baseline requires exactly one --bench (got ${benchIds.length}: ${benchIds.join(", ")})`,
				);
				process.exit(1);
			}
			const repeatBaselineName = baselineName ?? `${benchIds[0]}-m3-r${repeat}`;
			const baselinePath = recordRepeatedBaseline(compare, repeatBaselineName);
			console.log(`Baseline saved (from repeated run): ${baselinePath}`);
			console.log(
				`  ${compare.suites[model!]!.results.filter((r) => r.consistent && r.passed > 0).length}/${compare.cases.length} consistent-pass cases (of ${compare.suites[model!]!.results.length} total)`,
			);
		}

		let repeatedRegression = false;
		if (baselineName) {
			repeatedRegression = checkRepeatedBaseline(
				compare.suites[model!]!,
				benchIds,
				baselineName,
				regressionThreshold,
				significanceAlpha,
			);
		}

		if (repeatedRegression || compare.suites[model!]!.casesPassed < compare.suites[model!]!.casesTotal) {
			process.exit(1);
		}
		return;
	}

	const options: RunnerOptions & { concurrency: number } = {
		model: model!,
		cwd,
		connection: defaultConnection,
		connections: providerConnections,
		verbose,
		concurrency,
		provider: selectedProvider,
		persona,
		rateLimitDelayMs,
	};

	const suite = await runSuite(filteredCases, options);

	printReport(suite);

	const recordedPath = recordRun(suite, caseFilter);
	console.log(`\nRecorded: ${recordedPath}`);
	if (savePath) {
		saveResults(suite, savePath);
		console.log(`Results also saved to: ${savePath}`);
	}

	// Save baseline if --save-baseline was given. Requires a single bench so we
	// can key it by bench name (otherwise different benches would interleave
	// into one baseline file and make per-case regressions meaningless).
	if (saveBaselineFlag) {
		if (benchIds.length !== 1) {
			console.error(`--save-baseline requires exactly one --bench (got ${benchIds.length}: ${benchIds.join(", ")})`);
			process.exit(1);
		}
		const baseline = saveBaseline(suite, benchIds[0]!, baselineName);
		console.log(`Baseline saved: evals/baselines/${baseline.name}.json`);
		console.log(`  ${baseline.passed}/${baseline.total} passing (${(baseline.passRate * 100).toFixed(1)}%)`);
	}

	// Compare against baseline if --baseline was given.
	if (baselineName) {
		if (benchIds.length !== 1) {
			console.error(`--baseline requires exactly one --bench (got ${benchIds.length}: ${benchIds.join(", ")})`);
			process.exit(1);
		}
		const resolved = resolveBaseline(baselineName, model!);
		if (!resolved) {
			console.error(
				`No baseline named "${baselineName}" found. Run with --save-baseline first, or check --list-baselines.`,
			);
			process.exit(1);
		}
		const delta = compareToBaseline(suite, benchIds[0]!, resolved.name, {
			threshold: regressionThreshold,
			alpha: significanceAlpha,
		});
		if (!delta) {
			console.error(`Baseline "${resolved.name}" could not be compared — did you save it?`);
			process.exit(1);
		}
		console.log("");
		console.log("=".repeat(60));
		console.log("REGRESSION CHECK");
		console.log("=".repeat(60));
		console.log(formatDelta(delta, regressionThreshold));

		// Exit with failure if any case failed OR the regression check triggered.
		if (delta.hasRegression || suite.failed > 0) {
			if (delta.hasRegression) {
				if (delta.significance.sampleSizeSufficient && delta.significance.isSignificant) {
					console.log(
						`\n✗ Statistically significant regression detected (p=${delta.significance.pValue.toFixed(4)} < α=${significanceAlpha})`,
					);
				} else {
					console.log(`\n✗ Regression detected (threshold: ${regressionThreshold * 100}pp)`);
				}
			}
			process.exit(1);
		}
		return;
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
                          Use provider:model for cross-provider comparison.
  --provider, -p <name>  Provider entry from settings providers[] (default: active provider)
  --persona, -P <name>   Persona system prompt to run with (default: senior)
  --bench, -b <id,...>   Only run these benches (default: behavior — see --list).
                          Benches live under evals/benches/<id>/; see docs/eval-methodology.md.
  --cases, -c <filter>   Filter cases by id — comma-separated, each part an exact id or a prefix
                          (e.g. "plan-done-signal,background-bash-kill" or "plan-" for every
                          plan-mode case). Cherry-pick a handful of cases to rerun without
                          the whole suite.
  --repeat, -r <n>       Run each case n times (fresh session each attempt) instead of once —
                          reports N/n per case plus a ⚠ when attempts disagreed, so a real
                          effect can be told apart from a one-off flake. Works with -m or
                          --compare (a single model with --repeat is compareModelsRepeated
                          with one model, same report shape).
  --verbose, -v          Show per-case output
  --concurrency, -j <n>  Parallel case execution (default: 10)
  --rate-limit-delay <ms>  Milliseconds to sleep between starting cases — throttles
                          burst starts that hit token-plan 429 limits. With the
                          default concurrency (10) only the 11th+ case is
                          throttled; combine with --concurrency 1 to space
                          every case.
  --save, -s <path>      Also save results to this exact JSON path (every run is auto-recorded
                          to evals/results/runs/ regardless — this is an extra, fixed-path copy)
  --list                 List available benches and their cases
  --history              Show recorded runs from evals/results/index.json
  --save-baseline        Save the run's result as a baseline for regression detection
  --baseline <name>      Compare result against this saved baseline (default name: <bench>-<model>).
                          Works with --repeat too (single model, single --bench required) — the
                          per-case pass rule matches --save-baseline's (consistent && passed > 0).
  --regression-threshold <pp>  Pass-rate drop in pp that counts as a regression when sample size is
                          too small for significance testing (default: 5)
  --significance-alpha <pp>  Significance level for the binomial test that drives the default
                          regression flag (default: 0.05 = 95% confidence)
  --list-baselines       List every "latest" baseline (one per bench+model)
  --baseline-history <name>  List the per-save history of a single baseline (newest first)
  --scoreboard           Update docs/eval-scoreboard.json (site: "Model Scoreboard" page) with
                          this model's certification score. Requires --repeat >= 3 — fewer
                          attempts can't support a certification claim. Combine with --cases to
                          rerun just a handful of cases (e.g. after a network-error flake) and
                          merge them into the model's existing entry instead of a full rerun —
                          errors if that model has no existing entry to merge into yet.
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
  # Run the behavior suite
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v

  # Save results for regression tracking (also auto-recorded either way)
  node --import tsx evals/run.ts -m qwen/qwen3.7-max -v -s evals/results/latest.json

  # List available benches and cases
  node --import tsx evals/run.ts --list

  # What's been run before
  node --import tsx evals/run.ts --history

  # Troubleshoot: list the cases in the latest recorded run
  node --import tsx evals/run.ts --trace latest

  # Full turn-by-turn trace for one case (thinking, tool args, actual tool output)
  node --import tsx evals/run.ts --trace latest --case glob-then-grep

  # Same, narrowed to one model from a --compare file
  node --import tsx evals/run.ts --trace latest --case glob-then-grep -m mimo-v2.5-pro

  # Regression detection: save a baseline, then compare future runs against it.
  # Default detection is statistical: a binomial z-test at --significance-alpha (0.05).
  # For tiny samples (<10 cases) it falls back to --regression-threshold percentage points.
  node --import tsx evals/run.ts -m MiniMax-M3 --bench basic -c simple-math --save-baseline
  node --import tsx evals/run.ts -m MiniMax-M3 --bench basic -c simple-math --baseline basic-MiniMax-M3
  node --import tsx evals/run.ts --list-baselines
  node --import tsx evals/run.ts --baseline-history basic-MiniMax-M3

  # Throttle for token-plan rate limits (single-model, --repeat 3 + 5s spacing).
  # Concurrency 1 + a delay = sequential cases, each spaced 5s apart.
  node --import tsx evals/run.ts -m MiniMax-M3 --bench basic -c simple-math -r 3 --concurrency 1 --rate-limit-delay 5000
`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
