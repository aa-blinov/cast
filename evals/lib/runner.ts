/**
 * Eval runner — executes agent test cases and checks results.
 *
 * Each case is a prompt + expectations:
 * - Expected tools called (by name, in order or any order)
 * - Expected content in final response
 * - Expected content NOT in final response
 * - Expected tool results
 * - Max turns (tool call rounds)
 * - Timeout
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/core/config.ts";
import { type AgentEvent, runAgentLoop } from "../../src/core/loop.ts";
import { findPersona } from "../../src/core/personas.ts";
import { personaOptionsForCwd } from "../../src/core/project.ts";

// ============================================================================
// Case definition
// ============================================================================

/** A single tool invocation observed during a run. */
export interface ObservedToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Context passed to a case's `verify` hook after the run completes. */
export interface VerifyContext {
	/** Final assistant response text. */
	response: string;
	/** Working directory the agent ran in. */
	cwd: string;
	/** Every tool call the agent made, in order, with parsed arguments. */
	toolCalls: ObservedToolCall[];
	/** Number of tool-call rounds. */
	turns: number;
}

export interface EvalCase {
	/** Unique case ID */
	id: string;
	/** Human-readable description */
	description: string;
	/** User prompt */
	prompt: string;
	/** Model to use (overrides default) */
	model?: string;
	/**
	 * Runs before the prompt. Used to (re)create fixture files on disk (see
	 * `evals/fixtures.ts`) so grounded checks in `verify` have known starting state.
	 */
	setup?: () => void | Promise<void>;
	/** Expectations */
	expect: {
		/** Final response must contain ALL of these strings */
		containsAll?: string[];
		/** Final response must contain ANY of these strings */
		containsAny?: string[];
		/** Final response must NOT contain any of these strings */
		containsNone?: string[];
		/** Tools that must be called (by name) */
		toolsCalled?: string[];
		/** Tools that must NOT be called */
		toolsNotCalled?: string[];
		/** Exact tool call sequence (ordered) */
		toolSequence?: string[];
		/** Minimum number of calls per tool name (e.g. bash called at least twice) */
		toolCallCounts?: Record<string, number>;
		/** Max number of tool call rounds */
		maxTurns?: number;
		/** Agent must not error out */
		noErrors?: boolean;
		/**
		 * Grounded check run after all other expectations. Use this for anything that
		 * needs to inspect real state (files on disk, command execution output) rather
		 * than trusting the model's self-reported response text. Return an error
		 * message to fail the case, or undefined/empty string to pass.
		 */
		verify?: (ctx: VerifyContext) => string | undefined | Promise<string | undefined>;
	};
	/** Timeout in ms (default: 60000) */
	timeout?: number;
}

// ============================================================================
// Run result
// ============================================================================

/**
 * Serializable snapshot of what a case expected — everything from `EvalCase.expect`
 * except `verify` itself (a function, can't round-trip through JSON), replaced with
 * a boolean flag. Exists so saved result files are self-documenting: you can see
 * what a case was checking for without cross-referencing the case source file.
 */
export interface ExpectedSummary {
	containsAll?: string[];
	containsAny?: string[];
	containsNone?: string[];
	toolsCalled?: string[];
	toolsNotCalled?: string[];
	toolSequence?: string[];
	toolCallCounts?: Record<string, number>;
	maxTurns?: number;
	noErrors?: boolean;
	hasGroundedVerify: boolean;
}

/** One tool call within a turn, args as parsed by the harness plus what the tool actually returned. */
export interface TraceToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result: { content: string; isError?: boolean };
}

/**
 * One full agent-loop turn: the model's reasoning and any user-visible
 * commentary it produced before/alongside its tool calls, plus each tool
 * call's actual result — not just what was requested, but what came back.
 * This is what makes a failure debuggable after the fact instead of just
 * visible: `toolCalls`/`response` on `RunResult` show *what* the model did,
 * `trace` shows *why* (what it was thinking, what the tools actually told
 * it, and what it did next in response).
 */
export interface TraceTurn {
	turn: number;
	thinking: string;
	commentary: string;
	toolCalls: TraceToolCall[];
}

export interface RunResult {
	caseId: string;
	description: string;
	model: string;
	passed: boolean;
	duration: number;
	toolsCalled: string[];
	toolCalls: ObservedToolCall[];
	turns: number;
	response: string;
	thinking: string;
	errors: string[];
	failedChecks: string[];
	expectedSummary: ExpectedSummary;
	/** Full turn-by-turn record — see `TraceTurn`. */
	trace: TraceTurn[];
}

// ============================================================================
// Runner
// ============================================================================

export interface RunnerOptions {
	model: string;
	cwd: string;
	verbose?: boolean;
	/** Named entry from settings `providers[]`; defaults to the active provider. */
	provider?: string;
	/** Persona whose system prompt the agent runs with; defaults to "senior". */
	persona?: string;
}

/**
 * Provider connection for eval runs — the user's own cast settings.
 * With no name, the active `providerUrl`/`apiKey` pair is used; with a
 * name, the matching entry from `providers[]` is picked.
 */
function loadConnection(providerName?: string): { baseURL: string; apiKey: string } {
	const settings = JSON.parse(readFileSync(join(homedir(), ".cast", "settings.json"), "utf-8")) as {
		providerUrl?: string;
		apiKey?: string;
		providers?: Array<{ name: string; url: string; apiKey: string }>;
	};
	if (providerName) {
		const p = settings.providers?.find((x) => x.name === providerName);
		if (!p) {
			const known = settings.providers?.map((x) => x.name).join(", ") || "none";
			throw new Error(`Provider "${providerName}" not found in ~/.cast/settings.json (known: ${known})`);
		}
		return { baseURL: p.url, apiKey: p.apiKey };
	}
	if (!settings.providerUrl || !settings.apiKey) {
		throw new Error("evals need providerUrl and apiKey in ~/.cast/settings.json");
	}
	return { baseURL: settings.providerUrl, apiKey: settings.apiKey };
}

export async function runCase(evalCase: EvalCase, options: RunnerOptions): Promise<RunResult> {
	const config = loadConfig(loadConnection(options.provider));
	const model = evalCase.model ?? options.model;
	const timeout = evalCase.timeout ?? 60_000;

	const events: AgentEvent[] = [];
	const toolsCalled: string[] = [];
	const toolCalls: ObservedToolCall[] = [];
	const trace: TraceTurn[] = [];
	let pendingAssistant:
		| { content: string; thinking: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
		| undefined;
	let response = "";
	let thinking = "";
	let turns = 0;
	const errors: string[] = [];

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeout);

	const startTime = Date.now();

	try {
		await evalCase.setup?.();

		// Use a real persona prompt so evals exercise the same system prompt
		// (including the shared tools-edit guidance) the shipping agent gets —
		// a bare stub here silently unplugged prompts/tools-edit.md from every
		// eval run. The persona is selectable so results can be compared
		// across personas, and resolves through the same builtin/global dirs
		// the shipping agent uses; an unknown name fails loudly rather than
		// silently benchmarking the wrong prompt.
		const personaName = options.persona ?? "senior";
		const personaPrompt = findPersona(personaName, personaOptionsForCwd(options.cwd, false))?.systemPrompt;
		if (!personaPrompt) {
			throw new Error(`Persona "${personaName}" not found — check prompts/personas/ and ~/.cast/personas/.`);
		}
		await runAgentLoop([{ role: "user", content: evalCase.prompt }], {
			config,
			model,
			cwd: options.cwd,
			systemPrompt: personaPrompt,
			signal: ac.signal,
			onEvent: (event) => {
				events.push(event);

				if (event.type === "tool_start") {
					toolsCalled.push(event.name);
					let args: Record<string, unknown> = {};
					try {
						args = JSON.parse(event.args);
					} catch {
						// leave empty — args string wasn't valid JSON
					}
					toolCalls.push({ name: event.name, args });
				}
				if (event.type === "assistant_message") {
					response = event.content;
					thinking = event.thinking;
					pendingAssistant = { content: event.content, thinking: event.thinking, toolCalls: event.toolCalls };
				}
				if (event.type === "turn_end") {
					turns++;
					// turn_end.toolResults already carries what each tool actually
					// returned this turn — match back to the assistant_message that
					// requested them (by id) to pair args with results.
					const requestedById = new Map((pendingAssistant?.toolCalls ?? []).map((tc) => [tc.id, tc]));
					trace.push({
						turn: turns,
						thinking: pendingAssistant?.thinking ?? "",
						commentary: pendingAssistant?.content ?? "",
						toolCalls: event.toolResults.map((tr) => {
							let args: Record<string, unknown> = {};
							const requested = requestedById.get(tr.id);
							if (requested) {
								try {
									args = JSON.parse(requested.arguments);
								} catch {
									// leave empty — arguments string wasn't valid JSON
								}
							}
							return {
								id: tr.id,
								name: tr.name,
								args,
								result: { content: tr.result.content, isError: tr.result.isError },
							};
						}),
					});
					pendingAssistant = undefined;
				}
				if (event.type === "error") {
					errors.push(event.message);
				}
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}

	clearTimeout(timer);
	const duration = Date.now() - startTime;

	// Check expectations
	const failedChecks: string[] = [];
	const expect = evalCase.expect;

	// A run that died before making any tool call (bad persona, connection
	// refused, …) would otherwise surface as misleading verify failures on
	// the untouched fixture — name the real cause first.
	if (errors.length > 0 && turns === 0) {
		failedChecks.push(`Run failed before any tool call: ${errors.join("; ")}`);
	}

	// containsAll
	if (expect.containsAll) {
		for (const text of expect.containsAll) {
			if (!response.includes(text)) {
				failedChecks.push(`Response missing: "${text}"`);
			}
		}
	}

	// containsAny
	if (expect.containsAny) {
		const found = expect.containsAny.some((text) => response.includes(text));
		if (!found) {
			failedChecks.push(`Response missing any of: [${expect.containsAny.map((s) => `"${s}"`).join(", ")}]`);
		}
	}

	// containsNone
	if (expect.containsNone) {
		for (const text of expect.containsNone) {
			if (response.includes(text)) {
				failedChecks.push(`Response should not contain: "${text}"`);
			}
		}
	}

	// toolsCalled
	if (expect.toolsCalled) {
		for (const tool of expect.toolsCalled) {
			if (!toolsCalled.includes(tool)) {
				failedChecks.push(`Tool not called: ${tool}`);
			}
		}
	}

	// toolsNotCalled
	if (expect.toolsNotCalled) {
		for (const tool of expect.toolsNotCalled) {
			if (toolsCalled.includes(tool)) {
				failedChecks.push(`Tool should not be called: ${tool}`);
			}
		}
	}

	// toolSequence
	if (expect.toolSequence) {
		const actual = toolsCalled.join(",");
		const expected = expect.toolSequence.join(",");
		if (actual !== expected) {
			failedChecks.push(`Tool sequence: expected [${expected}], got [${actual}]`);
		}
	}

	// toolCallCounts
	if (expect.toolCallCounts) {
		for (const [tool, min] of Object.entries(expect.toolCallCounts)) {
			const actual = toolsCalled.filter((t) => t === tool).length;
			if (actual < min) {
				failedChecks.push(`Tool "${tool}" called ${actual} time(s), expected at least ${min}`);
			}
		}
	}

	// maxTurns
	if (expect.maxTurns !== undefined && turns > expect.maxTurns) {
		failedChecks.push(`Too many turns: expected <= ${expect.maxTurns}, got ${turns}`);
	}

	// noErrors
	if (expect.noErrors && errors.length > 0) {
		failedChecks.push(`Errors occurred: ${errors.join("; ")}`);
	}

	// verify — grounded check against real state (disk, execution output)
	if (expect.verify) {
		try {
			const verifyError = await expect.verify({ response, cwd: options.cwd, toolCalls, turns });
			if (verifyError) failedChecks.push(`Verify failed: ${verifyError}`);
		} catch (error) {
			failedChecks.push(`Verify threw: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const passed = failedChecks.length === 0;

	const expectedSummary: ExpectedSummary = {
		containsAll: expect.containsAll,
		containsAny: expect.containsAny,
		containsNone: expect.containsNone,
		toolsCalled: expect.toolsCalled,
		toolsNotCalled: expect.toolsNotCalled,
		toolSequence: expect.toolSequence,
		toolCallCounts: expect.toolCallCounts,
		maxTurns: expect.maxTurns,
		noErrors: expect.noErrors,
		hasGroundedVerify: expect.verify !== undefined,
	};

	return {
		caseId: evalCase.id,
		description: evalCase.description,
		model,
		passed,
		duration,
		toolsCalled,
		toolCalls,
		turns,
		response,
		thinking,
		errors,
		failedChecks,
		expectedSummary,
		trace,
	};
}

// ============================================================================
// Run all cases
// ============================================================================

export interface SuiteResult {
	/** Default model requested for the suite (individual cases may override via `EvalCase.model`). */
	model: string;
	total: number;
	passed: number;
	failed: number;
	duration: number;
	results: RunResult[];
}

export async function runSuite(
	cases: EvalCase[],
	options: RunnerOptions & { concurrency?: number },
): Promise<SuiteResult> {
	const concurrency = options.concurrency ?? 10;
	const results: RunResult[] = new Array(cases.length);
	const startTime = Date.now();
	let completed = 0;

	// Run cases in parallel with concurrency limit
	const executing = new Set<Promise<void>>();

	for (let i = 0; i < cases.length; i++) {
		const idx = i;
		const evalCase = cases[i]!;

		const task = (async () => {
			const result = await runCase(evalCase, options);
			results[idx] = result;
			completed++;

			if (options.verbose) {
				const status = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
				const tools = result.toolsCalled.length > 0 ? ` [${result.toolsCalled.join(", ")}]` : "";
				const progress = `[${completed}/${cases.length}]`;
				console.log(
					`  ${progress} ${evalCase.id}: ${status} (${result.duration}ms, ${result.turns} turns)${tools}`,
				);

				if (!result.passed) {
					for (const check of result.failedChecks) {
						console.log(`        \x1b[31m✗ ${check}\x1b[0m`);
					}
				}
			}
		})();

		executing.add(task);
		task.then(() => executing.delete(task));

		// Wait if we hit the concurrency limit
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}

	// Wait for all remaining tasks
	await Promise.all(executing);

	const duration = Date.now() - startTime;
	const passed = results.filter((r) => r.passed).length;

	return {
		model: options.model,
		total: results.length,
		passed,
		failed: results.length - passed,
		duration,
		results,
	};
}

// ============================================================================
// Repeated runs — same case, same model, N attempts, to tell a real effect
// apart from single-run flakiness (oh-my-pi's benchmark used 3 runs/task for
// exactly this reason — see docs/eval-methodology.md).
// ============================================================================

export interface RepeatedCaseResult {
	caseId: string;
	description: string;
	model: string;
	attempts: RunResult[];
	passed: number;
	total: number;
	/** Every attempt agreed (all passed, or all failed) — a single-run compare
	 * can't tell this apart from a coin flip that happened to land once. */
	consistent: boolean;
	avgDuration: number;
	avgTurns: number;
}

export interface RepeatedSuiteResult {
	model: string;
	repeat: number;
	results: RepeatedCaseResult[];
	/** Cases where a majority of attempts passed. */
	casesPassed: number;
	casesTotal: number;
	duration: number;
}

function average(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

export interface RepeatedCompareResult {
	models: string[];
	cases: EvalCase[];
	repeat: number;
	suites: Record<string, RepeatedSuiteResult>;
	byCase: Record<string, Record<string, RepeatedCaseResult>>;
}

/**
 * Runs every (model, case) pair `options.repeat` times, fresh agent session
 * each attempt (matching oh-my-pi's "fresh session each time"). All models
 * share one concurrency-limited pool — model×case×repeat is flattened into a
 * single job list — instead of running one model's whole suite to
 * completion before starting the next; every request across every model is
 * independent, so there's no reason to serialize models behind each other.
 */
export async function compareModelsRepeated(
	cases: EvalCase[],
	models: string[],
	options: Omit<RunnerOptions, "model"> & { concurrency?: number; repeat: number },
): Promise<RepeatedCompareResult> {
	const concurrency = options.concurrency ?? 10;
	const repeat = Math.max(1, options.repeat);
	const overallStart = Date.now();

	const attemptsByModelCase: Record<string, RunResult[][]> = Object.fromEntries(
		models.map((m) => [m, cases.map(() => [])]),
	);
	const modelEndTime: Record<string, number> = Object.fromEntries(models.map((m) => [m, overallStart]));

	const jobs: Array<{ model: string; caseIndex: number }> = [];
	for (const model of models) {
		for (let i = 0; i < cases.length; i++) {
			for (let r = 0; r < repeat; r++) jobs.push({ model, caseIndex: i });
		}
	}

	let completedJobs = 0;
	const totalJobs = jobs.length;
	const executing = new Set<Promise<void>>();

	for (const job of jobs) {
		const evalCase = cases[job.caseIndex]!;
		const task = (async () => {
			const result = await runCase(evalCase, { ...options, model: job.model });
			const attempts = attemptsByModelCase[job.model]![job.caseIndex]!;
			attempts.push(result);
			completedJobs++;
			modelEndTime[job.model] = Date.now();

			if (options.verbose) {
				const status = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
				console.log(
					`  [${completedJobs}/${totalJobs}] ${job.model} :: ${evalCase.id} (attempt ${attempts.length}/${repeat}): ${status} (${result.duration}ms, ${result.turns} turns)`,
				);
			}
		})();

		executing.add(task);
		task.then(() => executing.delete(task));
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}
	await Promise.all(executing);

	const suites: Record<string, RepeatedSuiteResult> = {};
	for (const model of models) {
		const results: RepeatedCaseResult[] = cases.map((c, i) => {
			const attempts = attemptsByModelCase[model]![i]!;
			const passed = attempts.filter((a) => a.passed).length;
			return {
				caseId: c.id,
				description: c.description,
				model,
				attempts,
				passed,
				total: attempts.length,
				consistent: passed === 0 || passed === attempts.length,
				avgDuration: average(attempts.map((a) => a.duration)),
				avgTurns: average(attempts.map((a) => a.turns)),
			};
		});
		suites[model] = {
			model,
			repeat,
			results,
			casesPassed: results.filter((r) => r.passed * 2 > r.total).length,
			casesTotal: cases.length,
			duration: modelEndTime[model]! - overallStart,
		};
	}

	const byCase: Record<string, Record<string, RepeatedCaseResult>> = {};
	for (const model of models) {
		for (const result of suites[model]!.results) {
			byCase[result.caseId] ??= {};
			byCase[result.caseId]![model] = result;
		}
	}

	return { models, cases, repeat, suites, byCase };
}

export function printRepeatedCompareReport(compare: RepeatedCompareResult): void {
	const CELL_WIDTH = 20;
	console.log(`\n${"=".repeat(74)}`);
	console.log(`MODEL COMPARISON (${compare.repeat} runs/case): ${compare.models.join("  vs  ")}`);
	console.log("=".repeat(74));

	const idWidth = Math.max(20, ...compare.cases.map((c) => c.id.length)) + 2;
	console.log(`\n  ${padCell("case", idWidth)}${compare.models.map((m) => padCell(m, CELL_WIDTH)).join("")}`);
	for (const c of compare.cases) {
		const cells = compare.models
			.map((m) => {
				const r = compare.byCase[c.id]?.[m];
				if (!r) return padCell("—", CELL_WIDTH);
				// A majority pass is still flagged with ⚠ when attempts disagreed —
				// that inconsistency is the whole point of repeating runs: a 2/3
				// "pass" earned by one flaky attempt reads very differently from 3/3.
				const flag = r.consistent ? "" : " ⚠";
				const plain = `${r.passed}/${r.total}${flag} ~${(r.avgDuration / 1000).toFixed(1)}s`;
				const color = r.passed === r.total ? "\x1b[32m" : r.passed === 0 ? "\x1b[31m" : "\x1b[33m";
				return `${color}${plain}\x1b[0m${" ".repeat(Math.max(0, CELL_WIDTH - plain.length))}`;
			})
			.join("");
		console.log(`  ${padCell(c.id, idWidth)}${cells}`);
	}

	console.log("\nSummary (majority-pass cases):");
	for (const model of compare.models) {
		const s = compare.suites[model]!;
		console.log(
			`  ${padCell(model, idWidth)} ${s.casesPassed}/${s.casesTotal} cases  (${(s.duration / 1000).toFixed(1)}s total, ${s.repeat} runs/case)`,
		);
	}
	const inconsistentCount = compare.cases.filter((c) =>
		compare.models.some((m) => compare.byCase[c.id]?.[m]?.consistent === false),
	).length;
	if (inconsistentCount > 0) {
		console.log(`\n⚠ ${inconsistentCount} case(s) had disagreeing attempts on at least one model — see ⚠ above.`);
	}
	console.log();
}

// ============================================================================
// Report
// ============================================================================

export function printReport(suite: SuiteResult): void {
	console.log("\n" + "=".repeat(60));
	console.log(`EVAL RESULTS: ${suite.passed}/${suite.total} passed (${suite.duration}ms)`);
	console.log("=".repeat(60));

	if (suite.failed > 0) {
		console.log("\nFailed cases:");
		for (const result of suite.results.filter((r) => !r.passed)) {
			console.log(`  \x1b[31m✗ ${result.caseId}\x1b[0m — ${result.description}`);
			for (const check of result.failedChecks) {
				console.log(`    - ${check}`);
			}
		}
	}

	console.log("\nSummary:");
	for (const result of suite.results) {
		const status = result.passed ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
		console.log(
			`  ${status} ${result.caseId} (${result.duration}ms, ${result.turns} turns, tools: [${result.toolsCalled.join(", ")}])`,
		);
	}
}

// ============================================================================
// Model comparison — same cases, same harness, different models
// ============================================================================

/**
 * Runs the same case set once per model and indexes results both by model
 * (full SuiteResult, for a per-model summary) and by case (for a
 * side-by-side row per case). This is the harness-holding-model-varying
 * axis — see oh-my-pi's edit-benchmark writeup for the complementary axis
 * (model held constant, tool format varied), which would need a second
 * `edit`-tool implementation in cast to reproduce.
 *
 * All models share one concurrency-limited pool — model×case is flattened
 * into a single job list, same idea as `compareModelsRepeated` — instead of
 * running one model's whole suite to completion before starting the next:
 * every request across every model is independent, so serializing models
 * behind each other only made `--compare` take roughly (models × single-run
 * time) for no reason.
 */
export interface CompareResult {
	models: string[];
	cases: EvalCase[];
	suites: Record<string, SuiteResult>;
	byCase: Record<string, Record<string, RunResult>>;
}

export async function compareModels(
	cases: EvalCase[],
	models: string[],
	options: Omit<RunnerOptions, "model"> & { concurrency?: number },
): Promise<CompareResult> {
	const concurrency = options.concurrency ?? 10;
	const overallStart = Date.now();

	const resultsByModel: Record<string, RunResult[]> = Object.fromEntries(
		models.map((m) => [m, new Array(cases.length)]),
	);
	const modelEndTime: Record<string, number> = Object.fromEntries(models.map((m) => [m, overallStart]));

	const jobs: Array<{ model: string; caseIndex: number }> = [];
	for (const model of models) {
		for (let i = 0; i < cases.length; i++) jobs.push({ model, caseIndex: i });
	}

	let completed = 0;
	const totalJobs = jobs.length;
	const executing = new Set<Promise<void>>();

	for (const job of jobs) {
		const evalCase = cases[job.caseIndex]!;
		const task = (async () => {
			const result = await runCase(evalCase, { ...options, model: job.model });
			resultsByModel[job.model]![job.caseIndex] = result;
			completed++;
			modelEndTime[job.model] = Date.now();

			if (options.verbose) {
				const status = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
				const tools = result.toolsCalled.length > 0 ? ` [${result.toolsCalled.join(", ")}]` : "";
				console.log(
					`  [${completed}/${totalJobs}] ${job.model} :: ${evalCase.id}: ${status} (${result.duration}ms, ${result.turns} turns)${tools}`,
				);
				if (!result.passed) {
					for (const check of result.failedChecks) console.log(`        \x1b[31m✗ ${check}\x1b[0m`);
				}
			}
		})();

		executing.add(task);
		task.then(() => executing.delete(task));
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
	}
	await Promise.all(executing);

	const suites: Record<string, SuiteResult> = {};
	for (const model of models) {
		const results = resultsByModel[model]!;
		const passed = results.filter((r) => r.passed).length;
		suites[model] = {
			model,
			total: results.length,
			passed,
			failed: results.length - passed,
			duration: modelEndTime[model]! - overallStart,
			results,
		};
	}

	const byCase: Record<string, Record<string, RunResult>> = {};
	for (const model of models) {
		for (const result of suites[model]!.results) {
			byCase[result.caseId] ??= {};
			byCase[result.caseId]![model] = result;
		}
	}

	return { models, cases, suites, byCase };
}

function padCell(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function printCompareReport(compare: CompareResult): void {
	const CELL_WIDTH = 16;
	console.log(`\n${"=".repeat(70)}`);
	console.log(`MODEL COMPARISON: ${compare.models.join("  vs  ")}`);
	console.log("=".repeat(70));

	// +2 gutter — otherwise the longest case id exactly fills the column with
	// no gap before the first model's value (confirmed visually: it glued
	// "hashline-range-replace-and-delete" straight onto the checkmark).
	const idWidth = Math.max(20, ...compare.cases.map((c) => c.id.length)) + 2;
	console.log(`\n  ${padCell("case", idWidth)}${compare.models.map((m) => padCell(m, CELL_WIDTH)).join("")}`);
	for (const c of compare.cases) {
		const cells = compare.models
			.map((m) => {
				const r = compare.byCase[c.id]?.[m];
				if (!r) return padCell("—", CELL_WIDTH);
				// Pad on the plain (uncolored) text first — ANSI escape bytes aren't
				// visible width, so padding after coloring would misalign columns.
				const plain = `${r.passed ? "✓" : "✗"} ${r.turns}t ${(r.duration / 1000).toFixed(1)}s`;
				const colored = r.passed ? `\x1b[32m${plain}\x1b[0m` : `\x1b[31m${plain}\x1b[0m`;
				return colored + " ".repeat(Math.max(0, CELL_WIDTH - plain.length));
			})
			.join("");
		console.log(`  ${padCell(c.id, idWidth)}${cells}`);
	}

	console.log("\nSummary:");
	for (const model of compare.models) {
		const s = compare.suites[model]!;
		console.log(
			`  ${padCell(model, idWidth)} ${s.passed}/${s.total} passed  (${(s.duration / 1000).toFixed(1)}s total)`,
		);
	}
	console.log();
}

/** Same shape as saveResults, one entry per model, for regression tracking across a compare run. */
export function saveCompareResults(compare: CompareResult, path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const data = {
		timestamp: new Date().toISOString(),
		models: compare.models,
		perModel: Object.fromEntries(
			Object.entries(compare.suites).map(([model, s]) => [
				model,
				{
					total: s.total,
					passed: s.passed,
					failed: s.failed,
					duration: s.duration,
					cases: s.results.map((r) => ({
						id: r.caseId,
						passed: r.passed,
						duration: r.duration,
						turns: r.turns,
						toolsCalled: r.toolsCalled,
						failedChecks: r.failedChecks,
						trace: r.trace,
					})),
				},
			]),
		),
	};

	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Save results to JSON for regression tracking.
 */
export function saveResults(suite: SuiteResult, path: string): void {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	const data = {
		timestamp: new Date().toISOString(),
		model: suite.model,
		total: suite.total,
		passed: suite.passed,
		failed: suite.failed,
		duration: suite.duration,
		cases: suite.results.map((r) => ({
			id: r.caseId,
			description: r.description,
			model: r.model,
			passed: r.passed,
			duration: r.duration,
			turns: r.turns,
			toolsCalled: r.toolsCalled,
			expected: r.expectedSummary,
			failedChecks: r.failedChecks,
			errors: r.errors,
			responsePreview: r.response.slice(0, 500),
			trace: r.trace,
		})),
	};

	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}
