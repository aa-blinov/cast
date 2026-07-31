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

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "../../src/core/config.ts";
import { loadConfig } from "../../src/core/config.ts";
import { BackgroundTaskRegistry } from "../../src/core/tools/bash-background.ts";
import { type AgentEvent, MessageQueue, runAgentLoop } from "../../src/core/loop.ts";
import { findPersona } from "../../src/core/personas.ts";
import { createPlanState, modeDisabledTools } from "../../src/core/plan.ts";
import { buildSystemPrompt, personaOptionsForCwd, resolvePersonasForCwd } from "../../src/core/project.ts";
import { loadSubagentPrompts } from "../../src/core/subagents.ts";
import { builtinSkillsDir, formatSkillsForPrompt, loadSkills } from "../../src/core/skills.ts";
import {
	closeMcpConnections,
	connectMcpServers,
	formatMcpForPrompt,
	type McpServerConfig,
	type McpSetupResult,
} from "../../src/core/mcp.ts";

// ============================================================================
// Case definition
// ============================================================================

/** A single tool invocation observed during a run. */
export interface ObservedToolCall {
	name: string;
	args: Record<string, unknown>;
	/** Raw tool output, filled in at turn_end when the result lands. `verify`
	 *  can read this to grade against real tool output rather than the
	 *  model's self-reported prose. The hashline-guttered `read` tool, for
	 *  example, returns its line-prefixed content here, which a verify can
	 *  strip before applying a regex. */
	result?: { content: string; isError?: boolean };
}

/** Context passed to a case's `verify` hook after the run completes. */
export interface VerifyContext {
	/** Final assistant response text. */
	response: string;
	/** Working directory the agent ran in. */
	cwd: string;
	/** Every tool call the agent made, in order, with parsed arguments
	 *  and (when available) the tool's raw result. Result is filled in at
	 *  turn_end — verify may read it to grade against real tool output
	 *  rather than the model's self-reported response text. */
	toolCalls: ObservedToolCall[];
	/** Number of tool-call rounds. */
	turns: number;
	/** Full trace, including which calls were grouped in the same tool turn. */
	trace: TraceTurn[];
}

export interface EvalCase {
	/** Unique case ID */
	id: string;
	/** Human-readable description */
	description: string;
	/** Independent behavioral dimensions reported separately after a run. */
	signals?: string[];
	/** User prompt */
	prompt: string;
	/** Model to use (overrides default) */
	model?: string;
	/** Persona override used by cases that exercise task/subagent behavior. */
	persona?: string;
	/** Load builtin skills and advertise the skill catalog for this case. */
	withSkills?: boolean;
	/** Local or remote MCP servers made available to this case's agent loop. */
	mcpServers?: Record<string, McpServerConfig>;
	/**
	 * Runs the case with the interactive mode contract that the TUI gives the
	 * parent agent. Headless `cast run` deliberately has no plan controls, so
	 * behavior cases that exercise plan transitions must opt in explicitly.
	 */
	mode?: "build" | "plan";
	/** Prepare a session-local active plan file before running the case. */
	planFixture?: { name: string; content: string };
	/**
	 * Working directory override — defaults to `RunnerOptions.cwd` (the real
	 * project repo). Set this to an isolated empty directory (e.g.
	 * `fixtureDir(...)` after `writeFixture(id, {})`) for a case whose prompt
	 * describes a self-contained scenario: with the real repo as cwd, a
	 * capable model's GROUND instinct can and will go looking for whatever
	 * the scenario mentions — confirmed once by a model that searched the
	 * filesystem for a supposedly-fictional package name, found nothing, and
	 * kept digging until it grep'd its way into this very eval case's own
	 * source file.
	 */
	cwd?: string;
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
		/** Required ordered subsequence of calls; unrelated inspection calls are allowed. */
		toolSubsequence?: string[];
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
	toolSubsequence?: string[];
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
	signals: string[];
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
	/** Token usage and cost for this run (aggregated across all turns). */
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		uncachedTokens?: number;
	};
}

// ============================================================================
// Runner
// ============================================================================

export interface RunnerOptions {
	model: string;
	cwd: string;
	/** Provider connection captured before the eval switches to its isolated HOME. */
	connection?: ProviderConnection;
	/** Named provider connections captured before the eval switches HOME. */
	connections?: Record<string, ProviderConnection>;
	verbose?: boolean;
	/** Named entry from settings `providers[]`; defaults to the active provider. */
	provider?: string;
	/** Persona whose system prompt the agent runs with; defaults to "senior". */
	persona?: string;
	/**
	 * Milliseconds to sleep between launching cases — works around token-plan
	 * rate limits (e.g. xiaomi-mimo's 429 "Token Plan rate limit reached")
	 * by spacing requests instead of letting concurrency fire them all at once.
	 * With `concurrency: 1` this becomes a per-case delay; with the default
	 * `concurrency: 10` the delay only applies when a new task is started
	 * after one just completed (still gates peak arrival rate to the provider).
	 */
	rateLimitDelayMs?: number;
}

/** A compare label may point at a different provider than the suite default. */
export interface CompareTarget {
	model: string;
	provider?: string;
}

export interface ProviderConnection {
	baseURL: string;
	apiKey: string;
}

/**
 * Provider connection for eval runs — the user's own cast settings.
 * With no name, the active `providerUrl`/`apiKey` pair is used; with a
 * name, the matching entry from `providers[]` is picked.
 */
function loadConnection(providerName: string | undefined, options: RunnerOptions): ProviderConnection {
	if (providerName && options.connections?.[providerName]) return options.connections[providerName];
	if (!providerName && options.connection) return options.connection;
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

/** One case attempt's raw outcome — see `runCase`'s retry loop below. */
interface AttemptResult {
	toolsCalled: string[];
	toolCalls: ObservedToolCall[];
	trace: TraceTurn[];
	response: string;
	thinking: string;
	turns: number;
	errors: string[];
	usage: RunResult["usage"];
}

/** Infra-only retries: a case that dies before a single tool call or turn
 *  landed (bad connection, DNS hiccup, transient 5xx that outran the LLM
 *  client's own retry budget — see src/core/llm.ts's isRetryable/backoff,
 *  which already retries indefinitely *within* one request) is far more
 *  likely a flake than a real behavioral finding. A case that got partway
 *  through and then hit an error is never retried here — that's real signal,
 *  not infra noise, and retrying it would risk masking an actual regression. */
const MAX_INFRA_RETRIES = 2;

async function runAttempt(evalCase: EvalCase, options: RunnerOptions, config: AppConfig, model: string): Promise<AttemptResult> {
	const cwd = evalCase.cwd ?? options.cwd;
	const timeout = evalCase.timeout ?? 60_000;
	const events: AgentEvent[] = [];
	const toolsCalled: string[] = [];
	const toolCalls: ObservedToolCall[] = [];
	// Side-index by tool call id so turn_end can attach the tool's result
	// back to the ObservedToolCall it corresponds to (the push only
	// carries name+args at tool_start time; result lands later).
	const toolById = new Map<string, ObservedToolCall>();
	const trace: TraceTurn[] = [];
	let pendingAssistant:
		| { content: string; thinking: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }
		| undefined;
	let response = "";
	let thinking = "";
	let turns = 0;
	const errors: string[] = [];
	const usage = {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cost: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		uncachedTokens: 0,
	};

	const ac = new AbortController();
	const backgroundRegistry = new BackgroundTaskRegistry();
	const backgroundQueue = new MessageQueue();
	const timer = setTimeout(() => ac.abort(), timeout);

	let planState: ReturnType<typeof createPlanState> | undefined;
	let mcpSetup: McpSetupResult | undefined;

	try {
		await evalCase.setup?.();

		// Use a real persona prompt so evals exercise the same system prompt
		// (including the shared tools-edit guidance) the shipping agent gets —
		// a bare stub here silently unplugged prompts/tools-edit.md from every
		// eval run. The persona is selectable so results can be compared
		// across personas, and resolves through the same builtin/global dirs
		// the shipping agent uses; an unknown name fails loudly rather than
		// silently benchmarking the wrong prompt.
		const personaName = evalCase.persona ?? options.persona ?? "senior";
		const persona = findPersona(personaName, personaOptionsForCwd(cwd, false, false));
		if (!persona) {
			throw new Error(`Persona "${personaName}" not found — check prompts/personas/ and ~/.cast/personas/.`);
		}
		planState = evalCase.mode ? createPlanState(`eval-${evalCase.id}-${Date.now()}`) : undefined;
		if (planState) planState.enabled = evalCase.mode === "plan";
		if (planState && evalCase.planFixture) {
			mkdirSync(planState.plansDir, { recursive: true });
			const planPath = join(planState.plansDir, `${evalCase.planFixture.name}.md`);
			writeFileSync(planPath, evalCase.planFixture.content, "utf-8");
			planState.activePlanPath = planPath;
		}
		const personas = resolvePersonasForCwd(cwd, false, false).personas;
		const subagentPrompts = evalCase.persona === "coder-with-subagents" ? loadSubagentPrompts() : undefined;
		const skills = evalCase.withSkills
			? loadSkills({ builtinDir: builtinSkillsDir, extraPaths: [] }).skills
			: undefined;
		if (evalCase.mcpServers) {
			mcpSetup = await connectMcpServers(evalCase.mcpServers);
			if (mcpSetup.diagnostics.length > 0) {
				throw new Error(`MCP setup failed: ${mcpSetup.diagnostics.join("; ")}`);
			}
		}
		const skillsSuffix = skills ? formatSkillsForPrompt(skills) : "";
		const systemPrompt =
			evalCase.mode || evalCase.withSkills
				? buildSystemPrompt(persona, "", "", "", skillsSuffix, "", cwd, {
						model,
						reasoningLevel: config.reasoningLevel,
						mode: evalCase.mode,
					})
				: persona.systemPrompt;
		await runAgentLoop([{ role: "user", content: evalCase.prompt }], {
			config,
			model,
			cwd,
			systemPrompt,
			disabledTools: planState ? new Set(modeDisabledTools(planState.enabled)) : undefined,
			personas,
			currentPersona: persona.name,
			subagentPrompts,
			skills,
			mcpTools: mcpSetup?.toolDefinitions,
			mcpToolIndex: mcpSetup?.toolIndex,
			mcpPromptSuffix: mcpSetup ? formatMcpForPrompt(mcpSetup) : undefined,
			planState,
			followUpQueue: backgroundQueue,
			backgroundBash: {
				registry: backgroundRegistry,
				followUpQueue: backgroundQueue,
				isRunning: () => true,
			},
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
					// toolStart events carry a call id; track the latest entry
					// for the id so turn_end can attach the result. (For calls
					// without a streamed id we just leave the matching entry
					// without a result — verify should fall back to disk.)
					const callId = (event as { id?: string }).id;
					if (callId) {
						toolById.set(callId, toolCalls[toolCalls.length - 1]!);
					}
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
							const observed = toolById.get(tr.id);
							if (observed) observed.result = { content: tr.result.content, isError: tr.result.isError };
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
				if (event.type === "usage") {
					usage.promptTokens += event.usage.promptTokens ?? 0;
					usage.completionTokens += event.usage.completionTokens ?? 0;
					usage.totalTokens += event.usage.totalTokens ?? 0;
					usage.cost += event.usage.cost ?? 0;
					usage.cacheReadTokens += event.usage.cacheReadTokens ?? 0;
					usage.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0;
					usage.uncachedTokens += event.usage.uncachedTokens ?? 0;
				}
			},
		});
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
	}
	backgroundRegistry.killAll();
	if (mcpSetup) await closeMcpConnections(mcpSetup.connections);
	if (planState) rmSync(planState.plansDir, { recursive: true, force: true });

	clearTimeout(timer);
	return { toolsCalled, toolCalls, trace, response, thinking, turns, errors, usage };
}

export async function runCase(evalCase: EvalCase, options: RunnerOptions): Promise<RunResult> {
	const config = loadConfig(loadConnection(options.provider, options));
	const model = evalCase.model ?? options.model;
	const startTime = Date.now();

	let attempt = await runAttempt(evalCase, options, config, model);
	let retries = 0;
	// Only a hard, zero-progress failure (nothing landed — no tool call, no
	// turn) gets retried: that's the signature of an infra hiccup (dropped
	// connection, DNS, a transient error that outran the LLM client's own
	// retry budget), not a real behavioral disagreement. A case that got
	// partway through and then errored is real signal and is never retried.
	while (attempt.errors.length > 0 && attempt.turns === 0 && retries < MAX_INFRA_RETRIES) {
		retries++;
		attempt = await runAttempt(evalCase, options, config, model);
	}
	const { toolsCalled, toolCalls, trace, response, thinking, turns, errors, usage } = attempt;

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

	if (expect.toolSubsequence) {
		let cursor = 0;
		for (const tool of toolsCalled) {
			if (tool === expect.toolSubsequence[cursor]) cursor++;
		}
		if (cursor !== expect.toolSubsequence.length) {
			failedChecks.push(
				`Tool subsequence: expected [${expect.toolSubsequence.join(", ")}], got [${toolsCalled.join(", ")}]`,
			);
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
			const verifyError = await expect.verify({ response, cwd: evalCase.cwd ?? options.cwd, toolCalls, turns, trace });
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
		toolSubsequence: expect.toolSubsequence,
		toolCallCounts: expect.toolCallCounts,
		maxTurns: expect.maxTurns,
		noErrors: expect.noErrors,
		hasGroundedVerify: expect.verify !== undefined,
	};

	return {
		caseId: evalCase.id,
		description: evalCase.description,
		signals: evalCase.signals ?? [],
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
		usage,
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
	/** Pass/fail totals per dimension; intentionally not collapsed into one score. */
	bySignal: Record<string, { passed: number; total: number }>;
	/** Aggregated token usage and cost across all cases in the suite. */
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		uncachedTokens: number;
	};
}

export async function runSuite(
	cases: EvalCase[],
	options: RunnerOptions & { concurrency?: number },
): Promise<SuiteResult> {
	const concurrency = options.concurrency ?? 10;
	const rateLimitDelayMs = options.rateLimitDelayMs ?? 0;
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
		// Rate-limit gate: throttle the start of each new case so a token-plan
		// "rate limit reached" 429 doesn't fire after a burst. With concurrency>1
		// this runs only after the first wave of cases has started, so the
		// first ten still launch together; subsequent starts are spaced.
		if (rateLimitDelayMs > 0) {
			await sleep(rateLimitDelayMs);
		}
	}

	// Wait for all remaining tasks
	await Promise.all(executing);

	const duration = Date.now() - startTime;
	const passed = results.filter((r) => r.passed).length;

	// Aggregate usage across all cases
	const usage = results.reduce(
		(acc, r) => ({
			promptTokens: acc.promptTokens + r.usage.promptTokens,
			completionTokens: acc.completionTokens + r.usage.completionTokens,
			totalTokens: acc.totalTokens + r.usage.totalTokens,
			cost: acc.cost + (r.usage.cost ?? 0),
			cacheReadTokens: acc.cacheReadTokens + (r.usage.cacheReadTokens ?? 0),
			cacheWriteTokens: acc.cacheWriteTokens + (r.usage.cacheWriteTokens ?? 0),
			uncachedTokens: acc.uncachedTokens + (r.usage.uncachedTokens ?? 0),
		}),
		{
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
		},
	);
	const bySignal: SuiteResult["bySignal"] = {};
	for (const result of results) {
		for (const signal of result.signals) {
			let summary = bySignal[signal];
			if (!summary) {
				summary = { passed: 0, total: 0 };
				bySignal[signal] = summary;
			}
			summary.total++;
			if (result.passed) summary.passed++;
		}
	}

	return {
		model: options.model,
		total: results.length,
		passed,
		failed: results.length - passed,
		duration,
		results,
		bySignal,
		usage,
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
	/** Aggregated token usage and cost across all attempts. */
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
		cost: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		uncachedTokens: number;
	};
}

function average(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Sleep `ms` milliseconds. Used by `--rate-limit-delay` to space out case starts. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	options: Omit<RunnerOptions, "model"> & {
		concurrency?: number;
		repeat: number;
		targets?: Record<string, CompareTarget>;
	},
): Promise<RepeatedCompareResult> {
	const concurrency = options.concurrency ?? 10;
	const repeat = Math.max(1, options.repeat);
	const rateLimitDelayMs = options.rateLimitDelayMs ?? 0;
	const overallStart = Date.now();

	const attemptsByModelCase: Record<string, RunResult[][]> = Object.fromEntries(
		models.map((m) => [m, cases.map(() => [])]),
	);
	const modelEndTime: Record<string, number> = Object.fromEntries(models.map((m) => [m, overallStart]));

	// One job per (model, case) — NOT per attempt. Attempts of the same case
	// run sequentially inside the job (see below); different (model, case)
	// jobs still run concurrently against each other through the same pool.
	const jobs: Array<{ model: string; caseIndex: number }> = [];
	for (const model of models) {
		for (let i = 0; i < cases.length; i++) {
			jobs.push({ model, caseIndex: i });
		}
	}

	let completedJobs = 0;
	const totalJobs = jobs.length * repeat;
	const executing = new Set<Promise<void>>();

	for (const job of jobs) {
		const evalCase = cases[job.caseIndex]!;
		const task = (async () => {
			const target = options.targets?.[job.model];
			const attempts = attemptsByModelCase[job.model]![job.caseIndex]!;
			// Sequential, not Promise.all/parallel: `writeFixture` (evals/lib/fixtures.ts)
			// always (re)writes the same fixed path for a given case id — running
			// this case's attempts concurrently means one attempt's setup() can
			// wipe/recreate the fixture out from under another attempt's still-running
			// agent loop. Confirmed: 3 cases that flaked under the old flat
			// one-job-per-attempt scheduling (default concurrency) went a clean 3/3
			// once forced serial — not model non-determinism, fixture corruption.
			for (let r = 0; r < repeat; r++) {
				const result = await runCase(evalCase, {
					...options,
					model: target?.model ?? job.model,
					provider: target?.provider ?? options.provider,
				});
				attempts.push(result);
				completedJobs++;
				modelEndTime[job.model] = Date.now();

				if (options.verbose) {
					const status = result.passed ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
					console.log(
						`  [${completedJobs}/${totalJobs}] ${job.model} :: ${evalCase.id} (attempt ${attempts.length}/${repeat}): ${status} (${result.duration}ms, ${result.turns} turns)`,
					);
				}
			}
		})();

		executing.add(task);
		task.then(() => executing.delete(task));
		if (executing.size >= concurrency) {
			await Promise.race(executing);
		}
		if (rateLimitDelayMs > 0) {
			await sleep(rateLimitDelayMs);
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
		// Aggregate usage across all attempts for this model
		const usage = results.reduce(
			(acc, r) => {
				const attemptUsage = r.attempts.reduce(
					(a, attempt) => ({
						promptTokens: a.promptTokens + attempt.usage.promptTokens,
						completionTokens: a.completionTokens + attempt.usage.completionTokens,
						totalTokens: a.totalTokens + attempt.usage.totalTokens,
						cost: a.cost + (attempt.usage.cost ?? 0),
						cacheReadTokens: a.cacheReadTokens + (attempt.usage.cacheReadTokens ?? 0),
						cacheWriteTokens: a.cacheWriteTokens + (attempt.usage.cacheWriteTokens ?? 0),
						uncachedTokens: a.uncachedTokens + (attempt.usage.uncachedTokens ?? 0),
					}),
					{
						promptTokens: 0,
						completionTokens: 0,
						totalTokens: 0,
						cost: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						uncachedTokens: 0,
					},
				);
				return {
					promptTokens: acc.promptTokens + attemptUsage.promptTokens,
					completionTokens: acc.completionTokens + attemptUsage.completionTokens,
					totalTokens: acc.totalTokens + attemptUsage.totalTokens,
					cost: acc.cost + attemptUsage.cost,
					cacheReadTokens: acc.cacheReadTokens + attemptUsage.cacheReadTokens,
					cacheWriteTokens: acc.cacheWriteTokens + attemptUsage.cacheWriteTokens,
					uncachedTokens: acc.uncachedTokens + attemptUsage.uncachedTokens,
				};
			},
			{
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cost: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedTokens: 0,
			},
		);

		suites[model] = {
			model,
			repeat,
			results,
			casesPassed: results.filter((r) => r.passed * 2 > r.total).length,
			casesTotal: cases.length,
			duration: modelEndTime[model]! - overallStart,
			usage,
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
		const cost = s.usage.cost > 0 ? `$${s.usage.cost.toFixed(4)}` : "n/a";
		console.log(
			`  ${padCell(model, idWidth)} ${s.casesPassed}/${s.casesTotal} cases  (${(s.duration / 1000).toFixed(1)}s, ${s.usage.totalTokens.toLocaleString()} tokens, ${cost}, ${s.repeat} runs/case)`,
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
	console.log(`\n${"=".repeat(60)}`);
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
		const cost = result.usage.cost ? `$${result.usage.cost.toFixed(4)}` : "n/a";
		console.log(
			`  ${status} ${result.caseId} (${result.duration}ms, ${result.turns} turns, ${result.usage.totalTokens} tokens, ${cost})`,
		);
	}

	console.log(`\n${"-".repeat(60)}`);
	console.log("Usage:");
	console.log(`  Total tokens: ${suite.usage.totalTokens.toLocaleString()}`);
	console.log(`    Prompt: ${suite.usage.promptTokens.toLocaleString()}`);
	console.log(`    Completion: ${suite.usage.completionTokens.toLocaleString()}`);
	if (suite.usage.cacheReadTokens > 0) {
		console.log(`    Cache read: ${suite.usage.cacheReadTokens.toLocaleString()}`);
	}
	if (suite.usage.cacheWriteTokens > 0) {
		console.log(`    Cache write: ${suite.usage.cacheWriteTokens.toLocaleString()}`);
	}
	if (suite.usage.uncachedTokens > 0) {
		console.log(`    Uncached: ${suite.usage.uncachedTokens.toLocaleString()}`);
	}
	if (suite.usage.cost > 0) {
		console.log(`  Total cost: $${suite.usage.cost.toFixed(4)}`);
	}
	if (Object.keys(suite.bySignal).length > 0) {
		console.log("\nBehavior signals:");
		for (const [signal, summary] of Object.entries(suite.bySignal).sort(([a], [b]) => a.localeCompare(b))) {
			console.log(`  ${signal}: ${summary.passed}/${summary.total}`);
		}
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
	options: Omit<RunnerOptions, "model"> & { concurrency?: number; targets?: Record<string, CompareTarget> },
): Promise<CompareResult> {
	const concurrency = options.concurrency ?? 10;
	const rateLimitDelayMs = options.rateLimitDelayMs ?? 0;
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
			const target = options.targets?.[job.model];
			const result = await runCase(evalCase, {
				...options,
				model: target?.model ?? job.model,
				provider: target?.provider ?? options.provider,
			});
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
		if (rateLimitDelayMs > 0) {
			await sleep(rateLimitDelayMs);
		}
	}
	await Promise.all(executing);

	const suites: Record<string, SuiteResult> = {};
	for (const model of models) {
		const results = resultsByModel[model]!;
		const passed = results.filter((r) => r.passed).length;
		// Aggregate usage across all cases for this model
		const usage = results.reduce(
			(acc, r) => ({
				promptTokens: acc.promptTokens + r.usage.promptTokens,
				completionTokens: acc.completionTokens + r.usage.completionTokens,
				totalTokens: acc.totalTokens + r.usage.totalTokens,
				cost: acc.cost + (r.usage.cost ?? 0),
				cacheReadTokens: acc.cacheReadTokens + (r.usage.cacheReadTokens ?? 0),
				cacheWriteTokens: acc.cacheWriteTokens + (r.usage.cacheWriteTokens ?? 0),
				uncachedTokens: acc.uncachedTokens + (r.usage.uncachedTokens ?? 0),
			}),
			{
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cost: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedTokens: 0,
			},
		);
		suites[model] = {
			model,
			total: results.length,
			passed,
			failed: results.length - passed,
			duration: modelEndTime[model]! - overallStart,
			results,
			usage,
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
		const cost = s.usage.cost > 0 ? `$${s.usage.cost.toFixed(4)}` : "n/a";
		console.log(
			`  ${padCell(model, idWidth)} ${s.passed}/${s.total} passed  (${(s.duration / 1000).toFixed(1)}s, ${s.usage.totalTokens.toLocaleString()} tokens, ${cost})`,
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
					usage: s.usage,
					cases: s.results.map((r) => ({
						id: r.caseId,
						passed: r.passed,
						duration: r.duration,
						turns: r.turns,
						toolsCalled: r.toolsCalled,
						failedChecks: r.failedChecks,
						trace: r.trace,
						usage: r.usage,
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
		usage: suite.usage,
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
			usage: r.usage,
		})),
	};

	writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}
