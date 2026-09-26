/**
 * The `task` tool — delegates an assignment to a worker subagent running its
 * own agent loop. Bash confirmations are serialized so two subagents (in
 * different sessions of the same daemon) don't race the shared terminal.
 * runAgentLoop is injected to avoid a circular import with loop.ts.
 */

import { type AgentActorHandle, type AgentActorRegistry, agentActorRegistry } from "../actors.ts";
import type { AppConfig } from "../config.ts";
import { formatContextFilesForPrompt, loadProjectContextFiles } from "../context-files.ts";
import { type HooksFile, runHooksForEvent } from "../hooks.ts";
import { EMPTY_ASSISTANT_PLACEHOLDER, type Message, type Tool, type Usage } from "../llm.ts";
import { type AgentEvent, type LoopConfig, MessageQueue } from "../loop.ts";
import type { McpToolHandle } from "../mcp.ts";
import { writeTaskProgress } from "../memory-files.ts";
import { PLAN_TOOL_NAMES, type PlanState, QUESTION_TOOL_NAME } from "../plan.ts";
import { formatSystemEnvironmentBlock, resolvePromptContextForCwd } from "../project.ts";
import { createSession, loadSession, type SessionState, saveSession } from "../session.ts";
import { isMemoryEnabled } from "../settings.ts";
import type { Skill } from "../skills.ts";
import type { SshHost } from "../ssh.ts";
import type { SubagentPrompt } from "../subagents.ts";
import { escapeSystemReminderTags } from "../system-reminder.ts";
import type { BashBackgroundDeps } from "./bash-background.ts";
import type { ConfirmBash, ToolResult } from "./shared.ts";

/**
 * Walk assistants from the end and return the first non-empty string content,
 * skipping the loop's empty-content placeholder. Tools-only / blank final
 * turns must not erase an earlier real report.
 */
export function extractTaskResult(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		if (typeof m.content !== "string") continue;
		const text = m.content.trim();
		if (!text || text === EMPTY_ASSISTANT_PLACEHOLDER) continue;
		return text;
	}
	return "";
}

/** Sibling `task` calls in one model response run concurrently (see
 * executeToolCalls); this caps how many of one session's subagents run at
 * once, so a model that fans out ten tasks doesn't open ten provider streams. */
export const MAX_CONCURRENT_TASKS = 4;
const TASK_RESULT_MAX_CHARS = 30_000;
const WHITESPACE_RUN_RE = /\s+/g;

const slots = new Map<string, { active: number; waiters: Array<() => void> }>();
async function acquireSlot(key: string, signal?: AbortSignal): Promise<() => void> {
	let slot = slots.get(key);
	if (!slot) {
		slot = { active: 0, waiters: [] };
		slots.set(key, slot);
	}
	const s = slot;
	if (s.active >= MAX_CONCURRENT_TASKS) {
		if (signal?.aborted) throw new Error("aborted");
		await new Promise<void>((resolveWait, rejectWait) => {
			const onAbort = () => {
				s.waiters = s.waiters.filter((w) => w !== wake);
				rejectWait(new Error("aborted"));
			};
			const wake = () => {
				signal?.removeEventListener("abort", onAbort);
				resolveWait();
			};
			s.waiters.push(wake);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	s.active++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		s.active--;
		const next = s.waiters.shift();
		if (next) next();
		else if (s.active === 0) slots.delete(key);
	};
}

/** Subagents still running, by task id (= child session id): a `task_id`
 *  call for one of them steers it instead of starting a second run, and the
 *  hosts cancel them from here. */
const running = new Map<
	string,
	{ actor: AgentActorHandle; steering: MessageQueue; parentSessionId?: string; agent: string; discard?: boolean }
>();

export function isTaskRunning(taskId: string): boolean {
	return running.has(taskId);
}

/** `discard`: its thread is being deleted, so the child must not save itself
 *  back on the way out. */
export function cancelTask(taskId: string, opts: { discard?: boolean } = {}): boolean {
	const entry = running.get(taskId);
	if (!entry) return false;
	if (opts.discard) entry.discard = true;
	entry.actor.cancel();
	return true;
}

export function runningTaskIds(parentSessionId: string): string[] {
	return [...running].filter(([, e]) => e.parentSessionId === parentSessionId).map(([id]) => id);
}

export interface SubagentProgress {
	toolCallId: string;
	taskId: string;
	parentSessionId?: string;
	subagent: string;
	description: string;
	background: boolean;
	status: "running" | "completed" | "failed" | "cancelled";
	/** The child's latest tool call. */
	tool?: { name: string; summary: string };
	toolCount: number;
	/** Only on a background task's final update: its spend, which has no tool
	 *  result to ride on. */
	usage?: Usage;
}

const ARG_KEYS = ["path", "file_path", "pattern", "command", "url", "query", "assignment"];
export function summarizeToolArgs(raw: string): string {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return "";
	}
	const key = ARG_KEYS.find((k) => typeof args[k] === "string");
	const text = key ? String(args[key]).replace(WHITESPACE_RUN_RE, " ").trim() : "";
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function taskBlock(taskId: string, subagent: string, state: string, body: string): string {
	return `<task id="${taskId}" subagent="${subagent}" state="${state}">\n${body}\n</task>`;
}

function capResult(text: string, taskId: string): string {
	if (text.length <= TASK_RESULT_MAX_CHARS) return text;
	return `${text.slice(0, TASK_RESULT_MAX_CHARS)}\n\n[report cut at ${TASK_RESULT_MAX_CHARS} characters; the full transcript is in subagent session ${taskId}]`;
}

/**
 * Serializes bash-confirmation prompts across concurrently running subagents.
 * Confirmations read the single shared terminal/stdin, so two subagents asking
 * at once would race for it. Chaining forces one prompt to fully resolve before
 * the next begins. The chain never rejects (errors are swallowed into the tail)
 * so one failed confirmation can't wedge the queue.
 */
let confirmChain: Promise<unknown> = Promise.resolve();
function serializeConfirm(confirm: ConfirmBash | undefined): ConfirmBash | undefined {
	if (!confirm) return confirm;
	return (command: string, reason: string): Promise<boolean> => {
		const run = confirmChain.then(() => confirm(command, reason));
		confirmChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
}

export interface TaskExecutorDeps {
	model: string;
	/** Subagent prompts available for the task tool. */
	subagentPrompts?: SubagentPrompt[];
	mcpTools?: Tool[];
	mcpToolIndex?: Map<string, McpToolHandle>;
	confirmBash?: ConfirmBash;
	/** Main agent model, shown in task tool description for transparency. */
	mainModel?: string;
	/** Model override for subagents (falls back to main model if undefined). */
	subagentModel?: string;
	/** Provider credentials for the subagent model (if on a different provider). */
	subagentModelProvider?: { baseURL: string; apiKey: string };
	/** Tool names to exclude from the definitions sent to the model. */
	disabledTools?: Set<string>;
	/** Parent's plan state — lets build-mode subagents inherit the approved
	 * plan (mirror block) and plan-mode subagents inherit the bash block. */
	planState?: PlanState;
	/**
	 * Whether the project cwd is trusted — gates the cwd AGENTS.md file when
	 * the subagent has `agentsMd: true` (the default).
	 */
	projectTrusted?: boolean;
	/** Parent `--no-skills` — skip auto skill discovery for the child too. */
	noSkills?: boolean;
	/** Parent `--skill` paths — still loaded when `noSkills` is set. */
	cliSkillPaths?: string[];
	/** Parent's MCP catalog block (`formatMcpForPrompt`) — tools are already
	 * inherited via mcpTools; this lists enabled servers in the prompt. */
	mcpPromptSuffix?: string;
	/** Parent SSH hosts so the child can use the `ssh` tool when configured. */
	sshHosts?: SshHost[];
	/** Parent's hooks — subagents inherit them so a hook that gates a tool applies everywhere that tool can run. */
	hooks?: HooksFile;
	/** Current session id, for hook payloads/env. */
	sessionId?: string;
	/** Actor registry used to track this child independently from the parent turn. */
	actorRegistry?: AgentActorRegistry;
	/** Live progress of a running child, for the parent's UI. */
	onProgress?: (progress: SubagentProgress) => void;
	/** Every raw child event, for a host showing the child session live. */
	onChildEvent?: (taskId: string, event: AgentEvent) => void;
	/** Present when the host can deliver a notice after the turn ends —
	 *  required for `background: true`. */
	background?: BashBackgroundDeps;
	/** Loaded skills — for the skill tool. */
	skills?: Skill[];
	/** Injected to avoid circular dependency with loop.ts. */
	runAgentLoop: (messages: Message[], config: LoopConfig) => Promise<Message[]>;
}

/**
 * Assemble the child system prompt: role + AGENTS (optional) + rules/skills +
 * MCP catalog + Current System State (cwd/date/platform). Mirrors the parent
 * grounding surface so relative paths in assignments resolve correctly.
 */
export function buildTaskSystemPrompt(
	rolePrompt: string,
	cwd: string,
	config: AppConfig,
	opts: {
		agentsMd: boolean;
		projectTrusted: boolean;
		model: string;
		subagentName: string;
		subagentLabel: string;
		mcpPromptSuffix?: string;
		noSkills?: boolean;
		cliSkillPaths?: string[];
	},
): string {
	const agentsSuffix = opts.agentsMd
		? formatContextFilesForPrompt(loadProjectContextFiles(cwd, opts.projectTrusted))
		: "";
	const { rulesSuffix, rulesLazySuffix, skillsPromptSuffix } = resolvePromptContextForCwd(cwd, opts.projectTrusted, {
		noSkills: opts.noSkills,
		cliSkillPaths: opts.cliSkillPaths,
	});
	const stateBlock = formatSystemEnvironmentBlock(cwd, {
		model: opts.model,
		reasoningLevel: config.reasoningLevel,
		subagent: { name: opts.subagentName, label: opts.subagentLabel },
	});
	return [
		rolePrompt,
		agentsSuffix,
		rulesSuffix,
		rulesLazySuffix,
		skillsPromptSuffix,
		opts.mcpPromptSuffix ?? "",
		stateBlock,
	]
		.filter(Boolean)
		.join("");
}

export async function execTask(
	args: Record<string, unknown>,
	cwd: string,
	config: AppConfig,
	deps: TaskExecutorDeps,
	signal?: AbortSignal,
	toolCallId?: string,
): Promise<ToolResult & { subagentUsage?: Usage }> {
	const assignment = typeof args.assignment === "string" ? args.assignment.trim() : "";
	if (!assignment) return { content: "Missing `assignment`.", isError: true };
	const taskIdArg = typeof args.task_id === "string" ? args.task_id.trim() : "";

	// A task id names an earlier child of this session: carry on with it.
	let resumed: SessionState | undefined;
	if (taskIdArg) {
		const live = running.get(taskIdArg);
		if (live && live.parentSessionId === deps.sessionId) {
			live.steering.enqueue({ role: "user", content: assignment });
			return {
				content: taskBlock(
					taskIdArg,
					live.agent,
					"running",
					"Sent to the running task; its result arrives when it finishes. Do not poll it.",
				),
			};
		}
		const loaded = deps.sessionId ? loadSession(taskIdArg) : null;
		if (!loaded || loaded.sessionKind !== "subagent" || loaded.parentSessionId !== deps.sessionId) {
			return { content: `No task "${taskIdArg}" in this session. Omit task_id to start a new one.`, isError: true };
		}
		resumed = loaded;
	}

	const subagentName = resumed?.persona ?? (typeof args.subagent === "string" ? args.subagent.trim() : "");
	// Default (no subagent given): prefer the general-purpose "worker" explicitly
	// rather than "first in the sorted list", so adding another subagent whose
	// name sorts earlier can't silently steal the default.
	const defaultSubagent = deps.subagentPrompts?.find((p) => p.name === "worker") ?? deps.subagentPrompts?.[0];
	const subagent = subagentName ? deps.subagentPrompts?.find((p) => p.name === subagentName) : defaultSubagent;

	if (subagentName && !subagent) {
		const available = deps.subagentPrompts?.map((p) => p.name).join(", ") ?? "(none)";
		return { content: `Unknown subagent "${subagentName}". Available: ${available}`, isError: true };
	}
	const agentName = subagent?.name ?? "worker";
	const description =
		(typeof args.description === "string" && args.description.trim()) ||
		resumed?.title ||
		(assignment.split("\n")[0] ?? "").slice(0, 60);
	const background = args.background === true && deps.background !== undefined;

	// Assignment stays in the user message only. System prompt = role + the
	// same project grounding the parent gets (AGENTS, rules, skills, MCP
	// catalog, cwd/date/platform) so relative paths aren't ambiguous.
	const rolePrompt = subagent?.systemPrompt ?? "You are a worker agent. Complete the assigned task.";
	const childSystemPrompt = buildTaskSystemPrompt(rolePrompt, cwd, config, {
		agentsMd: subagent?.agentsMd !== false,
		projectTrusted: deps.projectTrusted === true,
		model: deps.model,
		subagentName: agentName,
		subagentLabel: subagent?.label ?? "Worker",
		mcpPromptSuffix: deps.mcpPromptSuffix,
		noSkills: deps.noSkills,
		cliSkillPaths: deps.cliSkillPaths,
	});

	// The child is a session of its own: its transcript is saved as it goes,
	// the UIs open it, and a later task_id call continues it.
	const child =
		resumed ??
		createSession(deps.model, cwd, {
			sessionKind: "subagent",
			parentSessionId: deps.sessionId,
			title: description,
		});
	child.persona = agentName;
	child.model = deps.model;
	const taskId = child.id;
	const persist = () => {
		if (!deps.sessionId || running.get(taskId)?.discard) return;
		try {
			saveSession(child);
		} catch (err) {
			// Losing the saved copy is not a reason to lose the answer.
			console.error("[cast] failed to save subagent session:", err);
		}
	};
	const childMessages: Message[] = [...child.messages, { role: "user", content: assignment }];

	const subagentUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
	const readOnly = subagent?.readOnly === true || deps.planState?.enabled === true;
	const steering = new MessageQueue();
	let toolCount = 0;
	const progress = (status: SubagentProgress["status"], extra: Partial<SubagentProgress> = {}) =>
		deps.onProgress?.({
			toolCallId: toolCallId ?? "",
			taskId,
			parentSessionId: deps.sessionId,
			subagent: agentName,
			description,
			background,
			status,
			toolCount,
			...extra,
		});

	// Reason from the subagent's final `end` event. Anything other than "stop"
	// (aborted, disconnected, error) means the run did not complete cleanly and
	// must be surfaced as an error rather than passed off as a valid result.
	let endReason = "stop";
	const actor = (deps.actorRegistry ?? agentActorRegistry).spawn(
		{
			parentSessionId: deps.sessionId,
			sessionId: taskId,
			agent: agentName,
			mode: "subagent",
			background,
			lifecycle: "ephemeral",
		},
		// A background task outlives the turn that started it; only an explicit
		// cancel (or the process) ends it.
		background ? undefined : signal,
	);

	// A turn cancelled between the spawn above and the run below must not start
	// work. actor.run() would refuse it too, but as a thrown
	// AgentActorCancelledError reported as a generic failure; say what happened.
	if (actor.signal.aborted) {
		actor.cancel();
		return {
			content: "Subagent did not complete successfully (aborted):\n\n(cancelled before start)",
			isError: true,
			subagentUsage,
		};
	}
	if (deps.hooks) {
		try {
			await runHooksForEvent(deps.hooks, {
				event: "SubagentStart",
				matchTarget: agentName,
				cwd,
				sessionId: deps.sessionId,
				payload: { agent_type: agentName, actor_id: actor.id, assignment },
				signal: actor.signal,
			});
		} catch (error) {
			actor.cancel();
			return {
				content: `Subagent failed to start: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
	}

	const runChild = async (): Promise<ToolResult & { subagentUsage?: Usage }> => {
		let release: (() => void) | undefined;
		try {
			release = await acquireSlot(deps.sessionId ?? "", actor.signal);
		} catch {
			actor.cancel();
			return { content: "Subagent did not complete successfully (aborted).", isError: true, subagentUsage };
		}
		running.set(taskId, { actor, steering, parentSessionId: deps.sessionId, agent: agentName });
		progress("running");
		let finalMessages: Message[];
		try {
			finalMessages = await actor.run(
				(actorSignal) =>
					deps.runAgentLoop(childMessages, {
						config,
						model: deps.model,
						modelProvider: deps.subagentModelProvider,
						cwd,
						systemPrompt: childSystemPrompt,
						onMessagesChanged: (messages) => {
							child.messages = [...messages];
						},
						onEvent: (event) => {
							deps.onChildEvent?.(taskId, event);
							if (event.type === "usage") {
								addUsage(subagentUsage, event.usage);
							} else if (event.type === "tool_start") {
								toolCount++;
								progress("running", {
									tool: { name: event.name, summary: summarizeToolArgs(event.args) },
								});
							} else if (event.type === "turn_end") {
								persist();
							} else if (event.type === "end") {
								endReason = event.reason;
							}
						},
						signal: actorSignal,
						steeringQueue: steering,
						// Serialize confirmations so parallel subagents don't race the terminal.
						confirmBash: serializeConfirm(deps.confirmBash),
						mcpTools: deps.mcpTools,
						mcpToolIndex: deps.mcpToolIndex,
						hooks: deps.hooks,
						sessionId: deps.sessionId,
						skills: deps.skills,
						// Same-process nested run: the parent holds the turn-runner lock
						// for this session, so acquiring it again would throw "Session
						// already running in another process" and fail every subagent.
						skipTurnRunnerLock: true,
						// The parent alone owns the plan artifact. Passing enabled=false below
						// avoids giving the child plan-authoring tools, so write/edit must be
						// denied explicitly or a plan-mode child could edit the project.
						disabledTools: new Set([
							...(deps.disabledTools ?? []),
							...PLAN_TOOL_NAMES,
							QUESTION_TOOL_NAME,
							...(readOnly ? ["write", "edit"] : []),
						]),
						// Frontmatter `tools:` on the subagent — undefined means all (minus
						// disabledTools above); when set, only listed names are advertised
						// and executable.
						allowedTools: subagent?.tools,
						projectTrusted: deps.projectTrusted,
						// Handoff, not authority: the child sees the plan (mirror block in
						// build mode, or the current draft during planning) but always runs
						// with enabled=false — the plan-mode restriction block references
						// authoring tools the child doesn't have. A read-only subagent, or
						// any child of a planning parent, gets inspection-only bash instead:
						// explorers can run git log/grep pipelines but still can't write.
						planState: deps.planState ? { ...deps.planState, enabled: false } : undefined,
						readOnlyBash: readOnly,
						sshHosts: deps.sshHosts,
						// ponytail: no personas/currentPersona/subagentModel — child can't delegate further
					}),
				() => (endReason === "stop" ? "success" : "failure"),
			);
			child.messages = finalMessages;
			persist();
			if (deps.sessionId && isMemoryEnabled()) {
				try {
					const progressId = (toolCallId || `task-${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, "-");
					writeTaskProgress(
						deps.sessionId,
						progressId,
						`# Task progress\n\n- Assignment: ${assignment}\n- Persona: ${agentName}\n- End reason: ${endReason}\n\n## Result\n${extractTaskResult(finalMessages) || "(no output)"}`,
					);
				} catch (err) {
					console.error("[cast] failed to write subagent task progress:", err);
				}
			}
		} catch (error) {
			// A genuine runtime failure (network error, provider outage, …) mid-run
			// — as opposed to a clean-but-unsuccessful "end" event, handled below.
			// subagentUsage is the ONLY channel loop.ts uses to fold a subagent's
			// spend into the session total — letting this exception propagate
			// would discard usage already billed before the failure.
			persist();
			progress(actor.signal.aborted ? "cancelled" : "failed");
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: taskBlock(taskId, agentName, "failed", `Subagent failed with an error: ${message}`),
				isError: true,
				subagentUsage,
			};
		} finally {
			running.delete(taskId);
			release();
			// Observation-only (the child's own recursive runLoop already handles
			// blocking/continuation via its own `Stop` hook — this is a distinct
			// "a subagent finished" signal for logging/notification, not a second
			// gate on the same decision).
			if (deps.hooks) {
				void runHooksForEvent(deps.hooks, {
					event: "SubagentStop",
					matchTarget: agentName,
					cwd,
					sessionId: deps.sessionId,
					payload: { agent_type: agentName, actor_id: actor.id, end_reason: endReason },
					signal: actor.signal,
				});
			}
		}

		// A resumed child answers after its old history; a compaction inside the
		// run can shorten that history, so fall back to the whole transcript.
		const text = extractTaskResult(finalMessages.slice(childMessages.length - 1)) || extractTaskResult(finalMessages);
		// Surface failures instead of passing them off as a clean (but empty) result.
		if (endReason !== "stop") {
			progress(endReason === "aborted" ? "cancelled" : "failed");
			const detail = capResult(text, taskId) || "(no output produced)";
			return {
				content: taskBlock(
					taskId,
					agentName,
					"failed",
					`Subagent did not complete successfully (${endReason}):\n\n${detail}`,
				),
				isError: true,
				subagentUsage,
			};
		}
		if (!text) {
			progress("failed");
			return {
				content: taskBlock(taskId, agentName, "failed", "Subagent completed but produced no output."),
				isError: true,
				subagentUsage,
			};
		}
		progress("completed");
		return { content: taskBlock(taskId, agentName, "completed", capResult(text, taskId)), subagentUsage };
	};

	if (!background) return runChild();

	const deliver = deps.background!;
	void runChild().then((result) => {
		// The turn that started it may be long over: usage and the result
		// travel as a final progress update and a notice for the model.
		progress(result.isError ? "failed" : "completed", { usage: subagentUsage });
		const notice =
			"<system-reminder>\n" +
			`Background task ${taskId} (${agentName}: ${escapeSystemReminderTags(description)}) finished. Relay what matters to the user.\n\n` +
			`${escapeSystemReminderTags(result.content)}\n` +
			"</system-reminder>";
		deliver.registry.deliver(notice, deliver);
	});
	return {
		content: taskBlock(
			taskId,
			agentName,
			"running",
			"Started in the background. Its result arrives on its own when it finishes: do not poll it, wait for it, or redo its work. Carry on with other work, or end your turn.",
		),
	};
}

function addUsage(total: Usage, usage: Usage): void {
	total.promptTokens += usage.promptTokens;
	total.completionTokens += usage.completionTokens;
	total.totalTokens += usage.totalTokens;
	if (usage.cacheReadTokens) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens;
	if (usage.cacheWriteTokens) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
	if (usage.uncachedTokens) total.uncachedTokens = (total.uncachedTokens ?? 0) + usage.uncachedTokens;
	// Provider-reported cost (e.g. OpenRouter) must be folded in too, otherwise
	// the subagent's spend silently vanishes from the session's cost total.
	if (usage.cost) total.cost = (total.cost ?? 0) + usage.cost;
}
