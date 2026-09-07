import { EOL } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	answerServerQuestion,
	ensureServerClient,
	ensureServerSession,
	getServerSession,
	killServerBackgroundTasks,
	resolveServerPlanTransition,
	runServerCommand,
	type ServerClient,
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
	/** Leave background tasks this run started running after it exits. */
	keepBackground?: boolean;
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
	let { id: sessionId } = await ensureServerSession(client, {
		persona: args.cliPersona ?? settings.persona,
		model: args.cliModel ?? settings.model,
		cwd,
		resumeId: args.resumeId,
		resumeRequested: args.resumeRequested,
		worktree: args.worktree,
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
			case "retry":
				// A retry can now be a *long* wait — a quota window measured in
				// hours, when retryQuotaWaitSeconds is set. Dropping the event
				// left `cast run` looking hung with nothing on either stream.
				emit("retry", { attempt: event.attempt, reason: event.reason });
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
				if (action.name === "fork" && result && typeof result === "object" && "sessionId" in result) {
					const forkId = (result as { sessionId?: unknown }).sessionId;
					if (typeof forkId === "string" && forkId) sessionId = forkId;
				}
				emit("notice", {
					text: result && typeof result === "object" ? JSON.stringify(result) : String(result ?? ""),
				});
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
			// answerServerQuestion resolves the pending question AND submits the
			// rendered answer on the server (bridge.answerQuestion → submit) —
			// don't submit again, just wait for the turn to settle.
			await answerServerQuestion(client, sessionId, action.values);
			const idle = waitForIdle();
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
			// Approving switches the session to build mode (the local runner did
			// the same: session.mode = "build") so the model can edit real files.
			await setServerMode(client, sessionId, "build");
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
	const { id: sessionId, resumed } = await ensureServerSession(client, {
		persona: args.cliPersona ?? settings.persona,
		model: args.cliModel ?? settings.model,
		cwd,
		resumeId: args.resumeId,
		resumeRequested: args.resumeRequested,
		worktree: args.worktree,
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
				case "notice":
					// Dropped entirely before — which silently swallowed the
					// runaway-loop iteration cap, /goal budget exhaustion and a
					// model refusal, all of which end the turn with reason
					// "stop". The interactive/JSONL path already forwards these.
					if (!emit("notice", { text: event.message })) {
						process.stderr.write(`  ${event.message}${EOL}`);
					}
					break;
				case "retry":
					// Same reason as the JSONL path: with a quota wait
					// configured this is a pause of minutes to hours, and a
					// silent one reads as a hang.
					if (!emit("retry", { attempt: event.attempt, reason: event.reason })) {
						process.stderr.write(`  Retry ${event.attempt}: ${event.reason}${EOL}`);
					}
					break;
				case "end":
					// Any reason but a clean stop (or a user abort) means what
					// reached stdout is incomplete. "disconnected" in particular
					// is loop.ts's signal that the provider cut the stream
					// mid-response — it exists so a truncated answer isn't taken
					// for a clean one, and `out=$(cast run …)` can only see that
					// through the exit code.
					if (event.reason !== "stop" && event.reason !== "aborted") failed = true;
					if (!emit("end", { reason: event.reason })) {
						if (event.reason !== "stop" && event.reason !== "aborted") {
							process.stderr.write(`Turn ended early: ${event.reason}${EOL}`);
							process.exitCode = 1;
						}
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
	await settleBackgroundTasks(client, sessionId, emit, {
		ownsSession: !resumed,
		keepBackground: options.keepBackground === true,
	});
	if (failed) process.exitCode = 1;
}

/**
 * Deal with background tasks the turn leaves behind.
 *
 * They live in the daemon, not in this process, so `cast run` used to exit
 * while they kept going — nothing killed them, nothing said so, and a session
 * with a running task is never idle-evicted either. Verified live: the run
 * printed "DONE", exited 0, and `sleep 432` was still running afterwards.
 * The TUI has always killed its own on exit (tui.tsx), and the daemon kills a
 * session's when it is closed or deleted; a one-shot run was the only surface
 * that leaked.
 *
 * So a run that created its own session cleans up after itself. A run that
 * attached to an existing one (`--resume` / `--continue`) must not: those
 * tasks belong to whoever started them. `--keep-background` opts out for the
 * deliberate "start the dev server and leave it" case, and then the tasks are
 * at least named on the way out.
 */
async function settleBackgroundTasks(
	client: ServerClient,
	sessionId: string,
	emit: (type: string, data: Record<string, unknown>) => boolean,
	opts: { ownsSession: boolean; keepBackground: boolean },
): Promise<void> {
	let tasks: Array<{ id: string; command: string }> = [];
	try {
		const session = await getServerSession(client, sessionId);
		const raw = session.backgroundTasks;
		if (Array.isArray(raw)) {
			tasks = (raw as Array<{ id?: unknown; command?: unknown }>).map((task) => ({
				id: typeof task.id === "string" ? task.id : "?",
				command: typeof task.command === "string" ? task.command : "?",
			}));
		}
	} catch {
		// Best-effort: a daemon that just went away must not turn a finished
		// run into a failure.
		return;
	}
	if (tasks.length === 0) return;

	if (opts.ownsSession && !opts.keepBackground) {
		let killed: Array<{ id: string; command: string }> = [];
		try {
			killed = await killServerBackgroundTasks(client, sessionId);
		} catch {
			killed = [];
		}
		// Only the daemon's own answer counts as proof. An earlier version fell
		// back to the list it had already fetched, and printed "Stopped 1
		// background task" for a call that had 404'd — the task was still
		// running, which a live check caught. Unconfirmed means say so.
		if (killed.length === 0) {
			reportStillRunning(sessionId, tasks, emit);
			return;
		}
		if (emit("background_tasks_killed", { sessionId, tasks: killed })) return;
		const lines = killed.map((task) => `  ${task.id}: ${task.command}`);
		process.stderr.write(
			`Stopped ${killed.length} background task${killed.length === 1 ? "" : "s"} started by this run:${EOL}${lines.join(EOL)}${EOL}` +
				`Pass --keep-background to leave them running.${EOL}`,
		);
		return;
	}

	reportStillRunning(sessionId, tasks, emit);
}

function reportStillRunning(
	sessionId: string,
	tasks: Array<{ id: string; command: string }>,
	emit: (type: string, data: Record<string, unknown>) => boolean,
): void {
	if (emit("background_tasks_running", { sessionId, tasks })) return;
	const lines = tasks.map((task) => `  ${task.id}: ${task.command}`);
	process.stderr.write(
		`${tasks.length} background task${tasks.length === 1 ? "" : "s"} still running in session ${sessionId}:${EOL}${lines.join(EOL)}${EOL}` +
			`They keep running in the daemon. Stop them with \`cast\` (bash_kill) or shut it down with \`cast server stop\`.${EOL}`,
	);
}
