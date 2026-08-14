import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentActorRegistry } from "../src/core/actors.ts";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { EMPTY_ASSISTANT_PLACEHOLDER, type Message } from "../src/core/llm.ts";
import { createSession, saveSession } from "../src/core/session.ts";
import { execTask, extractTaskResult } from "../src/core/tools/task.ts";

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

const testConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 120,
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
			forkContext: () => ({
				messages: [{ role: "user", content: "parent" }],
				inheritedMessages: [{ role: "user", content: "parent" }],
				prefix: [{ role: "user", content: "parent" }],
				tail: [],
				boundaryIndex: 0,
				cachePrefixBoundary: 0,
				systemPrompt: "parent system",
				toolNames: ["task"],
				model: "test-model",
			}),
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			runAgentLoop: async (messages, config) => {
				config.onEvent({ type: "end", reason: "stop" });
				return [...messages, { role: "assistant", content: "done" }];
			},
		});

		expect(result.isError).toBeFalsy();
		expect(actorRegistry.list()).toEqual([
			expect.objectContaining({
				parentSessionId: parentSession.id,
				sessionId: parentSession.id,
				agent: "worker",
				status: "success",
				forkContext: expect.objectContaining({ systemPrompt: "parent system", toolNames: ["task"] }),
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
		expect(result.content).toBe("Report: all clear in mod-a.");
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
		expect(following.content).toBe("ran fine");
	});

	it("cancels while queued on the semaphore without starting the loop", async () => {
		const ac = new AbortController();
		const actorRegistry = new AgentActorRegistry();
		let started = 0;
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const deps = {
			model: "test-model",
			subagentPrompts: [
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			actorRegistry,
			runAgentLoop: async (messages: Message[]) => {
				started++;
				await gate;
				return [...messages, { role: "assistant", content: "done" }];
			},
		};
		const runs = Array.from({ length: 13 }, () =>
			execTask({ assignment: "work" }, "/tmp", testConfig, deps, ac.signal),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(started).toBe(10);

		ac.abort();
		const queued = await Promise.all(runs.slice(10));
		for (const r of queued) {
			expect(r.isError).toBe(true);
			expect(r.content).toContain("cancelled before start");
		}
		expect(started).toBe(10);

		release();
		await Promise.all(runs.slice(0, 10));
		expect(actorRegistry.list()).toHaveLength(13);
		expect(actorRegistry.list().every((actor) => actor.status === "cancelled")).toBe(true);
	});
});
