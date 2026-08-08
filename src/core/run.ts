import { EOL } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	answerServerQuestion,
	createServerSession,
	ensureServerClient,
	ensureServerSession,
	getServerSession,
	resolveServerPlanTransition,
	runServerCommand,
	setServerMode,
	submitServerChat,
	subscribeServerEvents,
} from "../server/client.ts";
import { loadSettings } from "./settings.ts";
import type { ParsedArgs } from "./startup.ts";

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
/** JSONL protocol for a persistent, scriptable agent session, running on the
 * shared server daemon. The ordinary `cast run "…"` remains a one-shot; this
 * mode exists for evaluators and agents that must observe a picker before
 * deciding the next action. Every action maps to a server endpoint (chat,
 * /command, /mode, /question, /plan-transition) and events stream over SSE —
 * so the session lives in the same store the TUI and web UI use. */
export async function runInteractive(args: ParsedArgs): Promise<void> {
	const client = await ensureServerClient();
	if (!client) {
		console.error("cast run --interactive requires the server daemon (unset CAST_NO_DAEMON to disable the check).");
		process.exit(1);
	}
	const settings = loadSettings();
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");
	const sessionId = await createServerSession(client, {
		persona: args.cliPersona ?? settings.persona,
		model: args.cliModel ?? settings.model,
		cwd,
	});

	const emit = (type: string, data: Record<string, unknown> = {}) => {
		process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID: sessionId, ...data }) + EOL);
	};
	// Server events → JSONL, mirroring the old local handleEvent shape.
	const onEvent = (event: import("../server/bridge.ts").WebEvent) => {
		switch (event.type) {
			case "token":
				emit("token", { text: event.text });
				break;
			case "thinking":
				emit("thinking", { text: event.text });
				break;
			case "assistant_message":
				emit("assistant_message", { content: event.content, toolCalls: event.toolCalls });
				break;
			case "tool_start":
				emit("tool_start", { id: event.id, name: event.name, args: event.args, status: event.status });
				break;
			case "tool_end":
				emit("tool_end", { id: event.id, name: event.name, result: event.result, status: event.status });
				break;
			case "usage":
				emit("usage", { usage: event.usage, subagent: event.subagent });
				break;
			case "todos_updated":
				emit("todos_updated", { todos: event.todos });
				break;
			case "end":
				emit("end", { reason: event.reason });
				break;
			case "error":
				emit("error", { message: event.message });
				break;
			case "notice":
				emit("notice", { text: event.message });
				break;
			case "status":
				if (event.status === "idle") emit("end", { reason: "stop" });
				break;
			default:
				break;
		}
	};

	// Wait-for-turn: resolve when the server says the session is idle again.
	const waitForIdle = (): Promise<void> => {
		const { done } = subscribeServerEvents(
			client,
			sessionId,
			onEvent,
			(event) => event.type === "session_end" || event.type === "session_closed",
		);
		return done;
	};

	const emitState = async (): Promise<void> => {
		const s = await getServerSession(client, sessionId);
		emit("state", {
			mode: s.mode ?? "build",
			status: s.status ?? "idle",
			messages: (s.messages as unknown[]) ?? [],
			question: s.question ?? null,
			planReview: s.planTransition ?? null,
			cwd: s.cwd ?? cwd,
		});
	};

	const handleAction = async (action: InteractiveAction): Promise<boolean> => {
		if (action.type === "exit") return false;
		if (action.type === "state") {
			await emitState();
			return true;
		}
		if (action.type === "command") {
			try {
				const result = await runServerCommand(client, sessionId, `/${action.name}${action.args}`);
				emit("notice", { text: String(result ?? "") });
			} catch (e) {
				emit("error", { message: e instanceof Error ? e.message : String(e) });
			}
			await emitState();
			return true;
		}
		if (action.type === "set_mode") {
			await setServerMode(client, sessionId, action.mode);
			await emitState();
			return true;
		}
		if (action.type === "answer_question") {
			await answerServerQuestion(client, sessionId, action.values);
			const idle = waitForIdle();
			await submitServerChat(client, sessionId, action.values.join(" "));
			await idle;
			await emitState();
			return true;
		}
		if (action.type === "plan_review") {
			await resolveServerPlanTransition(client, sessionId);
			if (action.choice === "continue") {
				await emitState();
				return true;
			}
			const idle = waitForIdle();
			await submitServerChat(
				client,
				sessionId,
				action.choice === "clean"
					? "<system-reminder>Clean build context. Use the approved plan as the task definition.</system-reminder>\n\nThe plan is approved. Implement it step by step."
					: "The plan is approved. Implement it step by step.",
			);
			await idle;
			await emitState();
			return true;
		}
		const idle = waitForIdle();
		await submitServerChat(client, sessionId, action.text);
		await idle;
		await emitState();
		return true;
	};

	const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of input) {
		try {
			const action = parseInteractiveAction(line);
			const keepGoing = await handleAction(action);
			if (!keepGoing) break;
		} catch (error) {
			emit("error", { message: error instanceof Error ? error.message : String(error) });
		}
	}
	process.exit(0);
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
	// the daemon create/resume the session (it applies its own provider settings).
	const settings = loadSettings();
	const cwd = process.env.CAST_CWD ? resolve(process.env.CAST_CWD) : resolve(".");
	const { id: sessionId } = await ensureServerSession(client, {
		persona: args.cliPersona ?? settings.persona,
		model: args.cliModel ?? settings.model,
		cwd,
		resumeId: args.resumeId,
		resumeRequested: args.resumeRequested,
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
