/**
 * Background bash tasks — `run_in_background:true` on the `bash` tool spawns
 * a command without blocking the tool call, tracked here for the lifetime of
 * a session. Completion is delivered as a `<system-reminder>` (same
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

import { type ChildProcess, spawn } from "node:child_process";
import type { AppConfig } from "../config.ts";
import type { Message } from "../llm.ts";
import type { MessageQueue } from "../loop.ts";
import { formatBashResult, getBashResolution, stripAnsi } from "./bash.ts";
import type { ToolResult } from "./shared.ts";

export interface BackgroundTask {
	id: string;
	command: string;
	cwd: string;
	proc: ChildProcess;
	status: "running" | "exited" | "killed" | "error";
	exitCode: number | null;
	startedAt: number;
	endedAt?: number;
	/** Accumulated stdout+stderr, capped at config.maxToolOutputBytes — mirrors bash.ts's sync path. */
	rawOutput: string;
	timedOut: boolean;
	/** Set only when status is "error" (the process failed to even start). */
	errorMessage?: string;
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
			: formatBashResult(task.rawOutput, config, { exitCode: task.exitCode, timedOut: task.timedOut }).content;
	return (
		"<system-reminder>\n" +
		`Background task ${task.id} (\`${task.command}\`) ${statusLine(task)}.\n\n` +
		`${body}\n` +
		"</system-reminder>"
	);
}

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

	start(
		command: string,
		cwd: string,
		config: AppConfig,
		timeoutSeconds: number,
		deps: BashBackgroundDeps,
	): BackgroundTask {
		const bash = getBashResolution();
		const id = `bg-${++this.counter}`;

		// Same spawn shape as execBash's synchronous path (bash.ts) — stdin
		// ignored (EOF, no PTY/prompt handling), detached so the whole process
		// group can be SIGKILLed on timeout/kill/session-close.
		const proc = spawn(bash.path, ["-c", command], {
			cwd,
			env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});

		const task: BackgroundTask = {
			id,
			command,
			cwd,
			proc,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			rawOutput: "",
			timedOut: false,
		};
		this.tasks.set(id, task);

		const maxBytes = config.maxToolOutputBytes;
		proc.stdout?.on("data", (d: Buffer) => {
			if (task.rawOutput.length < maxBytes) task.rawOutput += d.toString("utf-8");
		});
		proc.stderr?.on("data", (d: Buffer) => {
			if (task.rawOutput.length < maxBytes) task.rawOutput += d.toString("utf-8");
		});

		const timer = setTimeout(() => {
			task.timedOut = true;
			try {
				process.kill(-proc.pid!, "SIGKILL");
			} catch {
				// already dead
			}
		}, timeoutSeconds * 1000);

		proc.on("error", (err) => {
			clearTimeout(timer);
			task.status = "error";
			task.endedAt = Date.now();
			task.errorMessage = `Failed to start bash ("${bash.path}"): ${err.message}`;
			this.settle(task, config, deps);
		});

		proc.on("close", (exitCode) => {
			clearTimeout(timer);
			task.exitCode = exitCode;
			task.endedAt = Date.now();
			// kill() already set "killed" — a later close mustn't downgrade it
			// back to "exited".
			if (task.status !== "killed") task.status = "exited";
			this.settle(task, config, deps);
		});

		return task;
	}

	kill(id: string): "killed" | "not-found" | "already-done" {
		const task = this.tasks.get(id);
		if (!task) return "not-found";
		if (task.status !== "running") return "already-done";
		task.status = "killed";
		try {
			process.kill(-task.proc.pid!, "SIGKILL");
		} catch {
			// already dead
		}
		return "killed";
	}

	/** Session-close teardown — reap every still-running task's process. */
	killAll(): void {
		for (const task of this.tasks.values()) {
			if (task.status === "running") this.kill(task.id);
		}
	}

	private settle(task: BackgroundTask, config: AppConfig, deps: BashBackgroundDeps): void {
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
				task.proc.off("close", done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, wait * 1000);
			task.proc.once("close", done);
			// Waiting is purely observational — an abort here must not kill the
			// task, only stop waiting on it (matches the "never tied to a
			// turn's AbortSignal" rule).
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	const header = `Task ${task.id} (\`${task.command}\`): ${statusLine(task)}`;
	if (task.status === "running") {
		const output = truncateOutput(task.rawOutput, config.maxToolOutputLines);
		return { content: `${header}\n\n${output || "(no output yet)"}` };
	}
	if (task.status === "error") {
		return { content: `${header}\n\n${task.errorMessage ?? ""}`, isError: true };
	}
	const formatted = formatBashResult(task.rawOutput, config, {
		exitCode: task.exitCode,
		timedOut: task.timedOut,
	});
	return { content: `${header}\n\n${formatted.content}` };
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
