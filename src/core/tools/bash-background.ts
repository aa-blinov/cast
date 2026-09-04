/**
 * Background bash tasks — explicit `run_in_background:true` or automatic promotion on the
 * `bash` tool — run in a managed PTY and are tracked here for the lifetime of a session.
 * Completion is delivered as a `<system-reminder>` (same
 * convention as ../interrupt-reminder.ts): if the agent loop is still
 * running when the process exits, the reminder is enqueued onto the same
 * `followUpQueue` the loop already drains between turns (loop.ts:1043); if
 * the session is fully idle, `onIdleWake` (late-bound via `setOnIdleWake`,
 * since the caller's `submit` doesn't exist yet at registry-construction
 * time — see the TUI wiring in useAgentSession.ts) starts a fresh turn.
 *
 * Session-scoped and long-lived: a task started in one turn stays pollable
 * (`bash_output`) and killable (`bash_kill`) across every later turn until
 * the session itself closes, at which point `killAll()` reaps anything still
 * running. Never tied to a turn's AbortSignal — a `/abort` or a turn ending
 * must not kill a task the user explicitly asked to survive past it.
 */

import { type IPty, spawn as spawnPty } from "node-pty";
import type { AppConfig } from "../config.ts";
import type { Message } from "../llm.ts";
import type { MessageQueue } from "../loop.ts";
import { formatBashResult, getBashResolution, stripAnsi } from "./bash.ts";
import { appendBoundedOutput, formatSize, type ToolResult } from "./shared.ts";

const PTY_EXECVP_FAILURE_RE = /execvp\(3\) failed/i;
const NO_SUCH_FILE_RE = /no such file or directory/i;

/**
 * Did the shell itself fail to start, or did it start and run something that
 * failed?
 *
 * "no such file or directory" alone cannot tell those apart — it is what any
 * command says about a path it cannot find, so `ls /nope` on a non-zero exit
 * was being reported to the model as `Failed to start bash ("bash"): ls:
 * cannot access '/nope': No such file or directory`, which is false about the
 * shell and buries the real output behind a wrong explanation. A genuine spawn
 * failure either carries node-pty's execvp marker or names the shell binary
 * itself.
 */
export function isPtySpawnFailure(rawOutput: string, bashPath: string): boolean {
	if (PTY_EXECVP_FAILURE_RE.test(rawOutput)) return true;
	if (!NO_SUCH_FILE_RE.test(rawOutput)) return false;
	// A shell that cannot start says so in its own name at the head of a line
	// ("bash: /nope: No such file or directory"); a command's own complaint is
	// prefixed with that command's name instead.
	const shellName = bashPath.split("/").pop() || bashPath;
	return rawOutput
		.split("\n")
		.some((line) => line.trimStart().startsWith(`${bashPath}:`) || line.trimStart().startsWith(`${shellName}:`));
}

export interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	pty?: IPty;
	exitPromise: Promise<void>;
	status: "running" | "exited" | "killed" | "error";
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	/** Accumulated stdout+stderr, capped at config.maxToolOutputBytes — mirrors bash.ts's sync path. */
	rawOutput: string;
	outputTruncated: boolean;
	timedOut: boolean;
	/** The kill-timer duration, when one was set — only meaningful once `timedOut` is true. */
	timeoutSeconds?: number;
	/** Set only when status is "error" (the process failed to even start). */
	errorMessage?: string;
	/** False while a task is being observed as a foreground call; true after explicit or automatic promotion. */
	notifyOnCompletion: boolean;
}

/**
 * What `execBash`/`execBashOutput`/`execBashKill` receive per call. Built
 * once per session (web: bridge.ts's WebAgentSession; TUI: alongside the
 * session's AgentRunner) and passed through LoopConfig.backgroundBash on
 * every turn — `followUpQueue`/`isRunning` are literally the same
 * AgentRunner fields already wired as LoopConfig.followUpQueue, so a
 * completion enqueued here is picked up by the existing drain with no new
 * plumbing on the loop side.
 */
export interface BashBackgroundDeps {
	registry: BackgroundTaskRegistry;
	followUpQueue: MessageQueue;
	isRunning: () => boolean;
}

export interface BackgroundTaskStartOptions {
	notifyOnCompletion?: boolean;
}

function elapsedSeconds(task: BackgroundTask): number {
	return Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000);
}

/** One-line human status, used by both bash_output and the completion reminder. */
function statusLine(task: BackgroundTask): string {
	switch (task.status) {
		case "running":
			return `running (${elapsedSeconds(task)}s elapsed)`;
		case "killed":
			return `killed after ${elapsedSeconds(task)}s`;
		case "error":
			return "failed to start";
		default:
			return `exited with code ${task.exitCode} after ${elapsedSeconds(task)}s`;
	}
}

/** Same ANSI-strip / CRLF-normalize / line-cap treatment as formatBashResult, minus the exit-code line — used for a still-*running* task's output, where there's no exit code to report yet. */
function truncateOutput(rawOutput: string, maxLines: number): string {
	const output = stripAnsi(rawOutput).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = output.split("\n");
	if (lines.length > maxLines) {
		const kept = lines.slice(-maxLines);
		return `[Showing last ${maxLines} of ${lines.length} lines]\n${kept.join("\n")}`;
	}
	return output;
}

function buildCompletionReminder(task: BackgroundTask, config: AppConfig): string {
	const body =
		task.status === "error"
			? (task.errorMessage ?? "Failed to start.")
			: formatBashResult(task.rawOutput, config, {
					exitCode: task.exitCode,
					timedOut: task.timedOut,
					outputTruncated: task.outputTruncated,
					timeoutSeconds: task.timeoutSeconds,
				}).content;
	return (
		"<system-reminder>\n" +
		`Background task ${task.id} (\`${task.command}\`) ${statusLine(task)}.\n\n` +
		`${body}\n` +
		"</system-reminder>"
	);
}

/** How many finished tasks stay queryable via `bash_output`.
 *
 * Nothing ever removed a task, and on an interactive surface *every*
 * foreground bash call goes through this registry — so a session's captured
 * output accumulated for its whole life: 200 finished commands held 3.77MB
 * (each task may retain up to config.maxToolOutputBytes of output), and a
 * long session running thousands of commands held hundreds of megabytes per
 * live session. Recent tasks are what a caller can plausibly still ask about;
 * older ones are dropped oldest-first. Running tasks are never dropped.
 */
const MAX_RETAINED_FINISHED_TASKS = 100;

export class BackgroundTaskRegistry {
	private tasks = new Map<string, BackgroundTask>();
	private counter = 0;
	// Late-bound — the surface (web/TUI) doesn't have a `submit`-shaped
	// function ready at the moment it constructs this registry (see the file
	// doc comment). Defaults to a no-op: in practice this is always wired
	// before any tool call could run, since it happens at session
	// construction time.
	private onIdleWake: (text: string) => void = () => {};

	setOnIdleWake(fn: (text: string) => void): void {
		this.onIdleWake = fn;
	}

	get(id: string): BackgroundTask | undefined {
		return this.tasks.get(id);
	}

	hasRunning(): boolean {
		return [...this.tasks.values()].some((task) => task.status === "running");
	}

	start(
		command: string,
		cwd: string,
		config: AppConfig,
		/** Undefined means no kill timer — background tasks are open-ended by
		 *  default (dev servers, long builds); the foreground default timeout
		 *  only applies here if the model explicitly passed one. */
		timeoutSeconds: number | undefined,
		deps: BashBackgroundDeps,
		options: BackgroundTaskStartOptions = {},
	): BackgroundTask {
		const bash = getBashResolution();
		const id = `bg-${++this.counter}`;

		let resolveExit: () => void = () => {};
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});

		const task: BackgroundTask = {
			id,
			command,
			cwd,
			exitPromise,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			rawOutput: "",
			outputTruncated: false,
			timedOut: false,
			timeoutSeconds,
			notifyOnCompletion: options.notifyOnCompletion ?? true,
		};
		this.tasks.set(id, task);

		const maxBytes = config.maxToolOutputBytes;
		try {
			const pty = spawnPty(bash.path, ["-c", command], {
				name: "xterm-256color",
				cols: 120,
				rows: 40,
				cwd,
				env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "xterm-256color" },
			});
			task.pty = pty;

			pty.onData((data) => {
				const appended = appendBoundedOutput(task.rawOutput, Buffer.from(data), maxBytes);
				task.rawOutput = appended.output;
				task.outputTruncated ||= appended.truncated;
			});

			const timer =
				timeoutSeconds === undefined
					? undefined
					: setTimeout(() => {
							task.timedOut = true;
							this.killPty(pty);
						}, timeoutSeconds * 1000);

			pty.onExit(({ exitCode }) => {
				clearTimeout(timer);
				task.exitCode = exitCode;
				task.endedAt = Date.now();
				if (task.status === "killed") {
					// kill() already set "killed" — a later PTY exit mustn't downgrade it.
				} else if (exitCode !== 0 && isPtySpawnFailure(task.rawOutput, bash.path)) {
					task.status = "error";
					task.errorMessage = `Failed to start bash ("${bash.path}"): ${task.rawOutput.trim()}`;
				} else {
					task.status = "exited";
				}
				resolveExit();
				this.settle(task, config, deps);
			});
		} catch (err) {
			task.status = "error";
			task.endedAt = Date.now();
			task.errorMessage = `Failed to start bash ("${bash.path}"): ${err instanceof Error ? err.message : String(err)}`;
			resolveExit();
			this.settle(task, config, deps);
		}

		return task;
	}

	kill(id: string): "killed" | "not-found" | "already-done" {
		const task = this.tasks.get(id);
		if (!task) return "not-found";
		if (task.status !== "running") return "already-done";
		task.status = "killed";
		if (task.pty) this.killPty(task.pty);
		return "killed";
	}

	/** Promote a foreground-observed task so its eventual result is delivered to the agent. */
	promote(id: string): "promoted" | "not-found" | "already-done" {
		const task = this.tasks.get(id);
		if (!task) return "not-found";
		if (task.status !== "running") return "already-done";
		task.notifyOnCompletion = true;
		return "promoted";
	}

	/** Kill the PTY's process group so children such as dev servers are reaped too. */
	private killPty(pty: IPty): void {
		try {
			process.kill(-pty.pid, "SIGKILL");
		} catch {
			// The process group may already have exited or not exist on this platform.
		}
		try {
			pty.kill();
		} catch {
			// already dead
		}
	}

	/** Session-close teardown — reap every still-running task's process. */
	killAll(): void {
		for (const task of this.tasks.values()) {
			if (task.status === "running") this.kill(task.id);
		}
	}

	/** Drops the oldest finished tasks once more than the retention limit have
	 * piled up. Map iteration is insertion order, which is task order. */
	private pruneFinished(): void {
		const finished: string[] = [];
		for (const [id, task] of this.tasks) {
			if (task.status !== "running") finished.push(id);
		}
		for (const id of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_FINISHED_TASKS))) {
			this.tasks.delete(id);
		}
	}

	private settle(task: BackgroundTask, config: AppConfig, deps: BashBackgroundDeps): void {
		this.pruneFinished();
		if (!task.notifyOnCompletion) return;
		const reminderText = buildCompletionReminder(task, config);
		const message: Message = { role: "user", content: reminderText };
		if (deps.isRunning()) {
			deps.followUpQueue.enqueue(message);
		} else {
			this.onIdleWake(reminderText);
		}
	}
}

/** Clamp an optional `wait` (seconds) arg to a sane range — 0 to 60s. */
function clampWait(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v)) return 0;
	return Math.max(0, Math.min(60, v));
}

export async function execBashOutput(
	args: Record<string, unknown>,
	config: AppConfig,
	deps: BashBackgroundDeps | undefined,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (!deps) return { content: "Background tasks are not available in this context.", isError: true };
	const id = String(args.task_id ?? "");
	const task = deps.registry.get(id);
	if (!task) return { content: `No background task with id "${id}".`, isError: true };

	const wait = clampWait(args.wait);
	if (task.status === "running" && wait > 0) {
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, wait * 1000);
			task.exitPromise.then(done);
			// Waiting is purely observational — an abort here must not kill the
			// task, only stop waiting on it (matches the "never tied to a
			// turn's AbortSignal" rule).
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	const header = `Task ${task.id} (\`${task.command}\`): ${statusLine(task)}`;
	if (task.status === "running") {
		const output = truncateOutput(task.rawOutput, config.maxToolOutputLines);
		const truncationNote = task.outputTruncated
			? `\n\n[Output truncated at ${formatSize(config.maxToolOutputBytes)}. Narrow the command or redirect output to a file and read it in chunks.]`
			: "";
		return { content: `${header}\n\n${output || "(no output yet)"}${truncationNote}` };
	}
	if (task.status === "error") {
		return { content: `${header}\n\n${task.errorMessage ?? ""}`, isError: true };
	}
	const formatted = formatBashResult(task.rawOutput, config, {
		exitCode: task.exitCode,
		timedOut: task.timedOut,
		outputTruncated: task.outputTruncated,
		timeoutSeconds: task.timeoutSeconds,
	});
	return { content: `${header}\n\n${formatted.content}`, isError: formatted.isError };
}

export async function execBashKill(
	args: Record<string, unknown>,
	deps: BashBackgroundDeps | undefined,
): Promise<ToolResult> {
	if (!deps) return { content: "Background tasks are not available in this context.", isError: true };
	const id = String(args.task_id ?? "");
	const outcome = deps.registry.kill(id);
	if (outcome === "not-found") return { content: `No background task with id "${id}".`, isError: true };
	if (outcome === "already-done") {
		const task = deps.registry.get(id);
		return { content: `Task ${id} was already ${task ? statusLine(task) : "finished"} — nothing to kill.` };
	}
	return { content: `Task ${id} killed.` };
}
