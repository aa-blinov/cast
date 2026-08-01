import { EOL } from "node:os";
import { createInterface } from "node:readline";
import { noPickers } from "../pickers/no-pickers.ts";
import { resolveProvider } from "./config.ts";
import { initialAnnouncedLocalDate } from "./date-rollover-reminder.ts";
import { runHooksForEvent } from "./hooks.ts";
import type { AgentEvent } from "./loop.ts";
import { runAgentLoop } from "./loop.ts";
import { closeMcpConnections, formatMcpForPrompt } from "./mcp.ts";
import {
	createPlanState,
	createPlanTodos,
	modeDisabledTools,
	PLAN_TOOL_NAMES,
	QUESTION_TOOL_NAME,
	readActivePlan,
	resolvePlanQuestion,
	resolvePlanTransition,
} from "./plan.ts";
import {
	addUsage,
	appendMessage,
	getFullHistory,
	recordCompaction,
	resetSessionContext,
	type SessionState,
	saveSession,
} from "./session.ts";
import { loadSettings } from "./settings.ts";
import type { ParsedArgs } from "./startup.ts";
import { runStartup } from "./startup.ts";

// ============================================================================
// Non-interactive runner — `cast run "message"`
// ============================================================================

export interface RunOptions {
	message: string;
	format: "default" | "json";
}

type InteractiveAction =
	| { type: "prompt"; text: string }
	| { type: "set_mode"; mode: "plan" | "build" }
	| { type: "answer_question"; values: string[] }
	| { type: "plan_review"; choice: "continue" | "implement" | "clean" }
	| { type: "state" }
	| { type: "exit" };

export function parseInteractiveAction(line: string): InteractiveAction {
	const value: unknown = JSON.parse(line);
	if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
		throw new Error("action.type is required");
	}
	const action = value as Record<string, unknown>;
	if (action.type === "prompt") {
		if (typeof action.text !== "string") throw new Error("prompt.text must be a string");
		return { type: "prompt", text: action.text };
	}
	if (action.type === "set_mode") {
		if (action.mode !== "plan" && action.mode !== "build") throw new Error("set_mode.mode must be plan or build");
		return { type: "set_mode", mode: action.mode };
	}
	if (action.type === "answer_question") {
		if (!Array.isArray(action.values) || action.values.some((item) => typeof item !== "string")) {
			throw new Error("answer_question.values must be an array of strings");
		}
		return { type: "answer_question", values: action.values };
	}
	if (action.type === "plan_review") {
		if (action.choice !== "continue" && action.choice !== "implement" && action.choice !== "clean") {
			throw new Error("plan_review.choice must be continue, implement, or clean");
		}
		return { type: "plan_review", choice: action.choice };
	}
	if (action.type === "state" || action.type === "exit") return { type: action.type };
	throw new Error(`unknown action type: ${action.type}`);
}

/** JSONL protocol for a persistent, scriptable agent session. The ordinary
 * `cast run "…"` remains a one-shot command; this mode exists for evaluators
 * and agents that must observe a picker before deciding the next action. */
export async function runInteractive(args: ParsedArgs): Promise<void> {
	const result = await runStartup(args, noPickers);
	const {
		config,
		session,
		systemPrompt,
		runner,
		mcpResult,
		hooks,
		skills,
		confirmBash,
		permissionMode,
		personas,
		persona,
		subagentPrompts,
		subagentModel,
		planModel,
		planModelProvider,
	} = result;
	const planState = createPlanState(result.cwd, session.id, {
		question: session.planQuestion,
		transition: session.planTransition,
		onChange: (question, transition) => {
			session.planQuestion = question;
			session.planTransition = transition;
			saveSession(session);
		},
	});

	const emit = (type: string, data: Record<string, unknown> = {}) => {
		process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: session.id, ...data }) + EOL);
	};
	const snapshot = () => {
		const activePlan = readActivePlan(planState);
		emit("state", {
			mode: session.mode ?? "build",
			status: runner.isRunning ? "running" : "idle",
			messages: getFullHistory(session.id).filter((message) => message.role !== "system"),
			contextMessageCount: session.messages.length,
			question: session.planQuestion ?? null,
			planReview: session.planTransition ?? null,
			activePlan: activePlan.exists ? { path: activePlan.path, content: activePlan.content } : null,
		});
	};

	if (hooks) {
		await runHooksForEvent(hooks, {
			event: "SessionStart",
			cwd: result.cwd,
			sessionId: session.id,
			payload: { source: session.messages.length > 0 ? "resume" : "startup" },
		});
	}

	const runPrompt = async (text: string): Promise<void> => {
		if (!text.trim()) throw new Error("prompt text is required");
		if (session.planQuestion) throw new Error("answer the pending question before sending another prompt");
		if (session.planTransition) throw new Error("resolve the pending plan review before sending another prompt");
		let promptText = text;
		if (hooks) {
			const hookResult = await runHooksForEvent(hooks, {
				event: "UserPromptSubmit",
				cwd: result.cwd,
				sessionId: session.id,
				payload: { prompt: promptText },
			});
			if (hookResult.blocked) throw new Error(`prompt blocked by hook: ${hookResult.reason ?? "no reason given"}`);
			if (hookResult.reason) promptText = `${promptText}\n\n<hook-context>${hookResult.reason}</hook-context>`;
		}

		appendMessage(session, { role: "user", content: promptText });
		saveSession(session);
		planState.enabled = session.mode === "plan";
		const disabledTools = new Set(modeDisabledTools(planState.enabled));
		if (loadSettings().webTools !== true) {
			disabledTools.add("web_search");
			disabledTools.add("web_fetch");
		}
		const activeSettings = loadSettings();
		const activeProvider = { baseURL: config.baseURL, apiKey: config.apiKey };
		const modelProvider =
			planState.enabled && planModel
				? resolveProvider(activeSettings.providers ?? [], planModelProvider, activeProvider)
				: undefined;
		const ac = new AbortController();
		runner.startRun(ac);
		try {
			if (!session.lastAnnouncedLocalDate) session.lastAnnouncedLocalDate = initialAnnouncedLocalDate(session);
			const finalMessages = await runAgentLoop(session.messages, {
				config,
				model: planState.enabled && planModel ? planModel : session.model,
				modelProvider,
				cwd: result.cwd,
				systemPrompt,
				signal: ac.signal,
				steeringQueue: runner.steeringQueue,
				followUpQueue: runner.followUpQueue,
				confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
				mcpTools: mcpResult.toolDefinitions,
				mcpToolIndex: mcpResult.toolIndex,
				hooks,
				sessionId: session.id,
				permissionMode,
				skills,
				lastPromptTokens: session.lastPromptTokens,
				personas,
				currentPersona: persona.name,
				subagentPrompts,
				subagentModel,
				disabledTools,
				projectTrusted: result.projectTrusted,
				noSkills: result.projectDeps.noSkills,
				cliSkillPaths: result.projectDeps.cliSkillPaths,
				sshHosts: result.sshHosts,
				mcpPromptSuffix: formatMcpForPrompt(mcpResult),
				planState,
				initialTodos: session.todos,
				announcedLocalDate: {
					get value() {
						return session.lastAnnouncedLocalDate!;
					},
					set value(next: string) {
						session.lastAnnouncedLocalDate = next;
					},
				},
				onCompaction: (full, compacted) => recordCompaction(session, full, compacted),
				onEvent: (event) => handleEvent(event, session, "json"),
			});
			session.messages = finalMessages;
		} finally {
			runner.endRun();
			saveSession(session);
		}
	};

	const handleAction = async (action: InteractiveAction): Promise<boolean> => {
		if (action.type === "exit") return false;
		if (action.type === "state") return true;
		if (runner.isRunning) throw new Error("agent is running");
		if (action.type === "set_mode") {
			if (session.planQuestion || session.planTransition)
				throw new Error("resolve the pending picker before changing mode");
			session.mode = action.mode;
			planState.enabled = action.mode === "plan";
			saveSession(session);
			return true;
		}
		if (action.type === "answer_question") {
			const question = session.planQuestion;
			if (!question) throw new Error("no question is awaiting an answer");
			if (action.values.length !== question.questions.length)
				throw new Error("an answer is required for every question");
			const selected = question.questions.map((item, index) =>
				item.options.find((option) => option.value === action.values[index]),
			);
			if (selected.some((option) => !option)) throw new Error("unknown question option");
			resolvePlanQuestion(planState);
			await runPrompt(
				question.questions
					.map((item, index) => `The user selected "${selected[index]!.label}" for: ${item.question}`)
					.join("\n"),
			);
			return true;
		}
		if (action.type === "plan_review") {
			if (!session.planTransition) throw new Error("no plan review is awaiting a choice");
			resolvePlanTransition(planState);
			if (action.choice === "continue") return true;
			session.todos = createPlanTodos(planState);
			const originalTask = action.choice === "clean" ? resetSessionContext(session) : undefined;
			session.mode = "build";
			planState.enabled = false;
			saveSession(session);
			await runPrompt(
				action.choice === "clean"
					? `<system-reminder>Clean build context. Original task: ${originalTask ?? "Use the approved plan as the task definition."}</system-reminder>\n\nThe plan is approved. Implement it step by step.`
					: "The plan is approved. Implement it step by step.",
			);
			return true;
		}
		await runPrompt(action.text);
		return true;
	};

	const onSigint = () => runner.abort();
	process.on("SIGINT", onSigint);
	try {
		snapshot();
		const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
		for await (const line of input) {
			try {
				const action = parseInteractiveAction(line);
				const keepGoing = await handleAction(action);
				snapshot();
				if (!keepGoing) break;
			} catch (error) {
				emit("error", { message: error instanceof Error ? error.message : String(error) });
				snapshot();
			}
		}
	} finally {
		runner.endRun();
		saveSession(session);
		process.off("SIGINT", onSigint);
		await closeMcpConnections(mcpResult.connections);
		if (hooks) {
			await runHooksForEvent(hooks, {
				event: "SessionEnd",
				cwd: result.cwd,
				sessionId: session.id,
				payload: { reason: "exit" },
			});
		}
	}
}

/**
 * Run a single prompt non-interactively: startup → send → stream to stdout →
 * save session → exit. Reuses runStartup for model/persona/session resolution
 * and runAgentLoop for the actual LLM call + tool execution.
 */
export async function runNonInteractive(args: ParsedArgs, options: RunOptions): Promise<void> {
	const result = await runStartup(args, noPickers);
	const {
		config,
		session,
		systemPrompt,
		runner,
		mcpResult,
		hooks,
		skills,
		confirmBash,
		permissionMode,
		personas,
		persona,
		subagentPrompts,
		subagentModel,
	} = result;

	if (hooks) {
		await runHooksForEvent(hooks, {
			event: "SessionStart",
			cwd: result.cwd,
			sessionId: session.id,
			payload: { source: session.messages.length > 0 ? "resume" : "startup" },
		});
	}

	let promptText = options.message;
	if (hooks) {
		const submitResult = await runHooksForEvent(hooks, {
			event: "UserPromptSubmit",
			cwd: result.cwd,
			sessionId: session.id,
			payload: { prompt: promptText },
		});
		if (submitResult.blocked) {
			console.error(`[Prompt blocked by hook: ${submitResult.reason ?? "no reason given"}]`);
			await runHooksForEvent(hooks, {
				event: "SessionEnd",
				cwd: result.cwd,
				sessionId: session.id,
				payload: { reason: "prompt_denied" },
			});
			await closeMcpConnections(mcpResult.connections);
			process.exitCode = 1;
			process.exit(1);
		}
		if (submitResult.reason) promptText = `${promptText}\n\n<hook-context>${submitResult.reason}</hook-context>`;
	}
	appendMessage(session, { role: "user", content: promptText });

	const settings = loadSettings();
	const disabledTools = new Set<string>();
	if (settings.webTools !== true) {
		disabledTools.add("web_search");
		disabledTools.add("web_fetch");
	}
	// Headless runs have no plan mode, so the plan tools must be neither
	// advertised nor executable.
	for (const name of PLAN_TOOL_NAMES) disabledTools.add(name);
	disabledTools.add(QUESTION_TOOL_NAME);
	// But an approved plan still steers: resuming a session that has one
	// (`cast run -c "..."`) injects the same build-mode mirror block as the TUI
	// — without this, headless continuation silently ignored the plan.
	const planState = createPlanState(result.cwd, session.id);

	const ac = new AbortController();
	runner.startRun(ac);

	const onSigint = () => runner.abort();
	process.on("SIGINT", onSigint);

	try {
		if (!session.lastAnnouncedLocalDate) {
			session.lastAnnouncedLocalDate = initialAnnouncedLocalDate(session);
		}
		const announcedLocalDate = {
			get value() {
				return session.lastAnnouncedLocalDate!;
			},
			set value(next: string) {
				session.lastAnnouncedLocalDate = next;
			},
		};
		const finalMessages = await runAgentLoop(session.messages, {
			config,
			model: session.model,
			cwd: result.cwd,
			systemPrompt,
			signal: ac.signal,
			confirmBash: permissionMode === "bypass" ? undefined : confirmBash,
			mcpTools: mcpResult.toolDefinitions,
			mcpToolIndex: mcpResult.toolIndex,
			hooks,
			sessionId: session.id,
			permissionMode,
			skills,
			lastPromptTokens: session.lastPromptTokens,
			personas,
			currentPersona: persona.name,
			subagentPrompts,
			subagentModel,
			disabledTools,
			projectTrusted: result.projectTrusted,
			noSkills: result.projectDeps.noSkills,
			cliSkillPaths: result.projectDeps.cliSkillPaths,
			sshHosts: result.sshHosts,
			mcpPromptSuffix: formatMcpForPrompt(mcpResult),
			planState,
			initialTodos: session.todos,
			announcedLocalDate,
			onCompaction: (full, compacted) => recordCompaction(session, full, compacted),
			onEvent: (event: AgentEvent) => handleEvent(event, session, options.format),
		});

		session.messages = finalMessages;
	} finally {
		runner.endRun();
		saveSession(session);
		process.off("SIGINT", onSigint);
		await closeMcpConnections(mcpResult.connections);
		if (hooks) {
			await runHooksForEvent(hooks, {
				event: "SessionEnd",
				cwd: result.cwd,
				sessionId: session.id,
				payload: { reason: "exit" },
			});
		}
	}

	process.exit(0);
}

function handleEvent(event: AgentEvent, session: SessionState, format: "default" | "json"): void {
	const emit = (type: string, data: Record<string, unknown>): boolean => {
		if (format === "json") {
			process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: session.id, ...data }) + EOL);
			return true;
		}
		return false;
	};

	switch (event.type) {
		case "token":
			if (!emit("token", { text: event.text })) {
				process.stdout.write(event.text);
			}
			break;

		case "thinking":
			emit("thinking", { text: event.text });
			break;

		case "assistant_message":
			if (!emit("assistant_message", { content: event.content, toolCalls: event.toolCalls })) {
				if (event.content) process.stdout.write(EOL);
			}
			break;

		case "tool_start":
			if (!emit("tool_start", { id: event.id, name: event.name, args: event.args })) {
				process.stderr.write(`  ${event.name}...${EOL}`);
			}
			break;

		case "tool_end":
			if (!emit("tool_end", { id: event.id, name: event.name, result: event.result })) {
				if (event.result.isError) {
					process.stderr.write(`  ${event.name} failed: ${event.result.content}${EOL}`);
				}
			}
			break;

		case "doom_loop":
			if (!emit("doom_loop", { tool: event.tool, attempts: event.attempts })) {
				process.stderr.write(`  doom loop: ${event.tool} blocked after ${event.attempts} identical calls${EOL}`);
			}
			break;

		case "usage":
			addUsage(session, event.usage, { subagent: event.subagent });
			emit("usage", { usage: event.usage, subagent: event.subagent });
			break;

		case "todos_updated":
			session.todos = event.todos;
			emit("todos_updated", { todos: event.todos });
			break;

		case "end":
			if (!emit("end", { reason: event.reason })) {
				if (event.reason === "error") process.exitCode = 1;
			}
			break;

		case "error":
			if (!emit("error", { message: event.message })) {
				process.stderr.write(`Error: ${event.message}${EOL}`);
				process.exitCode = 1;
			}
			break;

		default:
			break;
	}
}
