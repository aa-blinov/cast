import { EOL } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { noPickers } from "../pickers/no-pickers.ts";
import { createServerSession, ensureServerClient, submitServerChat, subscribeServerEvents } from "../server/client.ts";
// `handleInput` lives in `ui/commands.ts` because it owns the full TUI
// command palette. `core/run.ts` is allowed to import from `ui/` only
// because the file has no React/Ink side effects at import time — both
// `SLASH_COMMANDS` and `handleInput` are pure — so the JSONL runner can
// dispatch slash commands without dragging the Ink renderer into headless
// mode. If `ui/commands.ts` ever starts importing Ink, this bridge has to
// move to a `core/commands.ts` instead.
import { type CommandDeps, handleInput } from "../ui/commands.ts";
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
	| { type: "command"; name: string; args: string }
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
	if (action.type === "command") {
		// `name` is the slash command without the leading "/" (e.g. "worktree",
		// "skills", "persona"). `args` is the rest of the line, verbatim —
		// including the leading space when present, which `handleInput` expects
		// to slice off when picking the verb. Empty string for commandlets.
		if (typeof action.name !== "string" || !action.name) {
			throw new Error("command.name must be a non-empty string");
		}
		if (typeof action.args !== "string") throw new Error("command.args must be a string");
		return { type: "command", name: action.name, args: action.args };
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
	const loadedSettings = loadSettings();
	// Headless CommandDeps — every field is a closure over a `let`, so
	// `setX` mutates the slot synchronously and the next `getX` reads the
	// updated value. Mirrors React's setState contract for `X | (prev => X)`
	// because `handleInput` calls it both ways (e.g. `setSkills([...])` for
	// fresh values, but rebuildSystemPrompt can use functional updates too).
	type HeadlessCtx = {
		cwd: string;
		skills: typeof skills;
		skillsPromptSuffix: string;
		contextFilesSuffix: string;
		rulesSuffix: string;
		rulesLazySuffix: string;
		directoryRules: import("../core/rules.ts").Rule[];
		activeAutoRules: import("../core/rules.ts").Rule[];
		systemPrompt: string;
		mcpResult: typeof mcpResult;
		projectTrusted: boolean;
		persona: typeof persona;
		personaOptions: typeof result.personaOptions;
		sshHosts: typeof result.sshHosts;
		permissionMode: typeof permissionMode;
		webToolsEnabled: boolean;
		planMode: boolean;
		planModel: typeof planModel;
		planModelProvider: typeof planModelProvider;
		subagentModel: typeof subagentModel;
		subagentModelProvider: string | undefined;
		reasoningMeta: typeof result.reasoningMeta;
		statusBar: import("../core/settings.ts").StatusBarConfig;
	};
	const ctx: HeadlessCtx = {
		cwd: session.cwd ?? result.cwd,
		skills,
		skillsPromptSuffix: "",
		contextFilesSuffix: "",
		rulesSuffix: "",
		rulesLazySuffix: "",
		directoryRules: [],
		activeAutoRules: [],
		systemPrompt,
		mcpResult,
		projectTrusted: result.projectTrusted,
		persona: persona,
		personaOptions: result.personaOptions,
		sshHosts: result.sshHosts,
		permissionMode,
		webToolsEnabled: loadedSettings.webTools === true,
		planMode: session.mode === "plan",
		planModel,
		planModelProvider,
		subagentModel,
		subagentModelProvider: loadedSettings.subagentModelProvider,
		reasoningMeta: result.reasoningMeta,
		statusBar: loadedSettings.statusBar ?? { visible: [], order: [], sides: {} },
	};
	const makeSetter =
		<K extends keyof HeadlessCtx>(key: K) =>
		(action: HeadlessCtx[K] | ((prev: HeadlessCtx[K]) => HeadlessCtx[K])) => {
			if (typeof action === "function") {
				ctx[key] = (action as (prev: HeadlessCtx[K]) => HeadlessCtx[K])(ctx[key]);
			} else {
				ctx[key] = action;
			}
		};
	// Stubs for the agent surface — only `refresh()` is needed by the
	// command handlers we test. The other methods are wired for completeness
	// so any future command doesn't crash on a missing implementation.
	const headlessAgent = {
		submit: async () => {
			throw new Error("agent.submit is not supported in --interactive JSONL mode; send a prompt action instead");
		},
		steer: () => {
			throw new Error("agent.steer is not supported in --interactive JSONL mode");
		},
		followUp: () => {
			throw new Error("agent.followUp is not supported in --interactive JSONL mode");
		},
		abort: () => {
			runner.abort();
		},
		resetContext: () => undefined as string | undefined,
		refresh: () => {
			// In TUI, refresh re-runs `buildDisplayMessages(getFullHistory(...))`
			// from session state. Headless has no display, but the JSONL
			// consumer can re-request `state` to pick up changes — so refresh
			// is a no-op here.
		},
		refreshMeta: () => {},
		resetQueue: () => {},
		clearContext: () => {
			// TUI calls this from /clear; headless has no agent messages to
			// wipe, the session.messages reset happens via session APIs.
		},
		addDisplayMessage: () => {
			// Display-only messages are not surfaced through JSONL — they're
			// a TUI affordance. Sliently drop them in headless.
		},
		turnStartedAt: null,
		getElapsedMs: () => 0,
		pendingSteers: [],
		pendingQueue: [],
		messages: [],
		streaming: null,
		status: "idle" as "idle" | "running",
		error: null,
		retry: null,
		usage: null,
		lastTurnUsage: null,
	} as unknown as Parameters<typeof handleInput>[2]["agent"];
	const commandDeps: CommandDeps = {
		agent: headlessAgent,
		session,
		config,
		running: runner.isRunning,
		onQuit: () => {
			throw new Error("onQuit is not supported in --interactive JSONL mode; send an exit action instead");
		},
		// Notice channel: in TUI, showNotice paints a transient toast. Here
		// we forward the text to stdout as a `notice` event so the JSONL
		// consumer (test, agent, evaluator) can observe it like any other
		// protocol event. Drops the optional duration arg silently.
		showNotice: (text: string) => emit("notice", { text }),
		cwd: ctx.cwd,
		setCwd: makeSetter("cwd"),
		currentPersona: ctx.persona,
		setCurrentPersona: (next) => {
			ctx.persona = next;
		},
		personaOptions: ctx.personaOptions,
		setPersonaOptions: makeSetter("personaOptions"),
		skills: ctx.skills,
		setSkills: makeSetter("skills"),
		skillsPromptSuffix: ctx.skillsPromptSuffix,
		setSkillsPromptSuffix: makeSetter("skillsPromptSuffix"),
		contextFilesSuffix: ctx.contextFilesSuffix,
		setContextFilesSuffix: makeSetter("contextFilesSuffix"),
		rulesSuffix: ctx.rulesSuffix,
		setRulesSuffix: makeSetter("rulesSuffix"),
		rulesLazySuffix: ctx.rulesLazySuffix,
		setRulesLazySuffix: makeSetter("rulesLazySuffix"),
		directoryRules: ctx.directoryRules,
		setDirectoryRules: makeSetter("directoryRules"),
		activeAutoRules: ctx.activeAutoRules,
		setActiveAutoRules: makeSetter("activeAutoRules"),
		systemPrompt: ctx.systemPrompt,
		setSystemPrompt: makeSetter("systemPrompt"),
		mcpResult: ctx.mcpResult,
		setMcpResult: makeSetter("mcpResult"),
		permissionMode: ctx.permissionMode,
		setPermissionMode: makeSetter("permissionMode"),
		projectTrusted: ctx.projectTrusted,
		setProjectTrusted: makeSetter("projectTrusted"),
		projectDeps: result.projectDeps,
		pickers: noPickers,
		sshHosts: ctx.sshHosts,
		setSshHosts: makeSetter("sshHosts"),
		reasoningMeta: ctx.reasoningMeta,
		setReasoningMeta: makeSetter("reasoningMeta"),
		subagentModel: ctx.subagentModel,
		setSubagentModel: makeSetter("subagentModel"),
		subagentModelProvider: ctx.subagentModelProvider,
		setSubagentModelProvider: makeSetter("subagentModelProvider"),
		webToolsEnabled: ctx.webToolsEnabled,
		setWebToolsEnabled: makeSetter("webToolsEnabled"),
		planMode: ctx.planMode,
		setPlanMode: makeSetter("planMode"),
		planModel: ctx.planModel,
		setPlanModel: makeSetter("planModel"),
		planModelProvider: ctx.planModelProvider,
		setPlanModelProvider: makeSetter("planModelProvider"),
		statusBar: ctx.statusBar,
		setStatusBar: makeSetter("statusBar"),
	};
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
			// `cwd` is the live source of truth after /worktree or /continue
			// run mid-session, while `result.cwd` is the startup-time snapshot.
			// Tests and tooling consume `state` to observe cwd changes without
			// having to inspect the session DB.
			cwd: session.cwd ?? result.cwd,
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
		// runStartup already persisted the session; re-save with the prompt appended.
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
			// `session.cwd` is the source of truth once the session exists —
			// /worktree (and /continue when restoring a session from another
			// checkout) mutate it directly, and subsequent runs must follow.
			// `result.cwd` is just the startup-time fallback for brand-new
			// sessions that haven't picked a cwd yet.
			const cwd = session.cwd ?? result.cwd;
			const finalMessages = await runAgentLoop(session.messages, {
				config,
				model: planState.enabled && planModel ? planModel : session.model,
				modelProvider,
				cwd,
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
		if (action.type === "command") {
			// Reconstruct the line shape `handleInput` expects. The parser
			// hands us `name` and `args` separately so the JSON wire format
			// stays clean; commands.ts's handleInput slices `args` off the
			// "/<name> " prefix to recover the verb + payload.
			const line = `/${action.name}${action.args}`;
			await handleInput(line, undefined, commandDeps);
			return true;
		}
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
					.map((item, index) => `Question: ${item.question} Answer: ${selected[index]!.label}`)
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
 * Run a single prompt non-interactively: ensure the server daemon is up,
 * create a session on it, submit the prompt, stream events to stdout, exit.
 * The daemon owns runAgentLoop (single-writer model); this is a thin client,
 * exactly like the TUI — so `cast run` sessions live in the same server the
 * TUI and web UI share, and continue running there after this process exits.
 */
export async function runNonInteractive(args: ParsedArgs, options: RunOptions): Promise<void> {
	const client = await ensureServerClient();
	if (!client) {
		console.error(
			"cast run requires the server daemon (set CAST_NO_DAEMON=1 to disable, but then run cannot attach).",
		);
		process.exit(1);
	}

	// Resolve model/persona/cwd the same way the TUI launcher does, then let
	// the daemon create the session (it applies its own provider settings).
	const settings = loadSettings();
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");
	const sessionId = await createServerSession(client, {
		persona: args.cliPersona ?? settings.persona,
		model: args.cliModel ?? settings.model,
		cwd,
	});

	let failed = false;
	const format = options.format;
	const emit = (type: string, data: Record<string, unknown>): boolean => {
		if (format === "json") {
			process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: sessionId, ...data }) + EOL);
			return true;
		}
		return false;
	};

	const { done } = subscribeServerEvents(
		client,
		sessionId,
		(event) => {
			switch (event.type) {
				case "token":
					if (!emit("token", { text: event.text })) process.stdout.write(event.text);
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
					if (!emit("tool_start", { id: event.id, name: event.name, args: event.args, status: event.status })) {
						process.stderr.write(`  ${event.name}...${EOL}`);
					}
					break;
				case "tool_end":
					if (!emit("tool_end", { id: event.id, name: event.name, result: event.result, status: event.status })) {
						if (event.result.isError) {
							process.stderr.write(`  ${event.name} failed: ${event.result.content}${EOL}`);
						}
					}
					break;
				case "doom_loop":
					if (!emit("doom_loop", { tool: event.tool, attempts: event.attempts })) {
						process.stderr.write(
							`  doom loop: ${event.tool} blocked after ${event.attempts} identical calls${EOL}`,
						);
					}
					break;
				case "usage":
					emit("usage", { usage: event.usage, subagent: event.subagent });
					break;
				case "todos_updated":
					emit("todos_updated", { todos: event.todos });
					break;
				case "end":
					if (event.reason === "error") failed = true;
					if (!emit("end", { reason: event.reason })) {
						if (event.reason === "error") process.exitCode = 1;
					}
					break;
				case "error":
					failed = true;
					if (!emit("error", { message: event.message })) {
						process.stderr.write(`Error: ${event.message}${EOL}`);
						process.exitCode = 1;
					}
					break;
				default:
					break;
			}
		},
		(event) =>
			event.type === "session_end" ||
			event.type === "session_closed" ||
			(event.type === "end" && event.reason !== "stop" && event.reason !== "aborted"),
	);

	await submitServerChat(client, sessionId, options.message);
	await done;
	if (failed) process.exitCode = 1;
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
			if (!emit("tool_start", { id: event.id, name: event.name, args: event.args, status: event.status })) {
				process.stderr.write(`  ${event.name}...${EOL}`);
			}
			break;

		case "tool_end":
			if (!emit("tool_end", { id: event.id, name: event.name, result: event.result, status: event.status })) {
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
