import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentActorRegistry } from "../src/core/actors.ts";
import type { AppConfig } from "../src/core/config.ts";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { EMPTY_ASSISTANT_PLACEHOLDER, type Message } from "../src/core/llm.ts";
import { type AgentEvent, MessageQueue } from "../src/core/loop.ts";
import { createSession, loadSession, saveSession } from "../src/core/session.ts";
import { BackgroundTaskRegistry } from "../src/core/tools/bash-background.ts";
import {
	cancelTask,
	execTask,
	extractTaskResult,
	isTaskRunning,
	runningTaskIds,
	type SubagentProgress,
} from "../src/core/tools/task.ts";

// execTask can persist subagent runs (saveSubagentRun) — keep that on a
// throwaway DB so a real sessions.db is never written during tests.
let fakeDb: string;
let realDb: string | undefined;
beforeEach(() => {
	realDb = process.env.CAST_SESSIONS_DB;
	fakeDb = join(mkdtempSync(join(tmpdir(), "cast-task-test-")), "sessions.db");
	process.env.CAST_SESSIONS_DB = fakeDb;
	resetDbConnectionForTests();
});
afterEach(() => {
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(join(fakeDb, ".."), { recursive: true, force: true });
});

const TASK_BLOCK_RE = /^<task id="([^"]+)" subagent="[^"]*" state="[^"]*">\n([\s\S]*)\n<\/task>$/;
function taskIdOf(content: string): string {
	return TASK_BLOCK_RE.exec(content)?.[1] ?? "";
}
function reportOf(content: string): string {
	return TASK_BLOCK_RE.exec(content)?.[2] ?? content;
}

const testConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 120_000,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
} as AppConfig;

describe("extractTaskResult", () => {
	it("skips the empty-assistant placeholder and picks the prior report", () => {
		const messages: Message[] = [
			{ role: "user", content: "do it" },
			{ role: "assistant", content: "Findings:\n- ok at src/a.ts:1" },
			{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
		];
		expect(extractTaskResult(messages)).toBe("Findings:\n- ok at src/a.ts:1");
	});

	it("skips blank and non-string assistant content", () => {
		const messages: Message[] = [
			{ role: "assistant", content: "real report" },
			{ role: "assistant", content: "   " },
			{ role: "assistant", content: null },
		];
		expect(extractTaskResult(messages)).toBe("real report");
	});

	it("returns empty when only placeholders remain", () => {
		const messages: Message[] = [
			{ role: "user", content: "x" },
			{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
			{ role: "assistant", content: "" },
		];
		expect(extractTaskResult(messages)).toBe("");
	});
});

describe("execTask — final extract", () => {
	it("registers a child actor and settles it after the delegated loop", async () => {
		const actorRegistry = new AgentActorRegistry();
		const parentSession = createSession("test-model", "/tmp");
		saveSession(parentSession);
		const result = await execTask({ assignment: "inspect the code" }, "/tmp", testConfig, {
			model: "test-model",
			sessionId: parentSession.id,
			actorRegistry,
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});

		expect(result.isError).toBeFalsy();
		const taskId = taskIdOf(result.content);
		expect(actorRegistry.list()).toEqual([
			expect.objectContaining({
				parentSessionId: parentSession.id,
				sessionId: taskId,
				agent: "worker",
				status: "success",
			}),
		]);
	});

	it("returns the report when the last assistant turn is the placeholder", async () => {
		const result = await execTask({ assignment: "review mod-a" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [
					...messages,
					{ role: "assistant", content: "Report: all clear in mod-a." },
					{ role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER },
				];
			},
		});
		expect(result.isError).toBeFalsy();
		expect(reportOf(result.content)).toBe("Report: all clear in mod-a.");
	});

	it("errors when assistants are only placeholders", async () => {
		const result = await execTask({ assignment: "review mod-a" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: EMPTY_ASSISTANT_PLACEHOLDER }];
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("no output");
	});

	it("lists available subagents for an unknown name", async () => {
		const result = await execTask({ assignment: "do it", subagent: "nope" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async () => {
				throw new Error("should not run");
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown subagent "nope"');
		expect(result.content).toContain("worker");
	});

	it("defaults to worker when present even if another name sorts earlier", async () => {
		let systemPrompt = "";
		await execTask({ assignment: "do it" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "analyst", label: "Analyst", description: "", systemPrompt: "analyst prompt", agentsMd: false },
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker prompt", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				systemPrompt = config.systemPrompt;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});
		expect(systemPrompt).toContain("worker prompt");
		expect(systemPrompt).toContain("Current working directory:");
	});

	it("denies project writes to a subagent launched from plan mode", async () => {
		let disabledTools: Set<string> | undefined;
		let readOnlyBash = false;
		await execTask({ assignment: "inspect the code" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			planState: { enabled: true, plansDir: "/tmp/plans" },
			runAgentLoop: async (messages, config) => {
				disabledTools = config.disabledTools;
				readOnlyBash = config.readOnlyBash === true;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "findings" }];
			},
		});
		expect(disabledTools?.has("write")).toBe(true);
		expect(disabledTools?.has("edit")).toBe(true);
		expect(readOnlyBash).toBe(true);
	});

	it("preserves already-accumulated subagentUsage when runAgentLoop throws mid-run", async () => {
		// subagentUsage is the only channel loop.ts uses to fold a subagent's
		// spend into the session total. Letting a genuine runtime failure
		// (network error, provider outage) propagate uncaught used to discard
		// every usage event already reported before the throw — real, billed
		// tokens vanishing from cost tracking.
		const result = await execTask({ assignment: "review mod-a" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (_messages, config) => {
				config.onEvent({ type: "usage", usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 } });
				config.onEvent({ type: "usage", usage: { promptTokens: 2000, completionTokens: 800, totalTokens: 2800 } });
				throw new Error("network error mid-run");
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain("network error mid-run");
		expect(result.subagentUsage).toEqual({
			promptTokens: 3000,
			completionTokens: 1300,
			totalTokens: 4300,
		});
	});

	it("releases its semaphore slot after runAgentLoop throws, so the next queued task still runs", async () => {
		const failing = await execTask({ assignment: "will fail" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async () => {
				throw new Error("boom");
			},
		});
		expect(failing.isError).toBe(true);

		const following = await execTask({ assignment: "should still run" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "ran fine" }];
			},
		});
		expect(following.isError).toBeFalsy();
		expect(reportOf(following.content)).toBe("ran fine");
	});

	it("does not enter the loop when the turn was cancelled before the run started", async () => {
		const ac = new AbortController();
		ac.abort();
		const actorRegistry = new AgentActorRegistry({ watchdogIntervalMs: 0 });
		let started = 0;
		const deps = {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			actorRegistry,
			runAgentLoop: async (messages: Message[]) => {
				started++;
				return [...messages, { role: "assistant", content: "done" }];
			},
		};

		const result = await execTask({ assignment: "work" }, "/tmp", testConfig, deps, ac.signal);

		expect(result.isError).toBe(true);
		expect(result.content).toContain("cancelled before start");
		expect(started).toBe(0);
	});
	it("returns the subagent's answer even when its session cannot be saved", async () => {
		// Losing the saved copy must not lose work the subagent already did and
		// billed for.
		const errors: string[] = [];
		const consoleError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			const result = await execTask(
				{ assignment: "do the thing" },
				process.cwd(),
				testConfig,
				{
					model: "test-model",
					sessionId: "parent",
					subagentPrompts: [{ name: "worker", label: "Worker", systemPrompt: "you are a worker" } as never],
					actorRegistry: new AgentActorRegistry({ watchdogIntervalMs: 0 }),
					runAgentLoop: async (messages, config) => {
						// The store breaks mid-run: every save from here on throws.
						getDb().exec("DROP TABLE messages");
						config.onEvent({ type: "end", reason: "stop" });
						return [...messages, { role: "assistant", content: "THE SUBAGENT'S REAL ANSWER" }];
					},
				},
				undefined,
				"call-1",
			);

			expect(result.isError).toBeFalsy();
			expect(reportOf(result.content)).toBe("THE SUBAGENT'S REAL ANSWER");
			expect(errors.some((line) => line.includes("failed to save subagent session"))).toBe(true);
		} finally {
			console.error = consoleError;
		}
	});

	it("saves the child as a subagent session of its parent", async () => {
		const session = createSession("test-model", process.cwd());
		saveSession(session);
		const result = await execTask(
			{ assignment: "do the thing", description: "Do the thing" },
			process.cwd(),
			testConfig,
			{
				model: "test-model",
				sessionId: session.id,
				subagentPrompts: [{ name: "worker", label: "Worker", systemPrompt: "you are a worker" } as never],
				actorRegistry: new AgentActorRegistry({ watchdogIntervalMs: 0 }),
				runAgentLoop: async (messages, config) => {
					config.onEvent({ type: "end", reason: "stop" });
					return [...messages, { role: "assistant", content: "PERSISTED ANSWER" }];
				},
			},
			undefined,
			"call-2",
		);

		expect(reportOf(result.content)).toBe("PERSISTED ANSWER");
		const child = loadSession(taskIdOf(result.content));
		expect(child).toMatchObject({
			sessionKind: "subagent",
			parentSessionId: session.id,
			persona: "worker",
			title: "Do the thing",
		});
		expect(child?.messages.map((m) => m.content)).toEqual(["do the thing", "PERSISTED ANSWER"]);
	});
});

describe("execTask — child sessions, resume, background", () => {
	const worker = { name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false };
	const explore = { ...worker, name: "explore", label: "Explore", readOnly: true, tools: ["read", "bash"] };
	const answering =
		(answer: string, seen?: Message[][]) =>
		async (messages: Message[], config: { onEvent: (e: AgentEvent) => void }) => {
			seen?.push(messages);
			config.onEvent({ type: "end", reason: "stop" });
			return [...messages, { role: "assistant", content: answer } as Message];
		};
	const parent = () => {
		const session = createSession("test-model", "/tmp");
		saveSession(session);
		return session.id;
	};

	it("continues an earlier subagent by task_id with its history, reporting only the new answer", async () => {
		const sessionId = parent();
		const base = { model: "test-model", sessionId, subagentPrompts: [worker, explore] };
		const first = await execTask({ assignment: "map auth", subagent: "explore" }, "/tmp", testConfig, {
			...base,
			runAgentLoop: answering("auth lives in src/auth"),
		});
		const seen: Message[][] = [];
		const second = await execTask(
			{ assignment: "and sessions?", task_id: taskIdOf(first.content) },
			"/tmp",
			testConfig,
			{ ...base, runAgentLoop: answering("sessions live in src/session", seen) },
		);

		expect(taskIdOf(second.content)).toBe(taskIdOf(first.content));
		expect(second.content).toContain('subagent="explore"');
		expect(reportOf(second.content)).toBe("sessions live in src/session");
		expect(seen[0]!.map((m) => m.content)).toEqual(["map auth", "auth lives in src/auth", "and sessions?"]);
	});

	it("refuses a task_id that isn't a subagent of this session", async () => {
		const other = await execTask({ assignment: "x" }, "/tmp", testConfig, {
			model: "test-model",
			sessionId: parent(),
			subagentPrompts: [worker],
			runAgentLoop: answering("done"),
		});
		const res = await execTask({ assignment: "y", task_id: taskIdOf(other.content) }, "/tmp", testConfig, {
			model: "test-model",
			sessionId: parent(),
			subagentPrompts: [worker],
			runAgentLoop: answering("never"),
		});
		expect(res.isError).toBe(true);
		expect(res.content).toContain("No task");
	});

	it("enforces readOnly in the harness: no write/edit, inspection-only bash", async () => {
		let seen: { disabledTools?: Set<string>; readOnlyBash?: boolean } = {};
		await execTask({ assignment: "look", subagent: "explore" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [explore],
			runAgentLoop: async (messages, config) => {
				seen = config;
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "ok" }];
			},
		});
		expect(seen.readOnlyBash).toBe(true);
		expect([...(seen.disabledTools ?? [])]).toEqual(expect.arrayContaining(["write", "edit"]));
	});

	it("cuts an oversized report and points at the child session", async () => {
		const res = await execTask({ assignment: "dump" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [worker],
			runAgentLoop: answering("x".repeat(40_000)),
		});
		expect(res.content.length).toBeLessThan(31_000);
		expect(res.content).toContain(`full transcript is in subagent session ${taskIdOf(res.content)}`);
	});

	it("reports progress for each child tool call and the end", async () => {
		const progress: SubagentProgress[] = [];
		await execTask({ assignment: "look", description: "Look around" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [worker],
			onProgress: (p) => progress.push(p),
			runAgentLoop: async (messages, config) => {
				config.onEvent({
					type: "tool_start",
					id: "t1",
					name: "read",
					args: '{"path":"src/a.ts"}',
					status: "running",
				});
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "ok" }];
			},
		});
		expect(progress.map((p) => [p.status, p.tool?.summary, p.toolCount])).toEqual([
			["running", undefined, 0],
			["running", "src/a.ts", 1],
			["completed", undefined, 1],
		]);
		expect(progress[0]!.description).toBe("Look around");
	});

	it("runs a background task after returning, then delivers its report and usage", async () => {
		const registry = new BackgroundTaskRegistry();
		const followUpQueue = new MessageQueue();
		const woken: string[] = [];
		registry.setOnIdleWake((text) => woken.push(text));
		const progress: SubagentProgress[] = [];
		let finish!: () => void;
		const gate = new Promise<void>((r) => {
			finish = r;
		});

		const res = await execTask({ assignment: "slow audit", background: true }, "/tmp", testConfig, {
			model: "test-model",
			sessionId: parent(),
			subagentPrompts: [worker],
			background: { registry, followUpQueue, isRunning: () => false },
			onProgress: (p) => progress.push(p),
			runAgentLoop: async (messages, config) => {
				await gate;
				config.onEvent({ type: "usage", usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } });
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "audit done" }];
			},
		});
		expect(res.content).toContain('state="running"');
		expect(isTaskRunning(taskIdOf(res.content))).toBe(true);

		finish();
		await vi.waitFor(() => expect(woken).toHaveLength(1));
		expect(woken[0]).toContain("audit done");
		expect(woken[0]).toContain(`Background task ${taskIdOf(res.content)}`);
		expect(progress.at(-1)).toMatchObject({ status: "completed", usage: { totalTokens: 7 } });
		expect(isTaskRunning(taskIdOf(res.content))).toBe(false);
	});

	it("doesn't save a cancelled child back when its thread is being deleted", async () => {
		const registry = new BackgroundTaskRegistry();
		const res = await execTask({ assignment: "long job", background: true }, "/tmp", testConfig, {
			model: "test-model",
			sessionId: parent(),
			subagentPrompts: [worker],
			background: { registry, followUpQueue: new MessageQueue(), isRunning: () => true },
			runAgentLoop: (messages, config) =>
				new Promise((resolveRun) => {
					config.signal?.addEventListener("abort", () => {
						config.onEvent({ type: "end", reason: "aborted" });
						resolveRun(messages);
					});
				}),
		});
		const taskId = taskIdOf(res.content);
		await vi.waitFor(() => expect(isTaskRunning(taskId)).toBe(true));

		cancelTask(taskId, { discard: true });
		await vi.waitFor(() => expect(isTaskRunning(taskId)).toBe(false));
		expect(loadSession(taskId)).toBeNull();
	});

	it("steers a still-running task given its task_id, and cancels it on request", async () => {
		const sessionId = parent();
		let steering: MessageQueue | undefined;
		let signal: AbortSignal | undefined;
		const registry = new BackgroundTaskRegistry();
		const res = await execTask({ assignment: "long job", background: true }, "/tmp", testConfig, {
			model: "test-model",
			sessionId,
			subagentPrompts: [worker],
			background: { registry, followUpQueue: new MessageQueue(), isRunning: () => true },
			runAgentLoop: (messages, config) => {
				steering = config.steeringQueue;
				signal = config.signal;
				return new Promise((resolveRun) => {
					config.signal?.addEventListener("abort", () => {
						config.onEvent({ type: "end", reason: "aborted" });
						resolveRun(messages);
					});
				});
			},
		});
		const taskId = taskIdOf(res.content);
		await vi.waitFor(() => expect(steering).toBeDefined());

		const steer = await execTask({ assignment: "also check tests", task_id: taskId }, "/tmp", testConfig, {
			model: "test-model",
			sessionId,
			subagentPrompts: [worker],
			runAgentLoop: answering("never"),
		});
		expect(steer.content).toContain("Sent to the running task");
		expect(steering!.drain()).toEqual([{ role: "user", content: "also check tests" }]);

		expect(runningTaskIds(sessionId)).toEqual([taskId]);
		expect(cancelTask(taskId)).toBe(true);
		await vi.waitFor(() => expect(isTaskRunning(taskId)).toBe(false));
		expect(signal?.aborted).toBe(true);
	});
});
