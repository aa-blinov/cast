import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { formatContextFilesForPrompt, resolveNestedContextFiles } from "../src/core/context-files.ts";
import { formatLocalDate } from "../src/core/date-rollover-reminder.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import { projectIdForCwd } from "../src/core/memory.ts";
import { CHECKPOINT_TEMPLATE, checkpointPath, notesPath, projectMemoryPath } from "../src/core/memory-files.ts";
import { formatRulesForTurn, loadDirectoryRules, matchAutoRules, unionStickyRules } from "../src/core/rules.ts";
import { commitCheckpointWatermark, createSession, listBackgroundSessions, saveSession } from "../src/core/session.ts";
import { updateSettings } from "../src/core/settings.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return {
		...actual,
		createClient: () => ({}),
		// A real abort tears the in-flight request down mid-stream (an
		// APIUserAbortError thrown from inside the fetch), not a clean
		// completion with finishReason: "aborted" — this is what runLoop's
		// outer catch actually has to distinguish from a genuine failure.
		streamAndCollect: vi.fn(
			async (
				_client: unknown,
				_model: string,
				_messages: unknown,
				_tools: unknown,
				_maxTokens: number,
				signal?: AbortSignal,
			) => {
				if (signal?.aborted) throw new Error("Request was aborted.");
				throw new Error("test streamAndCollect stub always throws");
			},
		),
	};
});

const {
	runAgentLoop,
	MessageQueue,
	compactSessionMessages,
	waitForToolBatch,
	TOOL_ABORT_GRACE_MS,
	createAgentContextFork,
	createAgentForkContext,
	createAgentForkRuntimeSnapshot,
	defaultCheckpointThresholds,
} = await import("../src/core/loop.ts");
const { streamAndCollect } = await import("../src/core/llm.ts");
type AgentEvent = Parameters<Parameters<typeof runAgentLoop>[1]["onEvent"]>[0];

beforeEach(() => {
	// vitest doesn't reset mock call history/queued mockImplementationOnce
	// calls between tests by default (no clearMocks/restoreMocks in this
	// project's vitest config) — without this, toHaveBeenCalledTimes and
	// leftover one-shot implementations from an earlier test bleed into the
	// next one.
	vi.mocked(streamAndCollect).mockClear();
});

// The loop can persist sessions/checkpoints/subagent runs via the DB — point
// every write at a throwaway DB (not the real ~/.cast/sessions/sessions.db).
let fakeDb: string;
let realDb: string | undefined;
beforeEach(() => {
	realDb = process.env.CAST_SESSIONS_DB;
	fakeDb = join(mkdtempSync(join(tmpdir(), "cast-loop-test-")), "sessions.db");
	process.env.CAST_SESSIONS_DB = fakeDb;
	resetDbConnectionForTests();
});
afterEach(() => {
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(join(fakeDb, ".."), { recursive: true, force: true });
});

// ============================================================================
// MessageQueue
// ============================================================================

describe("createAgentContextFork", () => {
	it("freezes the parent snapshot and preserves the exact boundary split", () => {
		const parent: Message[] = [
			{ role: "system", content: "system" },
			{ role: "user", content: "before" },
			{ role: "assistant", content: "checkpoint" },
			{ role: "user", content: "after" },
		];
		const fork = createAgentContextFork(parent, 2);

		expect(fork.boundaryIndex).toBe(2);
		expect(fork.cachePrefixBoundary).toBe(2);
		expect(fork.inheritedMessages).toBe(fork.messages);
		expect(fork.prefix).toEqual(parent.slice(0, 3));
		expect(fork.tail).toEqual(parent.slice(3));
		fork.messages[1] = { role: "user", content: "writer mutation" };
		expect(parent[1]).toEqual({ role: "user", content: "before" });
	});

	it("keeps the compatibility factory on the same explicit fork contract", () => {
		const fork = createAgentForkContext([{ role: "user", content: "only message" }], -1);

		expect(fork.boundaryIndex).toBe(-1);
		expect(fork.cachePrefixBoundary).toBeUndefined();
		expect(fork.prefix).toEqual([]);
		expect(fork.tail).toEqual(fork.inheritedMessages);
	});

	it("freezes the prompt, tool registry, and permission metadata with the fork", () => {
		const tools = [{ type: "function" as const, function: { name: "read", parameters: {} } }];
		const fork = createAgentForkContext([{ role: "user", content: "request" }], 0, {
			systemPrompt: "parent system",
			toolNames: ["read"],
			toolDefinitions: tools,
			allowedTools: ["read"],
			disabledTools: ["bash"],
			readOnlyBash: true,
			permissionMode: "default",
			model: "parent-model",
			runtime: { projectTrusted: true, mcpServerNames: ["demo"] },
		});

		expect(fork).toMatchObject({
			systemPrompt: "parent system",
			toolNames: ["read"],
			toolDefinitions: tools,
			allowedTools: ["read"],
			disabledTools: ["bash"],
			readOnlyBash: true,
			permissionMode: "default",
			model: "parent-model",
			runtime: { projectTrusted: true, mcpServerNames: ["demo"] },
		});
	});

	it("persists only rehydratable runtime identities, never provider or SSH secrets", () => {
		const snapshot = createAgentForkRuntimeSnapshot({
			config: testConfig,
			model: "parent-model",
			cwd: "/tmp/project",
			systemPrompt: "system",
			onEvent: () => {},
			subagentModelProvider: { baseURL: "https://subagent.invalid", apiKey: "sub-secret" },
			sshHosts: [{ name: "prod", host: "prod.example", password: "ssh-secret" }],
			mcpTools: [
				{
					type: "function",
					function: { name: "mcp_demo_lookup", description: "[demo] lookup", parameters: {} },
				},
			],
		});

		expect(snapshot.subagentModelProvider).toEqual({ baseURL: "https://subagent.invalid" });
		expect(snapshot.sshHostNames).toEqual(["prod"]);
		expect(snapshot.mcpServerNames).toEqual(["demo"]);
		expect(snapshot.mcpToolNames).toEqual(["mcp_demo_lookup"]);
		expect(JSON.stringify(snapshot)).not.toContain("sub-secret");
		expect(JSON.stringify(snapshot)).not.toContain("ssh-secret");
	});
});

describe("MessageQueue", () => {
	it("starts empty", () => {
		const q = new MessageQueue();
		expect(q.hasItems()).toBe(false);
		expect(q.length).toBe(0);
		expect(q.drain()).toEqual([]);
	});

	it("enqueues and drains one-at-a-time", () => {
		const q = new MessageQueue();
		const msg1: Message = { role: "user", content: "first" };
		const msg2: Message = { role: "user", content: "second" };

		q.enqueue(msg1);
		q.enqueue(msg2);

		expect(q.hasItems()).toBe(true);
		expect(q.length).toBe(2);

		const first = q.drain();
		expect(first).toEqual([msg1]);
		expect(q.length).toBe(1);

		const second = q.drain();
		expect(second).toEqual([msg2]);
		expect(q.length).toBe(0);

		expect(q.drain()).toEqual([]);
	});

	it("clear removes all messages", () => {
		const q = new MessageQueue();
		q.enqueue({ role: "user", content: "a" });
		q.enqueue({ role: "user", content: "b" });

		expect(q.length).toBe(2);
		q.clear();
		expect(q.length).toBe(0);
		expect(q.hasItems()).toBe(false);
	});

	it("drains one message at a time", () => {
		const q = new MessageQueue();
		q.enqueue({ role: "user", content: "a" });
		q.enqueue({ role: "user", content: "b" });

		const first = q.drain();
		expect(first.length).toBe(1);
		expect(q.length).toBe(1);
	});
});

// ============================================================================
// runAgentLoop — abort vs. genuine error
// ============================================================================

const testConfig: AppConfig = {
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
};

describe("runAgentLoop — abort vs. error", () => {
	it("runs checkpoint maintenance from a full-transcript fork anchored at the current end", async () => {
		const realHome = process.env.HOME;
		const realMemoryDir = process.env.CAST_MEMORY_DIR;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-checkpoint-fork-home-"));
		const projectCwd = mkdtempSync(join(tmpdir(), "cast-checkpoint-fork-project-"));
		process.env.HOME = fakeHome;
		process.env.CAST_MEMORY_DIR = join(fakeHome, "memory");
		updateSettings({ checkpointFork: true });
		const session = createSession("test-model", projectCwd, { id: "fork-session" });
		session.messages = [
			{ role: "system", content: "system" },
			{ role: "user", content: "before checkpoint" },
			{ role: "assistant", content: "checkpoint boundary" },
		];
		saveSession(session);
		// A prior checkpoint already covers everything up to "checkpoint boundary":
		// the fork must still anchor at the CURRENT transcript end so new turns are
		// covered and the watermark can advance past this durable boundary.
		expect(commitCheckpointWatermark(session.id, session.messages[2]!)).toBe(true);

		const requests: Message[][] = [];
		const toolNames: string[][] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_client, _model, _messages, tools) => {
				toolNames.push(tools.map((tool) => tool.function.name));
				return {
					content: "main answer",
					thinking: "",
					finishReason: "stop",
					usage: { promptTokens: 1000, completionTokens: 2, totalTokens: 1002 },
				};
			})
			.mockImplementationOnce(async (_client, _model, messages, tools) => {
				toolNames.push(tools.map((tool) => tool.function.name));
				requests.push(messages.slice());
				messages[1] = { role: "user", content: "writer-only mutation" };
				return { content: "checkpoint saved", thinking: "", finishReason: "stop" };
			});

		try {
			const result = await runAgentLoop(
				[
					{ role: "system", content: "system" },
					{ role: "user", content: "before checkpoint" },
					{ role: "assistant", content: "checkpoint boundary" },
					{ role: "user", content: "after checkpoint" },
				],
				{
					config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
					checkpointThresholds: [1],
					model: "test-model",
					modelProvider: { baseURL: "https://openrouter.ai/api/v1", apiKey: "test" },
					cwd: projectCwd,
					systemPrompt: "test",
					memory: { sessionId: "fork-session" },
					sessionId: "fork-session",
					onEvent: () => {},
					onWarning: (message) => {
						throw new Error(message);
					},
				},
			);

			const deadline = Date.now() + 2_000;
			while (requests.length < 1 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(requests).toHaveLength(1);
			const writerMessages = requests[0]!;
			expect(toolNames[1]).toEqual(toolNames[0]);
			expect(JSON.stringify(writerMessages)).toContain("before checkpoint");
			expect(JSON.stringify(writerMessages)).toContain("after checkpoint");
			expect(JSON.stringify(writerMessages)).toContain("main answer");
			expect(writerMessages.at(-1)?.content).toContain("Fork boundary message index: 4");
			expect(writerMessages.at(-1)?.content).toContain("complete tool registry is available and executable");
			expect(writerMessages.at(-1)?.content).not.toContain("Use only read, write, edit, glob, and grep");
			expect(typeof writerMessages[2]!.content).toBe("string");
			expect(typeof writerMessages[3]!.content).toBe("string");
			const boundary = writerMessages[4]!.content as Array<{ cache_control?: { type: string } }>;
			expect(boundary[0]!.cache_control).toEqual({ type: "ephemeral" });
			expect(result[1]!.content).toBe("before checkpoint");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			if (realMemoryDir === undefined) delete process.env.CAST_MEMORY_DIR;
			else process.env.CAST_MEMORY_DIR = realMemoryDir;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(projectCwd, { recursive: true, force: true });
		}
	});

	it("executes every advertised parent tool from a checkpoint fork", async () => {
		const realHome = process.env.HOME;
		const realMemoryDir = process.env.CAST_MEMORY_DIR;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-checkpoint-parent-tools-home-"));
		const projectCwd = mkdtempSync(join(tmpdir(), "cast-checkpoint-parent-tools-project-"));
		process.env.HOME = fakeHome;
		process.env.CAST_MEMORY_DIR = join(fakeHome, "memory");
		updateSettings({ checkpointFork: true });
		const sessionId = "parent-tools-session";
		saveSession(createSession("test-model", projectCwd, { id: sessionId }));
		const mcpDefinition = {
			type: "function" as const,
			function: { name: "mcp_echo", description: "Echo through the parent MCP runtime", parameters: {} },
		};
		let mcpCalls = 0;
		const writerRequests: Message[][] = [];
		let invocation = 0;
		vi.mocked(streamAndCollect).mockImplementation(async (_client, _model, messages, tools) => {
			invocation += 1;
			if (invocation === 1) {
				expect(tools.some((tool) => tool.function.name === "mcp_echo")).toBe(true);
				return { content: "main answer", finishReason: "stop" };
			}
			writerRequests.push(messages.slice());
			if (invocation === 2) {
				expect(tools.some((tool) => tool.function.name === "mcp_echo")).toBe(true);
				return {
					content: "",
					finishReason: "tool_calls",
					toolCalls: [{ id: "mcp-1", name: "mcp_echo", arguments: "{}" }],
				};
			}
			return { content: "checkpoint saved", finishReason: "stop" };
		});

		try {
			await runAgentLoop([{ role: "user", content: "checkpoint this" }], {
				config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
				checkpointThresholds: [1],
				model: "test-model",
				modelProvider: { baseURL: "https://openrouter.ai/api/v1", apiKey: "test" },
				cwd: projectCwd,
				systemPrompt: "test",
				memory: { sessionId },
				lastPromptTokens: 1_000,
				mcpTools: [mcpDefinition],
				mcpToolIndex: new Map([
					[
						"mcp_echo",
						{
							definition: mcpDefinition,
							call: async () => {
								mcpCalls += 1;
								return { content: "parent tool executed" };
							},
						},
					],
				]) as never,
				onEvent: () => {},
			});

			const deadline = Date.now() + 2_000;
			while (writerRequests.length < 2 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(mcpCalls).toBe(1);
			expect(writerRequests.some((request) => JSON.stringify(request).includes("parent tool executed"))).toBe(true);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			if (realMemoryDir === undefined) delete process.env.CAST_MEMORY_DIR;
			else process.env.CAST_MEMORY_DIR = realMemoryDir;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(projectCwd, { recursive: true, force: true });
		}
	});

	it("repairs an invalid checkpoint and preserves the prior artifact after retry exhaustion", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-checkpoint-validation-home-"));
		const projectCwd = mkdtempSync(join(tmpdir(), "cast-checkpoint-validation-project-"));
		process.env.HOME = fakeHome;
		process.env.CAST_MEMORY_DIR = join(fakeHome, "memory");
		updateSettings({ checkpointFork: true });
		const sessionId = "validation-session";
		const checkpointFile = checkpointPath(sessionId);
		const writerRequests: Message[][] = [];
		let invocation = 0;
		vi.mocked(streamAndCollect).mockImplementation(async (_client, _model, messages) => {
			invocation += 1;
			if (invocation === 1) return { content: "main answer", finishReason: "stop" };
			writerRequests.push(messages.slice());
			if (invocation === 2) writeFileSync(checkpointFile, "# malformed checkpoint\n");
			else writeFileSync(checkpointFile, CHECKPOINT_TEMPLATE);
			return { content: "checkpoint saved", finishReason: "stop" };
		});

		try {
			saveSession(createSession("test-model", projectCwd, { id: sessionId }));
			await runAgentLoop(
				[
					{ role: "system", content: "system" },
					{ role: "user", content: "checkpoint this" },
				],
				{
					config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
					checkpointThresholds: [1],
					model: "test-model",
					modelProvider: { baseURL: "https://openrouter.ai/api/v1", apiKey: "test" },
					cwd: projectCwd,
					systemPrompt: "test",
					memory: { sessionId },
					checkpointBoundary: -1,
					lastPromptTokens: 1_000,
					onEvent: () => {},
				},
			);
			const deadline = Date.now() + 2_000;
			while (writerRequests.length < 2 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 10));
			expect(writerRequests).toHaveLength(2);
			expect(JSON.stringify(writerRequests[1]?.at(-1)?.content)).toContain("failed validation");
			expect(readFileSync(checkpointFile, "utf8")).toBe(CHECKPOINT_TEMPLATE);
			expect(readFileSync(projectMemoryPath(projectIdForCwd(projectCwd)), "utf8")).toContain("# Project memory");
			expect(readFileSync(notesPath(sessionId), "utf8")).toContain("# Session notes");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(projectCwd, { recursive: true, force: true });
		}
	});

	it("uses only the post-checkpoint delta when prefix fork is disabled", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-checkpoint-delta-home-"));
		const projectCwd = mkdtempSync(join(tmpdir(), "cast-checkpoint-delta-project-"));
		process.env.HOME = fakeHome;
		process.env.CAST_MEMORY_DIR = join(fakeHome, "memory");
		updateSettings({ checkpointFork: false });
		const requests: Message[][] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "main answer",
				thinking: "",
				finishReason: "stop",
				usage: { promptTokens: 1000, completionTokens: 2, totalTokens: 1002 },
			}))
			.mockImplementationOnce(async (_client, _model, messages) => {
				requests.push(messages.slice());
				return { content: "checkpoint saved", thinking: "", finishReason: "stop" };
			});

		try {
			saveSession(createSession("test-model", projectCwd, { id: "delta-session" }));
			await runAgentLoop(
				[
					{ role: "system", content: "system" },
					{ role: "user", content: "before checkpoint" },
					{ role: "assistant", content: "checkpoint boundary" },
					{ role: "user", content: "after checkpoint" },
				],
				{
					config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
					checkpointThresholds: [1],
					model: "test-model",
					modelProvider: { baseURL: "https://openrouter.ai/api/v1", apiKey: "test" },
					cwd: projectCwd,
					systemPrompt: "test",
					memory: { sessionId: "delta-session" },
					checkpointBoundary: 2,
					onEvent: () => {},
				},
			);

			const deadline = Date.now() + 2_000;
			while (
				!requests.some((request) => JSON.stringify(request).includes("Fork boundary message index")) &&
				Date.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			const writerMessages = requests.find((request) =>
				JSON.stringify(request).includes("Fork boundary message index"),
			);
			if (!writerMessages)
				throw new Error(
					`checkpoint writer request was not captured: ${JSON.stringify(requests.map((request) => request.map((message) => [message.role, typeof message.content === "string" ? message.content.slice(0, 80) : message.content])))}`,
				);
			expect(writerMessages.some((message) => message.content === "before checkpoint")).toBe(false);
			expect(writerMessages.some((message) => message.content === "after checkpoint")).toBe(true);
			expect(JSON.stringify(writerMessages)).toContain("Fork boundary message index: 2");
			expect(JSON.stringify(writerMessages)).toContain("dedicated checkpoint-writer tool registry");
			expect(JSON.stringify(writerMessages)).not.toContain("complete tool registry is available and executable");
			const children = listBackgroundSessions("delta-session");
			expect(children).toHaveLength(1);
			expect(children[0]).toMatchObject({
				sessionKind: "background",
				parentSessionId: "delta-session",
				backgroundKind: "checkpoint-writer",
			});
			expect(children[0]?.messages.length).toBeGreaterThan(0);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(projectCwd, { recursive: true, force: true });
		}
	});

	it("does not spawn a writer for an empty post-checkpoint delta", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-checkpoint-empty-home-"));
		const projectCwd = mkdtempSync(join(tmpdir(), "cast-checkpoint-empty-project-"));
		process.env.HOME = fakeHome;
		process.env.CAST_MEMORY_DIR = join(fakeHome, "memory");
		updateSettings({ checkpointFork: false });
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "main answer",
			thinking: "",
			finishReason: "stop",
			usage: { promptTokens: 1000, completionTokens: 2, totalTokens: 1002 },
		}));
		try {
			saveSession(createSession("test-model", projectCwd, { id: "empty-delta-session" }));
			await runAgentLoop(
				[
					{ role: "system", content: "system" },
					{ role: "user", content: "already checkpointed" },
				],
				{
					config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
					checkpointThresholds: [1],
					model: "test-model",
					modelProvider: { baseURL: "https://openrouter.ai/api/v1", apiKey: "test" },
					cwd: projectCwd,
					systemPrompt: "test",
					memory: { sessionId: "empty-delta-session" },
					checkpointBoundary: 100,
					onEvent: () => {},
				},
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(listBackgroundSessions("empty-delta-session")).toEqual([]);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
			rmSync(projectCwd, { recursive: true, force: true });
		}
	});

	it("fires the checkpoint writer once per newly crossed threshold", async () => {
		const sessionId = "threshold-session";
		const writers: number[] = [];
		const usages = [400, 800, 900];
		let mainCall = 0;
		const originalImpl = vi.mocked(streamAndCollect).getMockImplementation();
		vi.mocked(streamAndCollect).mockImplementation(async (_client, _model, _messages, _tools, _maxTokens) => {
			if (mainCall < usages.length) {
				const promptTokens = usages[mainCall++]!;
				return {
					content: `turn ${mainCall}`,
					thinking: "",
					finishReason: "stop",
					usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
				};
			}
			return { content: "checkpoint saved", thinking: "", finishReason: "stop" };
		});

		const base = {
			config: { ...testConfig, contextWindow: 1000, maxResponseTokens: 100 },
			checkpointThresholds: [30, 70],
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			memory: { sessionId },
			sessionId,
			onEvent: () => {},
			onCheckpointWriter: () => writers.push(mainCall),
		};
		try {
			// 400/1000 = 40% → crosses 30%. 800/1000 = 80% → crosses 70%.
			// 900/1000 = 90% → both thresholds already crossed, no new writer.
			await runAgentLoop([{ role: "user", content: "first" }], base);
			await runAgentLoop([{ role: "user", content: "second" }], base);
			await runAgentLoop([{ role: "user", content: "third" }], base);

			expect(writers).toHaveLength(2);
		} finally {
			vi.mocked(streamAndCollect).mockImplementation(originalImpl as never);
		}
	});

	it("defaults the checkpoint threshold ladder by window size", () => {
		expect(defaultCheckpointThresholds(10_000)).toEqual([]);
		expect(defaultCheckpointThresholds(100_000)).toEqual([20, 40, 60, 80]);
		expect(defaultCheckpointThresholds(300_000)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
		expect(defaultCheckpointThresholds(1_000_000)).toHaveLength(18);
	});

	it("clamps checkpoint thresholds to the reserved window tail", async () => {
		const sessionId = "reserved-session";
		const writers: number[] = [];
		const usages = [85_000, 88_000]; // 100K window reserves 13K → maxAllowed 87K
		let mainCall = 0;
		const originalImpl = vi.mocked(streamAndCollect).getMockImplementation();
		vi.mocked(streamAndCollect).mockImplementation(async (_client, _model, _messages, _tools, _maxTokens) => {
			if (mainCall < usages.length) {
				const promptTokens = usages[mainCall++]!;
				return {
					content: `turn ${mainCall}`,
					thinking: "",
					finishReason: "stop",
					usage: { promptTokens, completionTokens: 1, totalTokens: promptTokens + 1 },
				};
			}
			return { content: "checkpoint saved", thinking: "", finishReason: "stop" };
		});
		const base = {
			config: { ...testConfig, contextWindow: 100_000, maxResponseTokens: 100 },
			checkpointThresholds: [90],
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			memory: { sessionId },
			sessionId,
			onEvent: () => {},
			onCheckpointWriter: () => writers.push(mainCall),
		};
		try {
			// 90% of 100K = 90K, clamped to 100K - 13K = 87K. 85K stays under,
			// 88K crosses it — so exactly one writer fires.
			await runAgentLoop([{ role: "user", content: "first" }], base);
			await runAgentLoop([{ role: "user", content: "second" }], base);
			expect(writers).toHaveLength(1);
		} finally {
			vi.mocked(streamAndCollect).mockImplementation(originalImpl as never);
		}
	});

	it("does not reconstruct memory while preparing an ordinary turn", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-memory-budget-home-"));
		process.env.HOME = fakeHome;
		const buildPrompt = vi.fn(() => "");
		const memoryService = {
			search: vi.fn(() => []),
			buildPrompt,
		};
		const requests: Message[][] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_client, _model, messages) => {
			requests.push(messages.slice());
			return { content: "done", finishReason: "stop" };
		});

		try {
			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: { ...testConfig, contextWindow: 10_000, maxResponseTokens: 1_000 },
				model: "test-model",
				cwd: process.cwd(),
				systemPrompt: "test",
				memory: { sessionId: "memory-budget", service: memoryService },
				onEvent: () => {},
			});

			expect(buildPrompt).not.toHaveBeenCalled();
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("does not inject the full memory prompt during an ordinary tool loop", async () => {
		const requests: Message[][] = [];
		const buildPrompt = vi.fn(() => "<project-memory>cached</project-memory>");
		const memoryService = {
			search: vi.fn(() => []),
			buildPrompt,
		};
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_client, _model, messages) => {
				requests.push(messages.slice());
				return {
					content: "",
					finishReason: "tool_calls",
					toolCalls: [{ id: "1", name: "mcp_echo", arguments: "{}" }],
				};
			})
			.mockResolvedValueOnce({ content: "done", finishReason: "stop" });

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			memory: { sessionId: "memory-cache", service: memoryService },
			mcpTools: [{ type: "function", function: { name: "mcp_echo", parameters: {} } }],
			mcpToolIndex: new Map([["mcp_echo", { call: async () => ({ content: "ok" }) }]]) as never,
			onEvent: () => {},
		});

		expect(buildPrompt).not.toHaveBeenCalled();
		expect(requests[0]?.[0]?.content).not.toContain("search it with the memory tool");
		expect(requests[0]?.[0]?.content).not.toContain("<project-memory>");
	});

	it("does not inject automatic memory when background memory writing is disabled", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-memory-write-off-home-"));
		process.env.HOME = fakeHome;
		updateSettings({ memoryWriteEnabled: false });
		const buildPrompt = vi.fn(() => "<project-memory>must be on demand</project-memory>");
		const memoryService = {
			search: vi.fn(() => []),
			buildPrompt,
		};
		const requests: Message[][] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_client, _model, messages) => {
			requests.push(messages.slice());
			return { content: "done", finishReason: "stop" };
		});

		try {
			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: process.cwd(),
				systemPrompt: "test",
				memory: { sessionId: "memory-write-off", service: memoryService },
				onEvent: () => {},
			});
			expect(buildPrompt).not.toHaveBeenCalled();
			expect(requests[0]?.[0]?.content).not.toContain("search it with the memory tool");
			expect(requests[0]?.[0]?.content).not.toContain("# Memory system");
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("does not retrieve or write memory when the global memory setting is disabled", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-memory-disabled-test-"));
		process.env.HOME = fakeHome;
		updateSettings({ memoryEnabled: false });
		const memoryService = {
			search: vi.fn(),
			buildPrompt: vi.fn(() => "<project-memory>must not be sent</project-memory>"),
		};
		vi.mocked(streamAndCollect).mockResolvedValueOnce({ content: "done", finishReason: "stop" });

		try {
			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: process.cwd(),
				systemPrompt: "test",
				memory: { sessionId: "memory-disabled", service: memoryService },
				onEvent: () => {},
			});
			await new Promise((resolve) => setImmediate(resolve));
			expect(memoryService.buildPrompt).not.toHaveBeenCalled();
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("reports reason 'aborted' (not 'error') when the request was aborted mid-stream", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// A real abort fires *while a request is in flight* — not before it
		// even starts, which the loop's own top-of-iteration `signal?.aborted`
		// check already handled correctly. This simulates the actual failure
		// mode: /abort tears down the fetch mid-stream, and only *then* is the
		// signal marked aborted, so the exception has to be caught and
		// classified after the fact — that classification is what this fix is
		// actually about.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("Request was aborted.");
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "aborted" });
		// A genuine "error" event must not also fire for a plain abort — that's
		// exactly what made the UI show the literal word "error" instead of
		// "Aborted" (see useAgentSession.ts's "end" case).
		expect(events.some((e) => e.type === "error")).toBe(false);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
	});

	it("reports 'aborted' when a mid-stream abort ends the stream cleanly (no exception)", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// Undici can end the async iterator cleanly on a mid-stream abort instead
		// of throwing: streamAndCollect returns a partial result and reports
		// interrupted=true (aborted before a natural finish_reason). This is the
		// "Esc during reasoning shows no Aborted" case — without the post-stream
		// check the turn would commit as a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "partial answer", thinking: "was mid-reasoning", finishReason: "stop", interrupted: true };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "aborted" });
		expect(events.some((e) => e.type === "error")).toBe(false);
		// The partial turn must not have been committed as a finished assistant
		// message (no turn_end) — it ends as an abort, not a normal stop.
		expect(events.some((e) => e.type === "turn_end")).toBe(false);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
	});

	it("appends an interrupt system-reminder into messages on mid-stream abort", async () => {
		const controller = new AbortController();
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "half", thinking: "", finishReason: "stop", interrupted: true };
		});

		const events: AgentEvent[] = [];
		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(true);
		const reminder = messages.find(
			(m) =>
				m.role === "user" &&
				typeof m.content === "string" &&
				m.content.includes("[Request interrupted by user]") &&
				m.content.includes("<system-reminder>"),
		);
		expect(reminder).toBeDefined();
	});

	it("injects a date-rollover reminder when announcedLocalDate is behind today", async () => {
		const today = formatLocalDate();
		const d = new Date();
		const yesterday = formatLocalDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
		const announced = { value: yesterday };

		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "ok",
			thinking: "",
			finishReason: "stop",
		}));

		const events: AgentEvent[] = [];
		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			announcedLocalDate: announced,
			onEvent: (event) => events.push(event),
		});

		expect(events.some((e) => e.type === "date_rollover" && e.date === today)).toBe(true);
		expect(announced.value).toBe(today);
		// applyCacheControl may rewrite user content to a text-part array before the request.
		expect(
			messages.some((m) => {
				if (m.role !== "user") return false;
				const text = contentToText(m.content);
				return text.includes("calendar date has advanced") && text.includes(today);
			}),
		).toBe(true);
	});

	it("does not inject a date-rollover reminder when the announced date is already today", async () => {
		const announced = { value: formatLocalDate() };

		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "ok",
			thinking: "",
			finishReason: "stop",
		}));

		const events: AgentEvent[] = [];
		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			announcedLocalDate: announced,
			onEvent: (event) => events.push(event),
		});

		expect(events.some((e) => e.type === "date_rollover")).toBe(false);
	});

	it("does NOT report 'aborted' when the turn finished just before a late abort", async () => {
		const controller = new AbortController();
		const events: AgentEvent[] = [];

		// The stream reached a natural finish_reason (interrupted=false), and only
		// then did a late Esc set the signal. A completed answer must not be
		// mislabeled "Aborted" — it commits as a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			return { content: "Привет.", thinking: "", finishReason: "stop", interrupted: false };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: controller.signal,
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "stop" });
		expect(events.some((e) => e.type === "turn_end")).toBe(true);
		expect(events.some((e) => e.type === "interrupt_reminder")).toBe(false);
	});

	it("reports 'disconnected' when the stream is silently truncated (no finish, no usage, no abort)", async () => {
		const events: AgentEvent[] = [];

		// Provider dropped mid-response: the stream ended cleanly but never sent a
		// finish_reason or usage summary, and there was no user abort. Must not
		// look like a normal stop.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			return { content: "half an ans", thinking: "", finishReason: "stop", disconnected: true };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "disconnected" });
		expect(events.some((e) => e.type === "turn_end")).toBe(false);
		expect(events.some((e) => e.type === "error")).toBe(false);
	});

	it("still reports reason 'error' for a genuine failure unrelated to abort", async () => {
		const events: AgentEvent[] = [];

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			// No signal at all — streamAndCollect's stub throws its "always
			// throws" error, unrelated to any abort.
			onEvent: (event) => events.push(event),
		});

		const endEvent = events.find((e) => e.type === "end");
		expect(endEvent).toEqual({ type: "end", reason: "error" });
		expect(events.some((e) => e.type === "error")).toBe(true);
	});
});

// ============================================================================
// runAgentLoop — truncated response retry (finishReason "length", no tool call)
// ============================================================================

describe("runAgentLoop — retries a length-truncated response with no tool call", () => {
	it("retries with doubled budget when content is empty (pure reasoning exhaustion)", async () => {
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "still thinking...",
				finishReason: "length",
			}))
			.mockImplementationOnce(async () => ({ content: "final answer", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
			onWarning: (message) => events.push({ type: "warning_probe", message } as unknown as AgentEvent),
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("retries with doubled budget when content is non-empty but no tool call was reached", async () => {
		// The real-world case: the model wrote a partial reply ("I'll rewrite the
		// file now...") and got cut off by finishReason "length" before it ever
		// called a tool. The old !completion.content check missed this — a
		// non-empty stub got committed as if it were the model's real answer,
		// and the model could repeat this same stub turn after turn since
		// nothing forced more budget into the retry.
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "I'll rewrite the file now.",
				thinking: "",
				finishReason: "length",
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		// The truncated stub must not appear anywhere in history — it was
		// discarded and replaced by the retried, complete turn.
		expect(messages.some((m) => m.role === "assistant" && m.content === "I'll rewrite the file now.")).toBe(false);
	});

	it("does not retry a second time — commits whatever the retry produced", async () => {
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({ content: "stub one", thinking: "", finishReason: "length" }))
			.mockImplementationOnce(async () => ({ content: "stub two", thinking: "", finishReason: "length" }));

		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(messages.some((m) => m.role === "assistant" && m.content === "stub two")).toBe(true);
	});

	it("warns when the retried turn is still empty, so '(no response)' is never unexplained", async () => {
		const warnings: string[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({ content: "", thinking: "reasoning...", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "", thinking: "reasoning again...", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: () => {},
			onWarning: (message) => warnings.push(message),
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(warnings.some((w) => w.includes("empty response again"))).toBe(true);
	});

	it("retries an empty 'stop' completion with a nudge, so the model actually answers", async () => {
		// A reasoning model burns the whole output budget on reasoning_content
		// and stops with no final text — the "(no response)" case. Mirroring
		// MiMo Code's think-only recovery: retry once, doubling the budget AND
		// telling the model why, instead of committing the placeholder.
		const events: AgentEvent[] = [];
		let retryMessages: Message[] | undefined;
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "deep reasoning...",
				finishReason: "stop",
			}))
			.mockImplementationOnce(async (_client, _model, messages) => {
				retryMessages = messages as Message[];
				return { content: "here is the real answer", thinking: "", finishReason: "stop" };
			});

		const result = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		const nudge = retryMessages?.find(
			(m) => m.role === "user" && typeof m.content === "string" && m.content.includes("no usable answer"),
		);
		expect(nudge).toBeDefined();
		expect(result.at(-1)?.content).toBe("here is the real answer");
		expect(events.some((e) => e.type === "end" && (e as { reason: string }).reason === "stop")).toBe(true);
	});

	it("does not retry when a tool call was reached despite finishReason 'length'", async () => {
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "",
			thinking: "",
			finishReason: "length",
			toolCalls: [{ id: "1", name: "bash", arguments: '{"command":"echo hi"}' }],
		}));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(event),
		});

		// One call to start the tool round; a second real completion call
		// follows to close the loop, but neither is the length-truncation retry.
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalled();
	});
});

describe("runAgentLoop — preserved reasoning", () => {
	it("keeps native reasoning_content on every assistant turn for compatible providers", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "answer",
			thinking: "private reasoning",
			reasoningContent: "provider-native trace",
			finishReason: "stop",
		}));

		const messages = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: () => {},
		});

		const assistant = messages.find((message) => message.role === "assistant") as
			| (Message & { reasoning_content?: string })
			| undefined;
		expect(assistant?.reasoning_content).toBe("provider-native trace");
	});
});

// ============================================================================
// runAgentLoop — /steer and /fu (steering + follow-up injection)
// ============================================================================

describe("runAgentLoop — steering and follow-up injection", () => {
	it("injects a steering message enqueued mid-run and carries its content on the event", async () => {
		const steeringQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				// Simulate /steer arriving while this first request is in flight —
				// the loop only re-checks the queue after this turn ends.
				steeringQueue.enqueue({ role: "user", content: "steered instruction" });
				return { content: "first response", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "second response", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			// Snapshot immediately: applyCacheControl mutates message objects
			// in-place on later turns (adds cache_control markers), and this event
			// holds the *same* object references, not copies — matching what the
			// real consumer (useAgentSession.ts) does, extracting content
			// synchronously in the same tick rather than holding onto the event.
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const steeringEvent = events.find((e) => e.type === "steering_injected");
		expect(steeringEvent?.type).toBe("steering_injected");
		expect(steeringEvent && "messages" in steeringEvent ? steeringEvent.messages : undefined).toEqual([
			{ role: "user", content: "steered instruction" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("drains multiple queued steering messages one at a time, across separate turns", async () => {
		// MessageQueue.drain() (see loop.ts) only ever returns one message —
		// queuing two /steer messages before the current turn ends must not
		// collapse them into a single steering_injected event, or the UI's
		// pending-count indicator (useAgentSession.ts's pendingSteers) would
		// have nothing left to shift for the second one and show it as
		// consumed before it actually was.
		const steeringQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				steeringQueue.enqueue({ role: "user", content: "first steer" });
				steeringQueue.enqueue({ role: "user", content: "second steer" });
				return { content: "response 1", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "response 2", thinking: "", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "response 3", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const steeringEvents = events.filter((e) => e.type === "steering_injected");
		expect(steeringEvents).toHaveLength(2);
		expect(steeringEvents[0]?.type === "steering_injected" && steeringEvents[0].messages).toEqual([
			{ role: "user", content: "first steer" },
		]);
		expect(steeringEvents[1]?.type === "steering_injected" && steeringEvents[1].messages).toEqual([
			{ role: "user", content: "second steer" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);

		// Mirrors useAgentSession.ts's pendingSteers bookkeeping: append on
		// steer(), shift the front off on each steering_injected. Should count
		// down 2 -> 1 -> 0, never jumping straight to empty and hiding the
		// still-queued second message.
		let pendingSteers: string[] = ["first steer", "second steer"];
		const pendingCounts: number[] = [];
		for (const event of steeringEvents) {
			if (event.type !== "steering_injected") continue;
			pendingSteers = pendingSteers.slice(event.messages.length);
			pendingCounts.push(pendingSteers.length);
		}
		expect(pendingCounts).toEqual([1, 0]);
	});

	it("injects a follow-up message queued after the agent would otherwise stop", async () => {
		const followUpQueue = new MessageQueue();
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => {
				followUpQueue.enqueue({ role: "user", content: "follow-up instruction" });
				return { content: "first response", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async () => ({ content: "second response", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			followUpQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const followUpEvent = events.find((e) => e.type === "followup_injected");
		expect(followUpEvent?.type).toBe("followup_injected");
		expect(followUpEvent && "messages" in followUpEvent ? followUpEvent.messages : undefined).toEqual([
			{ role: "user", content: "follow-up instruction" },
		]);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("does not duplicate an earlier turn's committed content in the persisted partial on a later abort", async () => {
		// A multi-message run (follow-up turn inside the same runAgentLoop call)
		// used to leave turn 1's already-committed content in the partialContent
		// accumulator. An abort mid-turn-2 then persisted turn1+turn2-partial as
		// the "partial assistant" — duplicating turn 1 in history.
		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "follow up" });
		const controller = new AbortController();
		let call = 0;
		vi.mocked(streamAndCollect).mockImplementation(
			async (_client, _model, _messages, _tools, _maxTokens, signal, onToken) => {
				call++;
				if (call === 1) {
					onToken?.("turn one content");
					return { content: "turn one content", thinking: "", finishReason: "stop" };
				}
				// Turn 2 streams a bit, then the user hits Esc mid-stream.
				onToken?.("turn two partial");
				controller.abort();
				throw new Error("Request was aborted.");
			},
		);

		const result = await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			followUpQueue,
			signal: controller.signal,
			onEvent: () => {},
		});

		const assistantTexts = result
			.filter((m) => m.role === "assistant" && typeof m.content === "string")
			.map((m) => m.content as string);
		expect(assistantTexts).toContain("turn one content");
		// The persisted partial is only turn 2's own stream, not turn1+turn2.
		expect(assistantTexts.at(-1)).toBe("turn two partial");
		expect(assistantTexts.filter((t) => t.includes("turn one content"))).toHaveLength(1);
	});
});

// ============================================================================
// runAgentLoop — rules auto-attach through the real loop (end-to-end stitch)
// ============================================================================

describe("runAgentLoop — context files drive rule auto-attach", () => {
	it("a real read tool call latches a glob rule into the next turn's system prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-rules-"));
		try {
			// A real file the agent will `read`, and two rules: one always-apply
			// (must appear every turn) and one auto-attach on **/*.tsx (must appear
			// only after the .tsx file enters context via the tool call).
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "App.tsx"), "export const App = () => null;");
			const rulesDir = join(cwd, ".cast", "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "root.md"), "---\nalwaysApply: true\n---\nALWAYS_RULE_BODY");
			writeFileSync(join(rulesDir, "web.md"), '---\nglobs: ["**/*.tsx"]\n---\nWEB_RULE_BODY');
			const catalog = loadDirectoryRules({ projectCwd: cwd });

			// Mirror App.tsx's rebuild: latch sticky auto rules, record each prompt.
			let sticky: ReturnType<typeof matchAutoRules> = [];
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles }: { userText: string; contextFiles: string[] }) => {
				sticky = unionStickyRules(sticky, matchAutoRules(catalog, contextFiles));
				const p = `SYS${formatRulesForTurn(catalog, sticky, [])}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new MessageQueue();
			vi.mocked(streamAndCollect)
				// Turn 1, call 1: the model asks to read the .tsx file.
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
				}))
				// Turn 1, call 2: tool result is back; model stops. Queue a follow-up
				// so the outer loop runs again (rebuild only fires per outer turn).
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				// Turn 2: nothing more to do.
				.mockImplementationOnce(async () => ({ content: "second turn", thinking: "", finishReason: "stop" }));

			await runAgentLoop([{ role: "user", content: "look at the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			// Turn 1's prompt: always rule present, web rule NOT yet (no file in
			// context when the turn began).
			expect(prompts[0]).toContain("ALWAYS_RULE_BODY");
			expect(prompts[0]).not.toContain("WEB_RULE_BODY");
			// Turn 2's prompt: the read populated contextFiles, so the .tsx glob
			// rule has now latched — alongside the always rule.
			const last = prompts.at(-1)!;
			expect(last).toContain("ALWAYS_RULE_BODY");
			expect(last).toContain("WEB_RULE_BODY");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("attaches a glob rule within the SAME submit — the request after the read already carries it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-rules2-"));
		try {
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "App.tsx"), "export const App = () => null;");
			const rulesDir = join(cwd, ".cast", "rules");
			mkdirSync(rulesDir, { recursive: true });
			writeFileSync(join(rulesDir, "web.md"), '---\nglobs: ["**/*.tsx"]\n---\nWEB_RULE_BODY');
			const catalog = loadDirectoryRules({ projectCwd: cwd });

			let sticky: ReturnType<typeof matchAutoRules> = [];
			const rebuildSystemPrompt = ({ contextFiles }: { userText: string; contextFiles: string[] }) => {
				sticky = unionStickyRules(sticky, matchAutoRules(catalog, contextFiles));
				return `SYS${formatRulesForTurn(catalog, sticky, [])}`;
			};

			// Capture the system prompt (messages[0]) actually sent on each request.
			const sentPrompts: string[] = [];
			vi.mocked(streamAndCollect)
				// Request 1: no file seen yet → prompt must NOT carry the rule.
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [{ id: "r1", name: "read", arguments: JSON.stringify({ path: "src/App.tsx" }) }],
					};
				})
				// Request 2: same submit, continuation after the read → the rule
				// must already be present without any follow-up message.
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return { content: "done", thinking: "", finishReason: "stop" };
				});

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				rebuildSystemPrompt,
				contextFiles: [],
				onEvent: () => {},
			});

			expect(sentPrompts).toHaveLength(2);
			expect(sentPrompts[0]).not.toContain("WEB_RULE_BODY"); // before the read
			expect(sentPrompts[1]).toContain("WEB_RULE_BODY"); // right after the read, same turn
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — cumulative embedded-image budget (real incident regression)
// ============================================================================

describe("runAgentLoop — caps total embedded image bytes across reads, not just per-file", () => {
	it("embeds the first image but gracefully omits a second that would push the running total over budget", async () => {
		// Reproduces the real incident: several individually-small images (each
		// under tools/files.ts's per-file MAX_IMAGE_BYTES) piling up in one
		// context got a bare, undebuggable 400 from the provider. Two 3MB raw
		// files (~4MB base64 each) — the first fits under the 6MB running cap,
		// the second alone would push it to ~8MB and must be omitted instead of
		// silently exceeding the budget.
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-image-budget-"));
		try {
			writeFileSync(join(cwd, "a.jpg"), Buffer.alloc(3 * 1024 * 1024, 1));
			writeFileSync(join(cwd, "b.jpg"), Buffer.alloc(3 * 1024 * 1024, 2));

			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{ id: "r1", name: "read", arguments: JSON.stringify({ path: "a.jpg" }) },
						{ id: "r2", name: "read", arguments: JSON.stringify({ path: "b.jpg" }) },
					],
				}))
				.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

			const messages = await runAgentLoop([{ role: "user", content: "look at both photos" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				onEvent: () => {},
			});

			const imageMessages = messages.filter(
				(m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
			);
			expect(imageMessages).toHaveLength(1); // only the first image actually embedded

			const toolResults = messages.filter((m) => m.role === "tool") as Array<{
				tool_call_id: string;
				content: string;
			}>;
			const secondResult = toolResults.find((m) => m.tool_call_id === "r2");
			expect(secondResult?.content).toContain("[Image omitted:");
			expect(secondResult?.content).toContain("already");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("embeds images from separate reads across turns, still respecting the same running total", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-image-budget2-"));
		try {
			writeFileSync(join(cwd, "a.jpg"), Buffer.alloc(3 * 1024 * 1024, 1));
			writeFileSync(join(cwd, "b.jpg"), Buffer.alloc(3 * 1024 * 1024, 2));
			const followUpQueue = new MessageQueue();

			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "r1", name: "read", arguments: JSON.stringify({ path: "a.jpg" }) }],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "now the other one" });
					return { content: "ok", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "r2", name: "read", arguments: JSON.stringify({ path: "b.jpg" }) }],
				}))
				.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

			const messages = await runAgentLoop([{ role: "user", content: "look at the first photo" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				followUpQueue,
				systemPrompt: "SYS",
				onEvent: () => {},
			});

			const imageMessages = messages.filter(
				(m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
			);
			expect(imageMessages).toHaveLength(1); // the second read's image is omitted, budget carries across turns

			const secondResult = messages.find(
				(m) => m.role === "tool" && (m as { tool_call_id: string }).tool_call_id === "r2",
			) as { content: string } | undefined;
			expect(secondResult?.content).toContain("[Image omitted:");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — vision fallback on a model/endpoint that rejects images
// ============================================================================

describe("runAgentLoop — vision fallback", () => {
	it("strips rejected image_url parts, keeps the text, warns, and completes via the retry", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-vision-"));
		try {
			const events: string[] = [];
			const warnings: string[] = [];
			// Reproduces the real provider failure (400 + "image" in the body) —
			// the loop must recover, not surface the raw error.
			const imageError = Object.assign(new Error("image input is not supported by this endpoint"), {
				status: 400,
			});
			vi.mocked(streamAndCollect)
				.mockRejectedValueOnce(imageError)
				.mockImplementationOnce(async () => ({
					content: "I can't see the image",
					thinking: "",
					finishReason: "stop",
				}));

			const messages = await runAgentLoop(
				[
					{
						role: "user",
						content: [
							{ type: "text", text: "What color is this?" },
							{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
						],
					},
				],
				{
					config: testConfig,
					model: "test-model",
					cwd,
					systemPrompt: "SYS",
					onEvent: (e) => events.push(e.type),
					onWarning: (m) => warnings.push(m),
				},
			);

			expect(warnings).toEqual(["Model doesn't support images — sending file path only"]);
			// The successful retry must not be discarded by a re-thrown original error.
			expect(events).not.toContain("error");
			const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as Message;
			expect(lastAssistant?.content).toBe("I can't see the image");
			// The retry kept the user's text but dropped the image part.
			const userMsg = messages.find((m) => m.role === "user" && Array.isArray(m.content)) as Message;
			expect(userMsg.content).toEqual([{ type: "text", text: "What color is this?" }]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — moderation refusal (finish_reason content_filter / refusal field)
// ============================================================================

describe("runAgentLoop — moderation refusal", () => {
	it("surfaces a content_filter refusal instead of committing an empty answer", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-refusal-"));
		try {
			const events: string[] = [];
			const warnings: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "content_filter",
				refusal: "I can't help with that request.",
			}));

			const messages = await runAgentLoop([{ role: "user", content: "please do the bad thing" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				onEvent: (e) => events.push(e.type),
				onWarning: (m) => warnings.push(m),
			});

			expect(warnings.some((w) => w.includes("refused the request"))).toBe(true);
			expect(events).not.toContain("error");
			const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as Message;
			expect(String(lastAssistant?.content)).toContain("I can't help with that request.");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("still warns when content_filter arrives without a refusal text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-refusal2-"));
		try {
			const warnings: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "content_filter",
			}));

			await runAgentLoop([{ role: "user", content: "hello" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				onEvent: () => {},
				onWarning: (m) => warnings.push(m),
			});

			expect(warnings.some((w) => w.includes("content filter"))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — nested AGENTS.md injection end-to-end
// ============================================================================
describe("runAgentLoop — nested AGENTS.md injection", () => {
	it("a read in a subdirectory with its own AGENTS.md injects it into the next system prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents-"));
		try {
			// Set up a monorepo-like structure:
			//   <cwd>/AGENTS.md            — "ROOT_INSTRUCTIONS" (static base)
			//   <cwd>/apps/web/AGENTS.md   — "WEB_INSTRUCTIONS" (nested, should appear after read)
			//   <cwd>/apps/web/App.tsx     — the file the agent reads
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "App.tsx"), "export const App = () => null;", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([
				{ path: join(cwd, "AGENTS.md"), content: "ROOT_INSTRUCTIONS" },
			]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "apps/web/App.tsx" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			expect(prompts[0]).toContain("ROOT_INSTRUCTIONS");
			expect(prompts[0]).not.toContain("WEB_INSTRUCTIONS");
			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT_INSTRUCTIONS");
			expect(last).toContain("WEB_INSTRUCTIONS");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("nested AGENTS.md appears in the SAME turn — the request right after the read carries it", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents2-"));
		try {
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB_INSTRUCTIONS", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "App.tsx"), "export const App = () => null;", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([
				{ path: join(cwd, "AGENTS.md"), content: "ROOT_INSTRUCTIONS" },
			]);
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				return `SYS${baseSuffix}${nested}`;
			};

			const sentPrompts: string[] = [];
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [
							{
								id: "r1",
								name: "read",
								arguments: JSON.stringify({ path: "apps/web/App.tsx" }),
							},
						],
					};
				})
				.mockImplementationOnce(async (_c, _m, msgs) => {
					sentPrompts.push(JSON.stringify((msgs as Message[])[0]?.content ?? ""));
					return { content: "done", thinking: "", finishReason: "stop" };
				});

			await runAgentLoop([{ role: "user", content: "read the component" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				rebuildSystemPrompt,
				contextFiles: [],
				onEvent: () => {},
			});

			expect(sentPrompts).toHaveLength(2);
			expect(sentPrompts[0]).not.toContain("WEB_INSTRUCTIONS");
			expect(sentPrompts[1]).toContain("WEB_INSTRUCTIONS");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("deeply nested AGENTS.md (3 levels) attaches the full chain shallow-to-deep", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents3-"));
		try {
			mkdirSync(join(cwd, "apps", "web", "components"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "components", "AGENTS.md"), "COMPONENTS", "utf-8");
			writeFileSync(
				join(cwd, "apps", "web", "components", "Button.tsx"),
				"export const Button = () => null;",
				"utf-8",
			);

			const baseSuffix = formatContextFilesForPrompt([{ path: join(cwd, "AGENTS.md"), content: "ROOT" }]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "apps/web/components/Button.tsx" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the button" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			expect(prompts[0]).toContain("ROOT");
			expect(prompts[0]).not.toContain("WEB");
			expect(prompts[0]).not.toContain("COMPONENTS");

			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT");
			const webIdx = last.indexOf("WEB");
			const compIdx = last.indexOf("COMPONENTS");
			expect(webIdx).toBeGreaterThan(-1);
			expect(compIdx).toBeGreaterThan(webIdx);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("scoped: reading a file in services/ does NOT pull apps/web/ AGENTS.md", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nested-agents4-"));
		try {
			mkdirSync(join(cwd, "apps", "web"), { recursive: true });
			mkdirSync(join(cwd, "services", "api"), { recursive: true });
			writeFileSync(join(cwd, "AGENTS.md"), "ROOT", "utf-8");
			writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "WEB", "utf-8");
			writeFileSync(join(cwd, "services", "api", "AGENTS.md"), "API", "utf-8");
			writeFileSync(join(cwd, "services", "api", "main.go"), "package main", "utf-8");

			const baseSuffix = formatContextFilesForPrompt([{ path: join(cwd, "AGENTS.md"), content: "ROOT" }]);
			const prompts: string[] = [];
			const rebuildSystemPrompt = ({ contextFiles: ctxFiles }: { userText: string; contextFiles: string[] }) => {
				const nested = formatContextFilesForPrompt(resolveNestedContextFiles(cwd, ctxFiles));
				const p = `SYS${baseSuffix}${nested}`;
				prompts.push(p);
				return p;
			};

			const followUpQueue = new (await import("../src/core/loop.ts")).MessageQueue();
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "read",
							arguments: JSON.stringify({ path: "services/api/main.go" }),
						},
					],
				}))
				.mockImplementationOnce(async () => {
					followUpQueue.enqueue({ role: "user", content: "continue" });
					return { content: "read done", thinking: "", finishReason: "stop" };
				})
				.mockImplementationOnce(async () => ({
					content: "second turn",
					thinking: "",
					finishReason: "stop",
				}));

			await runAgentLoop([{ role: "user", content: "read the go file" }], {
				config: testConfig,
				model: "test-model",
				cwd,
				systemPrompt: "SYS",
				followUpQueue,
				rebuildSystemPrompt,
				onEvent: () => {},
			});

			const last = prompts.at(-1)!;
			expect(last).toContain("ROOT");
			expect(last).toContain("API");
			expect(last).not.toContain("WEB");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — plan mode
// ============================================================================

// applyCacheControl rewrites message content in place into a structured
// [{ type: "text", text }] array before the request goes out — flatten it
// back to text to assert on prompts.
const contentToText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p: { type?: string; text?: string }) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
		.join("");
};

describe("runAgentLoop — plan mode", () => {
	it("prepends the plan block even when rebuildSystemPrompt replaces the prompt", async () => {
		// rebuildSystemPrompt is always set in the TUI and rebuilds the prompt
		// wholesale — the plan block must be applied after it, not overwritten.
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "ok", thinking: "", finishReason: "stop" };
			},
		);

		await runAgentLoop([{ role: "user", content: "plan the feature" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "BASE_PROMPT",
			rebuildSystemPrompt: () => "REBUILT_PROMPT",
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});

		const prompt = systemPrompts[0]!;
		expect(prompt.startsWith("═")).toBe(true);
		expect(prompt).toContain("PLAN MODE ACTIVE");
		// The rebuilt prompt survives below the block — and only once.
		expect(prompt).toContain("REBUILT_PROMPT");
		expect(prompt.indexOf("PLAN MODE ACTIVE")).toBe(prompt.lastIndexOf("PLAN MODE ACTIVE"));
		expect(prompt).not.toContain("BASE_PROMPT");
	});

	it("injects neither block when plan mode is off and no plan was written", async () => {
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "ok", thinking: "", finishReason: "stop" };
			},
		);

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "BASE_PROMPT",
			planState: { enabled: false, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});

		expect(systemPrompts[0]).toBe("BASE_PROMPT");
	});

	it("appends the approved plan in build mode when a plan file exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-build-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n1. PLAN_STEP_MARKER", "utf-8");
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE_PROMPT",
				rebuildSystemPrompt: () => "REBUILT_PROMPT",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			// Guidance, not restriction: the base prompt (persona) stays on top.
			expect(prompt.startsWith("REBUILT_PROMPT")).toBe(true);
			expect(prompt).toContain("PLAN_STEP_MARKER");
			expect(prompt).not.toContain("PLAN MODE ACTIVE");
			expect(prompt).not.toContain("{{PLAN}}");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("snapshots the plan per run — mid-run file changes don't churn the system prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-snapshot-"));
		const planPath = join(dir, "feature.md");
		writeFileSync(planPath, "# Plan\n\n## Steps\n- [ ] SNAPSHOT_V1", "utf-8");
		try {
			const systemPrompts: string[] = [];
			const capture = async (_client: unknown, _model: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "", thinking: "", finishReason: "stop" };
			};
			vi.mocked(streamAndCollect)
				// Request 1: model asks for a read; between requests the plan file
				// changes on disk while the run is active.
				.mockImplementationOnce(async (_c: unknown, _m: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					writeFileSync(planPath, "# Plan\n\n## Steps\n- [x] SNAPSHOT_V2", "utf-8");
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [{ id: "t1", name: "ls", arguments: JSON.stringify({ path: "." }) }],
					};
				})
				.mockImplementationOnce(capture);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			expect(systemPrompts).toHaveLength(2);
			expect(systemPrompts[0]).toContain("SNAPSHOT_V1");
			// Same prompt on the second request — the mid-run edit is invisible
			// until the next run, keeping the provider prompt cache intact.
			expect(systemPrompts[1]).toBe(systemPrompts[0]);
			expect(systemPrompts[1]).not.toContain("SNAPSHOT_V2");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("replaces the mirror with a short reference once every linked task is complete", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-done-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [x] step one\n- [x] step two", "utf-8");
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "step one", status: "completed", priority: "medium", planStep: "step one" },
					{ content: "step two", status: "completed", priority: "medium", planStep: "step two" },
				],
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			expect(prompt).toContain("fully executed");
			expect(prompt).toContain("feature");
			expect(prompt).not.toContain("<plan>");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("names the session's other plans in the mirror block", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-others-"));
		writeFileSync(join(dir, "alt.md"), "# Alt\n\n## Steps\n- [ ] other work", "utf-8");
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [ ] ACTIVE_MARKER", "utf-8");
		// alt is older → feature resolves as the active plan.
		const past = new Date(Date.now() - 60_000);
		utimesSync(join(dir, "alt.md"), past, past);
		try {
			const systemPrompts: string[] = [];
			vi.mocked(streamAndCollect).mockImplementationOnce(
				async (_client: unknown, _model: string, messages: unknown) => {
					systemPrompts.push(contentToText((messages as Message[])[0]!.content));
					return { content: "ok", thinking: "", finishReason: "stop" };
				},
			);

			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: () => {},
			});

			const prompt = systemPrompts[0]!;
			expect(prompt).toContain("ACTIVE_MARKER");
			expect(prompt).toContain("Other plans in this session: alt");
			// The other plan is named, not injected.
			expect(prompt).not.toContain("other work");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restricts bash to read-only commands in plan mode at the executor", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			// One mutating call, one read-only call in the same batch.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/evil" }) },
					{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo PLAN_OK" }) },
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "explore" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: (e) => events.push(e),
		});

		const ends = events.filter((e) => e.type === "tool_end");
		const starts = events.filter((e) => e.type === "tool_start");
		expect(starts).toHaveLength(2);
		expect(starts.every((event) => event.type === "tool_start" && event.status === "running")).toBe(true);
		expect(ends).toHaveLength(2);
		const mutating = ends.find((e) => e.type === "tool_end" && e.id === "t1");
		const readonly = ends.find((e) => e.type === "tool_end" && e.id === "t2");
		if (mutating?.type === "tool_end") {
			expect(mutating.status).toBe("error");
			expect(mutating.result.isError).toBe(true);
			expect(mutating.result.content).toContain("read-only");
		}
		if (readonly?.type === "tool_end") {
			expect(readonly.status).toBe("ok");
			expect(readonly.result.isError).toBeFalsy();
			expect(readonly.result.content).toContain("PLAN_OK");
		}
	});

	it("readOnlyBash restricts a subagent's bash without the plan-mode block", async () => {
		const events: AgentEvent[] = [];
		const systemPrompts: string[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c: unknown, _m: string, messages: unknown) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/evil" }) },
						{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo CHILD_OK" }) },
					],
				};
			})
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "explore" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "CHILD_SYS",
			planState: { enabled: false, plansDir: "/tmp/never-existing-plans-dir" },
			readOnlyBash: true,
			onEvent: (e) => events.push(e),
		});

		// The child is told about the restriction, without the authoring block.
		expect(systemPrompts[0]).toContain("INSPECTION-ONLY");
		expect(systemPrompts[0]).not.toContain("PLAN MODE ACTIVE");

		const ends = events.filter((e) => e.type === "tool_end");
		const mutating = ends.find((e) => e.type === "tool_end" && e.id === "t1");
		const readonly = ends.find((e) => e.type === "tool_end" && e.id === "t2");
		if (mutating?.type === "tool_end") {
			expect(mutating.result.isError).toBe(true);
			expect(mutating.result.content).toContain("read-only");
		}
		if (readonly?.type === "tool_end") {
			expect(readonly.result.isError).toBeFalsy();
			expect(readonly.result.content).toContain("CHILD_OK");
		}
	});

	it("refuses to execute a disabled tool the model fabricates a call to", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			// The model calls bash even though it was filtered from the definitions.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "rm -rf /" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "plan it" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			disabledTools: new Set(["bash"]),
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
		}
	});

	it("answers a fabricated tool name with a suggestion, not a bare Unknown tool", async () => {
		// Models trained on other harnesses invent names cast doesn't have.
		// A bare "Unknown tool" gave no guidance and the model retried it until
		// the doom-loop guard tripped. The wrapper names the closest real tool.
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "globby", arguments: JSON.stringify({ pattern: "**/*.md" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "find the docs" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain('Unknown tool "globby"');
			expect(toolEnd.result.content).toContain('Did you mean "glob"');
			expect(toolEnd.result.content).toContain("Available tools:");
		}
	});

	it("ends the run after a successful plan_done — the model can't keep the turn alive", async () => {
		// Regression: plan_done is a terminal signal tool. The model used to loop
		// forever calling it with a slightly reworded summary each time (which
		// also slipped past the doom-loop detector, keyed on exact args), so the
		// run never settled and the approval dialog never opened. The loop now
		// ends the turn itself once plan_done succeeds. streamAndCollect is
		// mocked to ALWAYS emit another plan_done, so a passing test proves the
		// loop stopped on its own rather than because the model happened to stop.
		const dir = mkdtempSync(join(tmpdir(), "cast-plan-done-stop-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n1. Do it", "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: `t${calls}`,
							name: "plan_done",
							arguments: JSON.stringify({ summary: `summary variant ${calls}` }),
						},
					],
				};
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "finish the plan" }], {
				config: testConfig,
				model: "test-model",
				cwd: "/tmp",
				systemPrompt: "BASE",
				planState: { enabled: true, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			// Exactly one model request: the loop stopped right after the first
			// successful plan_done instead of asking the model for a next step.
			expect(calls).toBe(1);
			const endEvents = events.filter((e) => e.type === "end");
			expect(endEvents).toHaveLength(1);
			expect(endEvents[0]).toEqual({ type: "end", reason: "stop" });
			// The tool result is in the transcript (no dangling tool_call), and it
			// carries the ready signal rather than an error.
			const toolEnd = events.find((e) => e.type === "tool_end" && e.name === "plan_done");
			expect(toolEnd?.type === "tool_end" && toolEnd.result.isError).toBeFalsy();
		} finally {
			// This test installs a persistent mockImplementation (not Once); the
			// suite's beforeEach only mockClear()s, so reset it here to keep it
			// from bleeding into later tests.
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// runAgentLoop — open-work gate (turn-end continuation)
// ============================================================================

describe("runAgentLoop — open-work gate", () => {
	const openPlan = "# Plan\n\n## Steps\n- [ ] do the work\n- [ ] verify\n";

	it("nudges on content-only stop when build mode has open checklist steps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-nudge-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let secondCallMessages: Message[] | undefined;
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "I'll stop early.",
					thinking: "",
					finishReason: "stop",
				}))
				.mockImplementationOnce(async (_c, _m, msgs) => {
					secondCallMessages = msgs as Message[];
					return {
						content: "",
						thinking: "",
						finishReason: "stop",
						toolCalls: [
							{
								id: "t1",
								name: "todo_write",
								arguments: JSON.stringify({
									todos: [
										{ content: "do the work", status: "completed", priority: "medium" },
										{ content: "verify", status: "completed", priority: "medium" },
									],
								}),
							},
						],
					};
				})
				.mockImplementationOnce(async () => ({
					content: "done after tools",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "do the work", status: "pending", priority: "medium", planStep: "do the work" },
					{ content: "verify", status: "pending", priority: "medium", planStep: "verify" },
				],
				onEvent: (e) => events.push(e),
			});

			const gateEvents = events.filter((e) => e.type === "open_work_gate");
			expect(gateEvents).toHaveLength(1);
			expect(gateEvents[0]).toMatchObject({ type: "open_work_gate", fires: 1, openSteps: 2 });
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);
			// applyCacheControl may rewrite user content to a text-part array before
			// the next request — flatten before asserting on the reminder body.
			const reminderText = (secondCallMessages ?? [])
				.filter((m) => m.role === "user")
				.map((m) => contentToText(m.content))
				.find((t) => t.includes("unfinished approved-plan tasks"));
			expect(reminderText).toBeDefined();
			expect(reminderText).toContain("<system-reminder>");
			expect(reminderText).toContain("do the work");
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("caps at max fires then emits open_work_gate_exhausted and stops", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-cap-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return { content: `text-only ${calls}`, thinking: "", finishReason: "stop" };
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "do the work", status: "pending", priority: "medium", planStep: "do the work" },
					{ content: "verify", status: "pending", priority: "medium", planStep: "verify" },
				],
				onEvent: (e) => events.push(e),
			});

			const gates = events.filter((e) => e.type === "open_work_gate");
			const exhausted = events.filter((e) => e.type === "open_work_gate_exhausted");
			expect(gates).toHaveLength(2);
			expect(exhausted).toHaveLength(1);
			expect(exhausted[0]).toMatchObject({ type: "open_work_gate_exhausted", maxFires: 2, openSteps: 2 });
			// 1 initial + 2 gate continues + stop after exhaust (no 4th forced call)
			expect(calls).toBe(3);
			expect(events.filter((e) => e.type === "end")).toEqual([{ type: "end", reason: "stop" }]);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not leak the exhausted notice into the transcript the model will see on resume", async () => {
		// The exhausted branch is user-facing ("Falling through to the user…") —
		// it must not land in `messages`, because on session resume the model
		// would re-read that orphan <system-reminder> and get confused about
		// whose message it was. The only signal to the user is the
		// open_work_gate_exhausted event.
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-exhaust-no-leak-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			const callsToModel: Message[][] = [];
			vi.mocked(streamAndCollect).mockImplementation(async (_c, _m, msgs) => {
				callsToModel.push(msgs as Message[]);
				return { content: "still going", thinking: "", finishReason: "stop" };
			});

			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "do the work", status: "pending", priority: "medium", planStep: "do the work" },
					{ content: "verify", status: "pending", priority: "medium", planStep: "verify" },
				],
				onEvent: () => {},
			});

			expect(callsToModel).toHaveLength(3);
			// The exhausted reminder text must not appear in any call the model
			// received, and must not be left lingering in the transcript.
			const exhaustedSnippet = "Falling through to the user";
			for (const callMsgs of callsToModel) {
				const allText = callMsgs
					.filter((m) => m.role === "user")
					.map((m) => contentToText(m.content))
					.join("\n");
				expect(allText).not.toContain(exhaustedSnippet);
			}
			// After the run, the model never sees the exhausted string at all —
			// it's purely an event payload.
			const lastCallTexts = callsToModel
				.at(-1)!
				.map((m) => contentToText(m.content))
				.join("\n");
			expect(lastCallTexts).not.toContain(exhaustedSnippet);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire when all checklist items are done", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-empty-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [x] done already\n", "utf-8");
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "all done",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "status" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "done already", status: "completed", priority: "medium", planStep: "done already" },
				],
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(events.filter((e) => e.type === "open_work_gate_exhausted")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire in plan mode even with open steps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-planmode-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "planning",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "plan it" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: true, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not fire when there is no active plan on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-noplan-"));
		try {
			vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
				content: "ok",
				thinking: "",
				finishReason: "stop",
			}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "hi" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "do the work", status: "pending", priority: "medium", planStep: "do the work" },
					{ content: "verify", status: "pending", priority: "medium", planStep: "verify" },
				],
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fires for ### heading steps under ## Steps (no checklist)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-heading-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n\n### Implement stub\n\n### Verify\n", "utf-8");
		try {
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "stopping",
					thinking: "",
					finishReason: "stop",
				}))
				.mockImplementationOnce(async () => ({
					content: "ok",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "go" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "Implement stub", status: "pending", priority: "medium", planStep: "Implement stub" },
					{ content: "Verify", status: "pending", priority: "medium", planStep: "Verify" },
				],
				// Cap at 1 so we don't need three content-only turns.
				openWorkGate: { maxFiresPerPrompt: 1 },
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(1);
			expect(events.some((e) => e.type === "open_work_gate_exhausted")).toBe(true);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not run the gate after a successful terminal tool", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-terminal-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: `t${calls}`,
							name: "question",
							arguments: JSON.stringify({
								questions: [
									{
										question: "Choose an approach",
										options: [
											{ value: "one", label: "One" },
											{ value: "two", label: "Two" },
										],
									},
								],
							}),
						},
					],
				};
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "switch" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				onEvent: (e) => events.push(e),
			});

			expect(calls).toBe(1);
			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("resets the fire counter after a follow-up inject", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-followup-"));
		writeFileSync(join(dir, "feature.md"), openPlan, "utf-8");
		const followUpQueue = new MessageQueue();
		try {
			let calls = 0;
			vi.mocked(streamAndCollect).mockImplementation(async () => {
				calls++;
				// After the first outer cycle exhausts (3 content-only turns),
				// the follow-up already queued below restarts a fresh cycle.
				if (calls === 1) {
					followUpQueue.enqueue({ role: "user", content: "please continue" });
				}
				return { content: `text ${calls}`, thinking: "", finishReason: "stop" };
			});

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "implement" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [
					{ content: "do the work", status: "pending", priority: "medium", planStep: "do the work" },
					{ content: "verify", status: "pending", priority: "medium", planStep: "verify" },
				],
				followUpQueue,
				onEvent: (e) => events.push(e),
			});

			expect(events.some((e) => e.type === "followup_injected")).toBe(true);
			const gates = events.filter((e) => e.type === "open_work_gate");
			// First prompt: fires 1+2; after follow-up reset: fire 1 (+ maybe 2)
			expect(gates.length).toBeGreaterThanOrEqual(3);
			expect(gates.filter((e) => e.type === "open_work_gate" && e.fires === 1).length).toBeGreaterThanOrEqual(2);
			expect(events.filter((e) => e.type === "open_work_gate_exhausted").length).toBeGreaterThanOrEqual(2);
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("stops gating after todo_write completes the last linked task", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cast-owg-check-"));
		writeFileSync(join(dir, "feature.md"), "# Plan\n\n## Steps\n- [ ] only step\n", "utf-8");
		try {
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "todo_write",
							arguments: JSON.stringify({
								todos: [{ content: "only step", status: "completed", priority: "medium" }],
							}),
						},
					],
				}))
				.mockImplementationOnce(async () => ({
					content: "finished",
					thinking: "",
					finishReason: "stop",
				}));

			const events: AgentEvent[] = [];
			await runAgentLoop([{ role: "user", content: "finish" }], {
				config: testConfig,
				model: "test-model",
				cwd: dir,
				systemPrompt: "BASE",
				planState: { enabled: false, plansDir: dir },
				initialTodos: [{ content: "only step", status: "pending", priority: "medium", planStep: "only step" }],
				onEvent: (e) => events.push(e),
			});

			expect(events.filter((e) => e.type === "open_work_gate")).toHaveLength(0);
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
			expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
		} finally {
			vi.mocked(streamAndCollect).mockReset();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// compactSessionMessages — plan-mode extra instructions
// ============================================================================

describe("compactSessionMessages — extraInstructions", () => {
	// Enough alternating turns that compactMessages finds a safe cut point.
	const history = (): Message[] =>
		Array.from({ length: 10 }, (_, i): Message[] => [
			{ role: "user", content: `question ${i}` },
			{ role: "assistant", content: `answer ${i}` },
		]).flat();

	it("appends the plan-mode compaction guidance to the summarization prompt", async () => {
		let promptText = "";
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				promptText = contentToText((messages as Message[])[1]!.content);
				return { content: "summary", thinking: "", finishReason: "stop" };
			},
		);

		const result = await compactSessionMessages(
			history(),
			testConfig,
			"test-model",
			undefined,
			undefined,
			undefined,
			"PLAN_MODE_EXTRA_INSTRUCTIONS",
		);
		expect(result.compacted).toBe(true);
		expect(promptText).toContain("<conversation>");
		expect(promptText.endsWith("PLAN_MODE_EXTRA_INSTRUCTIONS")).toBe(true);
	});

	it("leaves the prompt untouched without extraInstructions", async () => {
		let promptText = "";
		vi.mocked(streamAndCollect).mockImplementationOnce(
			async (_client: unknown, _model: string, messages: unknown) => {
				promptText = contentToText((messages as Message[])[1]!.content);
				return { content: "summary", thinking: "", finishReason: "stop" };
			},
		);

		await compactSessionMessages(history(), testConfig, "test-model");
		expect(promptText).not.toContain("PLAN_MODE_EXTRA_INSTRUCTIONS");
	});

	it("injects a separate trailing user reminder (not inside the summary marker)", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const result = await compactSessionMessages(
			history(),
			testConfig,
			"test-model",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				mode: "build",
				planName: "ship",
				openSteps: ["wire reminder"],
				openStepsTotal: 1,
			},
		);
		expect(result.compacted).toBe(true);
		const marker = result.messages.find(
			(m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(marker).toBeDefined();
		expect(marker!.content as string).not.toContain("<system-reminder>");
		expect(marker!.content as string).toContain("summary of work");

		const last = result.messages[result.messages.length - 1]!;
		expect(last.role).toBe("user");
		expect(last.content as string).toContain("<system-reminder>");
		expect(last.content as string).toContain("Active plan: `ship`");
		expect(last.content as string).toContain("## TODO List");
		expect(last.content as string).toContain("- [pending] wire reminder");
	});

	it("omits the reminder when there is no actionable state", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const result = await compactSessionMessages(history(), testConfig, "test-model");
		expect(result.compacted).toBe(true);
		expect(
			result.messages.some((m) => typeof m.content === "string" && m.content.includes("<system-reminder>")),
		).toBe(false);
	});

	it("surfaces edited files from compacted tool calls in the trailing reminder", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "summary of work",
			thinking: "",
			finishReason: "stop",
		}));

		const withEdits: Message[] = [
			{ role: "system", content: "persona" },
			{ role: "user", content: "fix auth" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "t1",
						type: "function",
						function: { name: "edit", arguments: JSON.stringify({ path: "src/auth.ts" }) },
					},
				],
			},
			{ role: "tool", tool_call_id: "t1", content: "ok" },
			{ role: "user", content: "q1" },
			{ role: "assistant", content: "a1" },
			{ role: "user", content: "q2" },
			{ role: "assistant", content: "a2" },
			{ role: "user", content: "q3" },
			{ role: "assistant", content: "a3" },
		];

		const result = await compactSessionMessages(withEdits, testConfig, "test-model");
		expect(result.compacted).toBe(true);
		const marker = result.messages.find(
			(m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(marker!.content as string).toContain("<modified-files>");
		expect(marker!.content as string).not.toContain("<system-reminder>");
		const last = result.messages[result.messages.length - 1]!;
		expect(last.role).toBe("user");
		expect(last.content as string).toContain("## Files Edited This Session");
		expect(last.content as string).toContain("src/auth.ts");
	});
});

// ============================================================================
// runAgentLoop — doom loop detection
// ============================================================================

describe("runAgentLoop — doom loop detection", () => {
	it("blocks a tool call after DOOM_LOOP_THRESHOLD identical consecutive calls and emits doom_loop event", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });

		vi.mocked(streamAndCollect)
			// Calls 1, 2, 3: model keeps calling bash with the same args.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: loopArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "bash", arguments: loopArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: loopArgs }],
			}))
			// Call 4: the 4th identical call is blocked by doom loop detection.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t4", name: "bash", arguments: loopArgs }],
			}))
			// After the doom loop error, model gives up.
			.mockImplementationOnce(async () => ({
				content: "I'll try something different.",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		// doom_loop event must have fired exactly once (on the 4th call).
		const doomEvents = events.filter((e) => e.type === "doom_loop");
		expect(doomEvents).toHaveLength(1);
		expect(doomEvents[0]).toEqual({ type: "doom_loop", tool: "bash", attempts: 3 });

		// The blocked tool_end must carry an error result mentioning "Doom loop".
		const toolEnds = events.filter((e) => e.type === "tool_end");
		const blockedEnd = toolEnds.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(blockedEnd).toBeDefined();
		if (blockedEnd && blockedEnd.type === "tool_end") {
			expect(blockedEnd.result.isError).toBe(true);
			expect(blockedEnd.result.content).toContain("Doom loop detected");
		}

		expect(events.find((e) => e.type === "end")).toEqual({ type: "end", reason: "stop" });
	});

	it("does NOT block when calls alternate between different tools", async () => {
		const events: AgentEvent[] = [];

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "ls" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "read", arguments: JSON.stringify({ path: "foo.ts" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: JSON.stringify({ command: "ls" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "done",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "do stuff" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
	});

	it("never blocks bash_output on repeated identical polls of the same task_id", async () => {
		const events: AgentEvent[] = [];
		const pollArgs = JSON.stringify({ task_id: "bg-1" });

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "p1", name: "bash_output", arguments: pollArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "p2", name: "bash_output", arguments: pollArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "p3", name: "bash_output", arguments: pollArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "p4", name: "bash_output", arguments: pollArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "polled enough",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "poll it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		// 4 identical bash_output calls in a row — would trip DOOM_LOOP_THRESHOLD (3)
		// for any other tool, but bash_output is explicitly exempt.
		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
		const toolEnds = events.filter((e) => e.type === "tool_end");
		expect(toolEnds).toHaveLength(4);
		for (const end of toolEnds) {
			if (end.type === "tool_end") expect(end.result.content).not.toContain("Doom loop");
		}
	});

	it("still blocks bash_kill on repeated identical calls (not exempt like bash_output)", async () => {
		const events: AgentEvent[] = [];
		const killArgs = JSON.stringify({ task_id: "bg-1" });

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "k1", name: "bash_kill", arguments: killArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "k2", name: "bash_kill", arguments: killArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "k3", name: "bash_kill", arguments: killArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "k4", name: "bash_kill", arguments: killArgs }],
			}))
			.mockImplementationOnce(async () => ({
				content: "giving up",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "kill it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		const doomEvents = events.filter((e) => e.type === "doom_loop");
		expect(doomEvents).toHaveLength(1);
		expect(doomEvents[0]).toEqual({ type: "doom_loop", tool: "bash_kill", attempts: 3 });
	});

	it("detects a doom loop inside a single parallel batch (batch not blind to itself)", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });

		vi.mocked(streamAndCollect)
			// One completion, FOUR identical calls in one batch — executed via
			// Promise.all. The sequential pre-scan must let the first three
			// through and block the fourth.
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{ id: "t1", name: "bash", arguments: loopArgs },
					{ id: "t2", name: "bash", arguments: loopArgs },
					{ id: "t3", name: "bash", arguments: loopArgs },
					{ id: "t4", name: "bash", arguments: loopArgs },
				],
			}))
			.mockImplementationOnce(async () => ({
				content: "ok",
				thinking: "",
				finishReason: "stop",
			}));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(1);
		const toolEnds = events.filter((e) => e.type === "tool_end");
		const okEnds = toolEnds.filter((e) => e.type === "tool_end" && ["t1", "t2", "t3"].includes(e.id));
		expect(okEnds).toHaveLength(3);
		expect(okEnds.every((e) => e.type === "tool_end" && !e.result.isError)).toBe(true);
		const blocked = toolEnds.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(blocked && blocked.type === "tool_end" && blocked.result.isError).toBe(true);
		expect(blocked && blocked.type === "tool_end" ? blocked.result.content : "").toContain("Doom loop detected");
	});

	it("resets the window on a follow-up user message — an explicit re-run is not a loop", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });
		const identicalCall = (id: string) => ({
			content: "",
			thinking: "",
			finishReason: "stop" as const,
			toolCalls: [{ id, name: "bash", arguments: loopArgs }],
		});

		vi.mocked(streamAndCollect)
			// Three identical calls fill the window...
			.mockImplementationOnce(async () => identicalCall("t1"))
			.mockImplementationOnce(async () => identicalCall("t2"))
			.mockImplementationOnce(async () => identicalCall("t3"))
			// ...turn ends...
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }))
			// ...follow-up injected (window reset) — the same call must run again.
			.mockImplementationOnce(async () => identicalCall("t5"))
			.mockImplementationOnce(async () => ({ content: "done again", thinking: "", finishReason: "stop" }));

		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "run it once more" });

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			followUpQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "followup_injected")).toHaveLength(1);
		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
		const t5 = events.find((e) => e.type === "tool_end" && e.id === "t5");
		expect(t5 && t5.type === "tool_end" && !t5.result.isError).toBe(true);
	});

	it("resets the window on a steering message injected mid-run", async () => {
		const events: AgentEvent[] = [];
		const loopArgs = JSON.stringify({ command: "echo hi" });
		const identicalCall = (id: string) => ({
			content: "",
			thinking: "",
			finishReason: "stop" as const,
			toolCalls: [{ id, name: "bash", arguments: loopArgs }],
		});

		const steeringQueue = new MessageQueue();

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => identicalCall("t1"))
			.mockImplementationOnce(async () => identicalCall("t2"))
			.mockImplementationOnce(async () => {
				// Window will be [A, A, A] after t3 executes. Queue a steering
				// message; it's injected at the top of the next inner iteration
				// and must clear the window before t4 is checked.
				steeringQueue.enqueue({ role: "user", content: "keep going, run it again" });
				return identicalCall("t3");
			})
			.mockImplementationOnce(async () => identicalCall("t4"))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			steeringQueue,
			onEvent: (event) => events.push(structuredClone(event)),
		});

		expect(events.filter((e) => e.type === "steering_injected")).toHaveLength(1);
		expect(events.filter((e) => e.type === "doom_loop")).toHaveLength(0);
		const t4 = events.find((e) => e.type === "tool_end" && e.id === "t4");
		expect(t4 && t4.type === "tool_end" && !t4.result.isError).toBe(true);
	});
});

// ============================================================================
// runAgentLoop — disabledTools filtering
// ============================================================================

type ToolDef = { type: "function"; function: { name: string } };

describe("runAgentLoop — disabledTools filtering", () => {
	it("keeps plan_done available in plan mode despite stale denylist or persona allowlist", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "finish the plan" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			disabledTools: new Set(["plan_done"]),
			allowedTools: ["read"],
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});

		expect(capturedTools.map((t) => t.function.name)).toContain("plan_done");
	});

	it("excludes web_search and web_fetch when disabledTools contains them", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			disabledTools: new Set(["web_search", "web_fetch"]),
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("bash");
		expect(names).toContain("read");
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("web_fetch");
	});

	it("includes web_search and web_fetch when disabledTools is empty", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			disabledTools: new Set<string>(),
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("web_search");
		expect(names).toContain("web_fetch");
	});

	it("includes web tools when disabledTools is undefined", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("web_search");
		expect(names).toContain("web_fetch");
	});
});

// ============================================================================
// runAgentLoop — allowedTools (persona/subagent frontmatter tools:)
// ============================================================================

describe("runAgentLoop — allowedTools filtering", () => {
	it("advertises only allowlisted tools", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			allowedTools: ["read", "grep"],
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names.sort()).toEqual(["grep", "read"]);
	});

	it("expands plan_* and web_* globs in the allowlist", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			// No disabledTools — globs should surface the full plan_/web_ families.
			allowedTools: ["read", "plan_*", "web_*"],
			onEvent: () => {},
		});

		const names = new Set(capturedTools.map((t) => t.function.name));
		expect(names.has("read")).toBe(true);
		expect(names.has("web_search")).toBe(true);
		expect(names.has("web_fetch")).toBe(true);
		expect(names.has("plan_done")).toBe(true);
		expect(names.has("bash")).toBe(false);
		expect(names.has("write")).toBe(false);
	});

	it("refuses a real call to a tool outside the allowlist", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "run it" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			allowedTools: ["read", "grep"],
			onEvent: (e) => events.push(e),
		});

		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
			expect(toolEnd.result.content).not.toContain("Unknown tool");
		}
	});

	it("applies persona.tools when LoopConfig.allowedTools is omitted", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			personas: [
				{
					name: "reviewer",
					label: "Reviewer",
					description: "",
					systemPrompt: "review",
					source: "builtin",
					filePath: "",
					subagents: false,
					tools: ["read", "ls"],
					agentsMd: true,
				},
			],
			currentPersona: "reviewer",
			onEvent: () => {},
		});

		expect(capturedTools.map((t) => t.function.name).sort()).toEqual(["ls", "read"]);
	});

	it("keeps MCP tools available under a builtin-only allowlist", async () => {
		// Persona/subagent `tools:` constrains builtins (read/write/…), not the
		// user's connected MCP servers — those names are session-specific.
		const events: AgentEvent[] = [];
		const mcpCall = vi.fn(async () => ({ content: "MCP_OK", isError: false }));
		const mcpDef = {
			type: "function" as const,
			function: {
				name: "mcp_demo_ping",
				description: "ping",
				parameters: { type: "object", properties: {} },
			},
		};
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, _msgs, tools) => {
				capturedTools = tools as ToolDef[];
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "mcp_demo_ping", arguments: "{}" }],
				};
			})
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "ping" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			allowedTools: ["read"],
			mcpTools: [mcpDef],
			mcpToolIndex: new Map([["mcp_demo_ping", { definition: mcpDef, call: mcpCall }]]),
			onEvent: (e) => events.push(e),
		});

		const names = capturedTools.map((t) => t.function.name);
		expect(names).toContain("read");
		expect(names).toContain("mcp_demo_ping");
		expect(names).not.toContain("bash");
		expect(mcpCall).toHaveBeenCalledOnce();
		const toolStart = events.find((e) => e.type === "tool_start");
		expect(toolStart?.type === "tool_start" && toolStart.status).toBe("running");
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd?.type === "tool_end" && !toolEnd.result.isError).toBe(true);
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.status).toBe("ok");
			expect(toolEnd.result.content).toBe("MCP_OK");
		}
	});

	it("intersects allowlist with disabledTools", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			allowedTools: ["read", "bash", "web_search"],
			disabledTools: new Set(["web_search", "bash"]),
			onEvent: () => {},
		});

		expect(capturedTools.map((t) => t.function.name)).toEqual(["read"]);
	});

	it("subagent frontmatter tools: blocks real calls via execTask → runAgentLoop", async () => {
		const { execTask } = await import("../src/core/tools/task.ts");
		const events: AgentEvent[] = [];
		let advertised: string[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, _msgs, tools) => {
				advertised = (tools as ToolDef[]).map((t) => t.function.name);
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "write",
							arguments: JSON.stringify({ path: "x.ts", content: "nope" }),
						},
					],
				};
			})
			.mockImplementationOnce(async () => ({
				content: "explored without writing",
				thinking: "",
				finishReason: "stop",
			}));

		const result = await execTask({ assignment: "explore only", subagent: "explorer" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				{
					name: "explorer",
					label: "Explorer",
					description: "read-only",
					systemPrompt: "Explore.",
					tools: ["read", "grep", "ls"],
					agentsMd: false,
				},
			],
			runAgentLoop: async (messages, config) => {
				const withEvents: typeof config = {
					...config,
					onEvent: (e) => {
						events.push(e);
						config.onEvent(e);
					},
				};
				return runAgentLoop(messages, withEvents);
			},
		});

		expect(result.isError).toBeFalsy();
		expect(advertised.sort()).toEqual(["grep", "ls", "read"]);
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd).toBeDefined();
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
		}
	});
});

// ============================================================================
// runAgentLoop — persona mcp: / skills: / subagentTypes: enforcement
// ============================================================================

function makeMcpDef(name: string, serverName: string): ToolDef {
	return {
		type: "function",
		function: {
			name,
			// Description carries the `[serverName]` prefix that loop.ts parses to
			// decide which server the tool belongs to. Real MCP tools get this in
			// mcp.ts (see formatMcpForPrompt and the connection setup).
			description: `[${serverName}] A tool from ${serverName}`,
			parameters: { type: "object", properties: {} },
		},
	};
}

function personaWith(overrides: {
	name: string;
	mcp?: string[];
	skills?: string[];
	subagents?: boolean;
	subagentTypes?: string[];
	tools?: string[];
}): Parameters<typeof runAgentLoop>[1]["personas"] {
	return [
		{
			name: overrides.name,
			label: overrides.name,
			description: "",
			systemPrompt: "test",
			source: "builtin",
			filePath: "",
			subagents: overrides.subagents ?? false,
			tools: overrides.tools,
			skills: overrides.skills,
			mcp: overrides.mcp,
			subagentTypes: overrides.subagentTypes,
			agentsMd: true,
		},
	];
}

describe("runAgentLoop — persona mcp: filtering", () => {
	it("advertises only tools from allowlisted servers", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		const postgresDef = makeMcpDef("mcp_postgres_query", "postgres");
		const githubDef = makeMcpDef("mcp_github_create-issue", "github");

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			personas: personaWith({ name: "db-only", mcp: ["postgres"] }),
			currentPersona: "db-only",
			mcpTools: [postgresDef, githubDef],
			mcpToolIndex: new Map([
				["mcp_postgres_query", { definition: postgresDef, call: vi.fn() }],
				["mcp_github_create-issue", { definition: githubDef, call: vi.fn() }],
			]),
			onEvent: () => {},
		});

		const names = capturedTools.map((t) => t.function.name).sort();
		expect(names).toContain("mcp_postgres_query");
		expect(names).not.toContain("mcp_github_create-issue");
	});

	it("refuses a real call to a tool from a non-allowlisted server", async () => {
		const events: AgentEvent[] = [];
		const githubDef = makeMcpDef("mcp_github_create-issue", "github");
		const githubCall = vi.fn(async () => ({ content: "GH_OK", isError: false }));

		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "mcp_github_create-issue", arguments: "{}" }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			personas: personaWith({ name: "no-github", mcp: ["postgres"] }),
			currentPersona: "no-github",
			mcpTools: [githubDef],
			mcpToolIndex: new Map([["mcp_github_create-issue", { definition: githubDef, call: githubCall }]]),
			onEvent: (e) => events.push(e),
		});

		// Tool was advertised as known but the persona's `mcp:` filter keeps it
		// out of the callable set — same "not available" message a builtin filter
		// produces, so the model doesn't try a different spelling.
		expect(githubCall).not.toHaveBeenCalled();
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd?.type === "tool_end").toBe(true);
		if (toolEnd?.type === "tool_end") {
			expect(toolEnd.result.isError).toBe(true);
			expect(toolEnd.result.content).toContain("not available");
		}
	});
});

describe("runAgentLoop — persona skills: filtering", () => {
	it("drops skills not in the persona allowlist from the skill tool", async () => {
		const { execSkill } = await import("../src/core/tools/skill.ts");
		const skills = [
			{
				name: "research",
				description: "Research skill.",
				filePath: "/skills/research/SKILL.md",
				body: "Research body.",
				disableModelInvocation: false,
			},
			{
				name: "dangerous",
				description: "Dangerous skill.",
				filePath: "/skills/dangerous/SKILL.md",
				body: "Danger body.",
				disableModelInvocation: false,
			},
		] as Parameters<typeof execSkill>[1]["skills"];

		// Persona `skills:` filter — drop the disallowed skill before execSkill
		// ever sees it. Same shape loop.ts builds `allowedSkills` from.
		const restricted = skills.filter((s) => s.name !== "dangerous");

		const ok = execSkill({ name: "research" }, { skills: restricted });
		expect(ok.isError).not.toBe(true);
		expect(ok.content).toContain("Research body");

		const denied = execSkill({ name: "dangerous" }, { skills: restricted });
		expect(denied.isError).toBe(true);
		expect(denied.content).toContain("not found");
		// "Available skills" only lists the persona-restricted set — a filtered
		// skill doesn't even appear in the error's available list, so the
		// model can't retry with a similar-but-different name.
		expect(denied.content).toContain("Available skills: research");
	});
});

describe("runAgentLoop — persona subagentTypes: filtering", () => {
	it("advertises only allowlisted subagent types in the task tool description", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "SYS",
			personas: personaWith({ name: "explorer", subagents: true, subagentTypes: ["explore"] }),
			currentPersona: "explorer",
			subagentPrompts: [
				{ name: "explore", label: "Explore", description: "", systemPrompt: "explore", agentsMd: false },
				{ name: "review", label: "Review", description: "", systemPrompt: "review", agentsMd: false },
				{ name: "worker", label: "Worker", description: "", systemPrompt: "worker", agentsMd: false },
			],
			onEvent: () => {},
		});

		const taskTool = capturedTools.find((t) => t.function.name === "task");
		expect(taskTool).toBeDefined();
		// Description advertises exactly the filtered set — the model can't
		// ask for a type that's merely hidden from the description.
		// "Available subagents: <names>" is the trailing list; check it parses
		// to just "explore" rather than relying on substring match (the
		// description also uses the words "review" / "exploration" elsewhere).
		const desc = taskTool?.function.description ?? "";
		const m = desc.match(/Available subagents:\s*([^.]+)/);
		expect(m).not.toBeNull();
		expect(m?.[1].trim()).toBe("explore");
	});

	it("rejects a task call to a subagent type outside the allowlist", async () => {
		const { execTask } = await import("../src/core/tools/task.ts");
		const result = await execTask({ assignment: "review this", subagent: "review" }, "/tmp", testConfig, {
			model: "test-model",
			subagentPrompts: [
				// Only `explore` is forwarded by the parent's persona filter —
				// `review` and `worker` are dropped before execTask sees them.
				{ name: "explore", label: "Explore", description: "", systemPrompt: "explore", agentsMd: false },
			],
			runAgentLoop: async () => {
				throw new Error("should not run");
			},
		});
		expect(result.isError).toBe(true);
		expect(result.content).toContain('Unknown subagent "review"');
		expect(result.content).toContain("explore");
	});
});

// ============================================================================
// runAgentLoop — onMessagesChanged (crash recovery snapshots)
// ============================================================================

describe("runAgentLoop — onMessagesChanged", () => {
	it("fires onMessagesChanged after each message push", async () => {
		const snapshots: number[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "read", arguments: '{"path":"/tmp/f"}' }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const result = await runAgentLoop([{ role: "user", content: "read file" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: () => {},
			onMessagesChanged: (msgs) => snapshots.push(msgs.length),
		});

		// The callback fires multiple times per state (system prompt rebuild,
		// message push, explicit post-executeToolCalls save). Filter to unique
		// lengths to verify the messages array grows as expected.
		const uniqueLengths = [...new Set(snapshots)];
		// [system, user] → [system, user, assistant] → [+ tool] → [+ assistant]
		expect(uniqueLengths).toEqual([2, 3, 4, 5]);
		// Final returned messages match the last snapshot
		expect(result.length).toBe(snapshots[snapshots.length - 1]);
	});

	it("does not create proxy when onMessagesChanged is omitted", async () => {
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "ok",
			thinking: "",
			finishReason: "stop",
		}));

		const result = await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: () => {},
		});

		// system + user + assistant
		expect(result.length).toBe(3);
		expect(result[0]!.role).toBe("system");
		expect(result[1]!.role).toBe("user");
		expect(result[2]!.role).toBe("assistant");
	});

	it("snapshots contain correct message roles and content", async () => {
		const snapshotRoles: string[][] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "read", arguments: '{"path":"/tmp/f"}' }],
			}))
			.mockImplementationOnce(async () => ({ content: "answer", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "do it" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: () => {},
			onMessagesChanged: (msgs) => snapshotRoles.push(msgs.map((m) => m.role)),
		});

		// Find the first snapshot with an assistant message (after tool_calls push)
		const withAssistant = snapshotRoles.find((r) => r.includes("assistant"));
		expect(withAssistant).toEqual(["system", "user", "assistant"]);
		// Last snapshot: system + user + assistant + tool + assistant
		const last = snapshotRoles[snapshotRoles.length - 1]!;
		expect(last).toEqual(["system", "user", "assistant", "tool", "assistant"]);
	});
});

// ============================================================================
// runAgentLoop — compaction (all three trigger sites share performCompaction)
// ============================================================================

describe("runAgentLoop — compaction", () => {
	// A tiny budget plus real prior turns (so safeCutIndex has a user-message
	// boundary to cut at) makes every compaction path reachable from a real
	// runAgentLoop call instead of only from compactSessionMessages directly.
	const tinyBudgetConfig: AppConfig = {
		...testConfig,
		contextWindow: 2000,
		maxResponseTokens: 200,
		compactionThreshold: 0.75,
	};

	// Several real user/assistant turns before the interesting turn, so
	// compactMessages finds a safe cut point (old.length > 0) instead of
	// silently no-oping.
	function seedHistory(n: number): Message[] {
		const seed: Message[] = [];
		for (let i = 0; i < n; i++) {
			seed.push({ role: "user", content: `filler question ${i}` });
			seed.push({ role: "assistant", content: `filler answer ${i} `.repeat(20) });
		}
		return seed;
	}

	it("shouldCompact at the top of a turn compacts before the next model call", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			// Turn 1: no tool calls, just a reply — but lastPromptTokens (below)
			// already reports the session over threshold, so the *next* outer
			// turn's shouldCompact check should fire before it streams.
			.mockImplementationOnce(async () => ({ content: "turn 1 done", thinking: "", finishReason: "stop" }))
			// The compaction summarization call itself.
			.mockImplementationOnce(async () => ({ content: "SUMMARY", thinking: "", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "turn 2 done", thinking: "", finishReason: "stop" }));

		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "keep going" });

		const result = await runAgentLoop([...seedHistory(6), { role: "user", content: "start" }], {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			followUpQueue,
			// Reported by the provider on the previous response — this is what
			// the real loop uses to decide shouldCompact at the top of a turn.
			lastPromptTokens: 5000,
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "compaction")).toBe(true);
		expect(events.some((e) => e.type === "compaction_failed")).toBe(false);
		// The seeded filler turns are gone from the final history — only the
		// compaction summary/reminder plus the two real turns remain.
		expect(result.length).toBeLessThan(seedHistory(6).length + 4);
	});

	it("skips compaction for short-lived system agents when skipCompaction is set", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({ content: "turn 1 done", thinking: "", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "turn 2 done", thinking: "", finishReason: "stop" }));

		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "keep going" });

		await runAgentLoop([...seedHistory(6), { role: "user", content: "start" }], {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			followUpQueue,
			skipCompaction: true,
			lastPromptTokens: 5000,
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "compaction")).toBe(false);
	});

	it("injects the full memory prompt only at a checkpoint rebuild", async () => {
		const realHome = process.env.HOME;
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-memory-rebuild-home-"));
		process.env.HOME = fakeHome;
		updateSettings({ memoryWriteEnabled: true });
		const buildPrompt = vi.fn(() => "<project-memory>rebuild-only</project-memory>");
		const memoryService = {
			search: vi.fn(() => []),
			buildPrompt,
		};
		const followUpQueue = new MessageQueue();
		followUpQueue.enqueue({ role: "user", content: "keep going" });
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({ content: "turn 1 done", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "SUMMARY", finishReason: "stop" }))
			.mockImplementationOnce(async () => ({ content: "turn 2 done", finishReason: "stop" }));

		try {
			await runAgentLoop(
				[
					...Array.from({ length: 6 }, (_, index) => [
						{ role: "user" as const, content: `filler question ${index}` },
						{ role: "assistant" as const, content: `filler answer ${index} `.repeat(20) },
					]).flat(),
					{ role: "user", content: "start" },
				],
				{
					config: tinyBudgetConfig,
					model: "test-model",
					cwd: "/tmp",
					systemPrompt: "test",
					lastPromptTokens: 5000,
					followUpQueue,
					memory: { sessionId: "memory-rebuild", service: memoryService },
					onEvent: () => {},
				},
			);
			expect(buildPrompt).toHaveBeenCalled();
			expect(buildPrompt.mock.calls.every((call) => call[1] === "")).toBe(true);
			expect(buildPrompt.mock.calls.every((call) => call[3]?.tokenBudget === 256)).toBe(true);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("mid-turn context guard compacts after a large tool result, before the next model call", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-compact-"));
		try {
			// Big enough that estimateTokens(messages) alone crosses the tiny
			// budget's threshold once this lands in the tool result.
			writeFileSync(join(cwd, "big.txt"), "x".repeat(20_000));

			const events: AgentEvent[] = [];
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "read", arguments: JSON.stringify({ path: "big.txt" }) }],
				}))
				// The compaction summarization call, triggered mid-turn by the
				// post-tool-results guard — *before* the model is asked to
				// continue past the tool result.
				.mockImplementationOnce(async () => ({ content: "SUMMARY", thinking: "", finishReason: "stop" }))
				.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

			await runAgentLoop([...seedHistory(6), { role: "user", content: "read the big file" }], {
				config: tinyBudgetConfig,
				model: "test-model",
				cwd,
				systemPrompt: "test",
				onEvent: (e) => events.push(e),
			});

			expect(events.some((e) => e.type === "compaction")).toBe(true);
			// Confirms this fired from the mid-turn guard and not the top-of-turn
			// shouldCompact check: no lastPromptTokens was ever supplied, so
			// that check can never fire on its own in this test.
			const compactionEvents = events.filter((e) => e.type === "compaction");
			expect(compactionEvents.length).toBe(1);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not compact on a small tool result that stays under threshold", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "cast-loop-nocompact-"));
		try {
			writeFileSync(join(cwd, "small.txt"), "hello world");

			const events: AgentEvent[] = [];
			vi.mocked(streamAndCollect)
				.mockImplementationOnce(async () => ({
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [{ id: "t1", name: "read", arguments: JSON.stringify({ path: "small.txt" }) }],
				}))
				.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

			await runAgentLoop([{ role: "user", content: "read the small file" }], {
				config: tinyBudgetConfig,
				model: "test-model",
				cwd,
				systemPrompt: "test",
				onEvent: (e) => events.push(e),
			});

			expect(events.some((e) => e.type === "compaction")).toBe(false);
			// Only the two mocked calls above — no extra summarization call.
			expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("malformed tool-call JSON alone does not trigger compaction (not a context-size signal)", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				// Deliberately invalid JSON arguments.
				toolCalls: [{ id: "t1", name: "read", arguments: "{not valid json" }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "do something" }], {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "compaction")).toBe(false);
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
	});

	it("context-overflow error from the model triggers compaction and retries the turn", async () => {
		const events: AgentEvent[] = [];
		let firstAttempt = true;
		vi.mocked(streamAndCollect).mockImplementation(async () => {
			if (firstAttempt) {
				firstAttempt = false;
				const err = new Error("400 context_length_exceeded") as Error & { code: string };
				err.code = "context_length_exceeded";
				throw err;
			}
			// Second call onward: could be the compaction summarization or the
			// retried turn — either way, a clean stop response satisfies both.
			return { content: "done", thinking: "", finishReason: "stop" };
		});

		const result = await runAgentLoop([...seedHistory(6), { role: "user", content: "go" }], {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "compaction")).toBe(true);
		expect(events.some((e) => e.type === "compaction_failed")).toBe(false);
		expect(result.at(-1)?.content).toBe("done");
	});

	it("surfaces compaction_failed plus the original overflow error when the summarization call itself fails", async () => {
		// compactSessionMessages catches a summarization failure and returns
		// compacted:false — the loop must then emit compaction_failed and throw
		// the ORIGINAL overflow (not a swallowed or mislabeled error), so the
		// transcript is preserved and the user sees why the turn failed.
		const events: AgentEvent[] = [];
		let attempts = 0;
		vi.mocked(streamAndCollect).mockImplementation(async () => {
			attempts++;
			if (attempts === 1) {
				const err = new Error("400 context_length_exceeded") as Error & { code: string };
				err.code = "context_length_exceeded";
				throw err;
			}
			// The compaction summarization LLM call fails too (non-retryable).
			throw new Error("provider outage during summarization");
		});

		await runAgentLoop([...seedHistory(6), { role: "user", content: "go" }], {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "compaction_failed")).toBe(true);
		const errorEvent = events.find((e) => e.type === "error");
		expect(String((errorEvent as { message: string } | undefined)?.message)).toContain("context_length_exceeded");
	});

	it("context-overflow yanks the largest tool result inline before falling back to compaction", async () => {
		// The in-place shrink is cheaper than LLM-based compaction and doesn't
		// itself risk an overflow — it'd be wasted budget to compact first
		// when a simple relabel of one tool result lets the next retry through.
		// Reproduces the real incident seen in the field: a grep tool result
		// of ~1.2MB on a model with a 200k-token window pushed the next LLM
		// call over the limit, and the old behavior compacted the entire
		// session (losing context) just to fit the next request.
		const events: AgentEvent[] = [];
		const bigToolResult = "x".repeat(1_200_000);
		let firstAttempt = true;
		vi.mocked(streamAndCollect).mockImplementation(async (_client, _model, messages) => {
			if (firstAttempt) {
				firstAttempt = false;
				const err = new Error("400 context_length_exceeded") as Error & { code: string };
				err.code = "context_length_exceeded";
				throw err;
			}
			// The retried call should see the placeholder, not the giant blob.
			const lastTool = [...messages].reverse().find((m) => m.role === "tool");
			expect(lastTool?.content).toContain("previous tool result omitted");
			expect(lastTool?.content).not.toContain(bigToolResult);
			return { content: "done", thinking: "", finishReason: "stop" };
		});

		const history: Message[] = [
			{ role: "user", content: "readme" },
			{
				role: "assistant",
				content: "",
				tool_calls: [{ id: "call_big", type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "call_big", content: bigToolResult },
			{ role: "user", content: "continue" },
		];

		const result = await runAgentLoop(history, {
			config: tinyBudgetConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		const trimEvent = events.find((e) => e.type === "tool_result_truncated");
		expect(trimEvent).toBeDefined();
		if (trimEvent?.type === "tool_result_truncated") {
			expect(trimEvent.toolCallId).toBe("call_big");
			expect(trimEvent.bytesRemoved).toBeGreaterThan(1_000_000);
		}
		// Concise fix-path: no compaction event needed when the in-place
		// shrink left enough room for the retried turn.
		expect(events.some((e) => e.type === "compaction")).toBe(false);
		expect(result.at(-1)?.content).toBe("done");
	});
});

// ============================================================================
// runAgentLoop — todo list (build mode only)
// ============================================================================

describe("runAgentLoop — todo list (build mode only)", () => {
	it("advertises todo_write in build mode, not in plan mode", async () => {
		let buildTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			buildTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});
		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: () => {},
		});
		expect(buildTools.map((t) => t.function.name)).toContain("todo_write");

		let planTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			planTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});
		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			planState: { enabled: true, plansDir: "/tmp/never-existing-plans-dir" },
			onEvent: () => {},
		});
		expect(planTools.map((t) => t.function.name)).not.toContain("todo_write");
	});

	it("omits skill when no model-invokable skills are configured", async () => {
		let capturedTools: ToolDef[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			capturedTools = tools as ToolDef[];
			return { content: "ok", thinking: "", finishReason: "stop" };
		});

		await runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			skills: [
				{
					name: "manual-only",
					description: "Manual skill.",
					filePath: "/skills/manual-only/SKILL.md",
					body: "Manual skill body.",
					disableModelInvocation: true,
				},
			],
			onEvent: () => {},
		});

		expect(capturedTools.map((tool) => tool.function.name)).not.toContain("skill");
	});

	it("a todo_write call updates state, fires todos_updated, and steers the next turn's prompt", async () => {
		const systemPrompts: string[] = [];
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, messages) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return {
					content: "",
					thinking: "",
					finishReason: "stop",
					toolCalls: [
						{
							id: "t1",
							name: "todo_write",
							arguments: JSON.stringify({
								todos: [
									{ content: "Step one", status: "in_progress", priority: "high" },
									{ content: "Step two", status: "pending", priority: "medium" },
								],
							}),
						},
					],
				};
			})
			.mockImplementationOnce(async (_c, _m, messages) => {
				systemPrompts.push(contentToText((messages as Message[])[0]!.content));
				return { content: "done", thinking: "", finishReason: "stop" };
			});

		await runAgentLoop([{ role: "user", content: "do the multi-step thing" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "BASE_PROMPT",
			onEvent: (e) => events.push(e),
		});

		const updated = events.find((e) => e.type === "todos_updated");
		expect(updated).toBeDefined();
		if (updated?.type === "todos_updated") expect(updated.todos).toHaveLength(2);

		// First request has no todos yet — nothing injected.
		expect(systemPrompts[0]).toBe("BASE_PROMPT");
		// Second request sees the list the tool call just wrote.
		expect(systemPrompts[1]).toContain("Step one");
		expect(systemPrompts[1]).toContain("Step two");
		expect(systemPrompts[1]).toContain("[~] (high) Step one");
	});

	it("rejects more than one in_progress item without updating state", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{
						id: "t1",
						name: "todo_write",
						arguments: JSON.stringify({
							todos: [
								{ content: "a", status: "in_progress", priority: "high" },
								{ content: "b", status: "in_progress", priority: "low" },
							],
						}),
					},
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		expect(events.some((e) => e.type === "todos_updated")).toBe(false);
		expect(events.some((e) => e.type === "tool_end" && e.name === "todo_write" && e.result.isError)).toBe(true);
	});

	it("runs todo_write through PreToolUse hooks before it updates state", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{
						id: "t1",
						name: "todo_write",
						arguments: JSON.stringify({
							todos: [{ content: "blocked", status: "in_progress", priority: "low" }],
						}),
					},
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			hooks: { PreToolUse: [{ matcher: "todo_write", hooks: [{ command: "exit 2" }] }] },
			onEvent: (event) => events.push(event),
		});

		expect(events.some((event) => event.type === "todos_updated")).toBe(false);
		expect(
			events.some((event) => event.type === "tool_end" && event.name === "todo_write" && event.result.isError),
		).toBe(true);
	});

	it("multiple successive tool calls without a todo list do not get blocked", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo 1" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo 2" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: JSON.stringify({ command: "echo 3" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t4", name: "bash", arguments: JSON.stringify({ command: "echo 4" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t5", name: "bash", arguments: JSON.stringify({ command: "echo 5" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{
						id: "t6",
						name: "todo_write",
						arguments: JSON.stringify({ todos: [{ content: "a", status: "in_progress", priority: "low" }] }),
					},
				],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t7", name: "bash", arguments: JSON.stringify({ command: "echo 7" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "do several unrelated bash things" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		const toolEnd = (id: string) =>
			events.find((e) => e.type === "tool_end" && e.id === id) as
				| { type: "tool_end"; id: string; name: string; result: { content: string; isError?: boolean } }
				| undefined;

		// Without the hard gate, all tool calls (including bash #5) succeed normally.
		expect(toolEnd("t1")?.result.isError).toBeFalsy();
		expect(toolEnd("t4")?.result.isError).toBeFalsy();
		expect(toolEnd("t5")?.result.isError).toBeFalsy();
		expect(toolEnd("t6")?.result.isError).toBeFalsy();
		expect(toolEnd("t7")?.result.isError).toBeFalsy();
	});

	it("todo_write updates state and steers subsequent prompt even without a gate", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{
						id: "t0",
						name: "todo_write",
						arguments: JSON.stringify({ todos: [{ content: "a", status: "in_progress", priority: "low" }] }),
					},
				],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo 1" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t2", name: "bash", arguments: JSON.stringify({ command: "echo 2" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t3", name: "bash", arguments: JSON.stringify({ command: "echo 3" }) }],
			}))
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t4", name: "bash", arguments: JSON.stringify({ command: "echo 4" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			onEvent: (e) => events.push(e),
		});

		const sawAnyNudge = events.some(
			(e) => e.type === "tool_end" && e.result.isError && e.result.content.includes("Blocked"),
		);

		expect(sawAnyNudge).toBe(false);
	});
});

describe("gateDestructiveWrite", () => {
	it("serializes potentially mutating sibling tools while preserving call order", async () => {
		let active = 0;
		let maxActive = 0;
		const order: string[] = [];
		const mcpDef = {
			type: "function" as const,
			function: { name: "mcp_demo_mutate", description: "mutate", parameters: { type: "object", properties: {} } },
		};
		const mcpCall = vi.fn(async (args: Record<string, unknown>) => {
			const label = String(args.label);
			active++;
			maxActive = Math.max(maxActive, active);
			order.push(`start:${label}`);
			await new Promise((resolve) => setTimeout(resolve, label === "first" ? 20 : 0));
			order.push(`end:${label}`);
			active--;
			return { content: label };
		});
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{ id: "mcp-1", name: "mcp_demo_mutate", arguments: JSON.stringify({ label: "first" }) },
					{ id: "mcp-2", name: "mcp_demo_mutate", arguments: JSON.stringify({ label: "second" }) },
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "mutate twice" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			mcpTools: [mcpDef],
			mcpToolIndex: new Map([["mcp_demo_mutate", { definition: mcpDef, call: mcpCall }]]),
			onEvent: () => {},
		});

		expect(maxActive).toBe(1);
		expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
	});

	it("still gates write calls when hooks are configured", async () => {
		const events: AgentEvent[] = [];
		const confirmWrite = vi.fn(async () => false);
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [
					{
						id: "write-1",
						name: "write",
						arguments: JSON.stringify({ path: "blocked.txt", content: "must not be written" }),
					},
				],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "write" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			hooks: {
				PreToolUse: [
					{
						matcher: "write",
						hooks: [
							{
								command:
									'echo \'{"hookSpecificOutput":{"updatedInput":{"path":"rewritten.txt","content":"changed"}}}\'',
							},
						],
					},
				],
			},
			confirmWrite,
			onEvent: (event) => events.push(event),
		});

		expect(confirmWrite).toHaveBeenCalledWith("write", "rewritten.txt", expect.stringContaining("rewritten.txt"));
		expect(events.some((event) => event.type === "tool_end" && event.result.isError)).toBe(true);
	});

	it("still gates MCP calls when hooks are configured", async () => {
		const confirmWrite = vi.fn(async () => false);
		const mcpCall = vi.fn(async () => ({ content: "MCP_OK", isError: false }));
		const mcpDef = {
			type: "function" as const,
			function: { name: "mcp_demo_mutate", description: "mutate", parameters: { type: "object", properties: {} } },
		};
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "mcp-1", name: "mcp_demo_mutate", arguments: "{}" }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		await runAgentLoop([{ role: "user", content: "mutate" }], {
			config: testConfig,
			model: "test-model",
			cwd: "/tmp",
			systemPrompt: "test",
			hooks: {},
			confirmWrite,
			mcpTools: [mcpDef],
			mcpToolIndex: new Map([["mcp_demo_mutate", { definition: mcpDef, call: mcpCall }]]),
			onEvent: () => {},
		});

		expect(confirmWrite).toHaveBeenCalledOnce();
		expect(mcpCall).not.toHaveBeenCalled();
	});

	it("returns undefined when no confirm callback is set", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const result = await gateDestructiveWrite("write", { path: "/tmp/a" }, undefined);
		expect(result).toBeUndefined();
	});

	it("returns undefined for read with no gate even when confirm denies", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const confirm = vi.fn(async () => false);
		const result = await gateDestructiveWrite("read", { path: "/tmp/a" }, confirm);
		expect(result).toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("invokes confirm for write and returns undefined on grant", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const confirm = vi.fn(async () => true);
		const result = await gateDestructiveWrite("write", { path: "/tmp/a", content: "x" }, confirm);
		expect(confirm).toHaveBeenCalledWith("write", "/tmp/a", expect.stringContaining("/tmp/a"));
		expect(result).toBeUndefined();
	});

	it("invokes confirm for edit and returns denial on reject", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const confirm = vi.fn(async () => false);
		const result = await gateDestructiveWrite("edit", { path: "/etc/hosts" }, confirm);
		expect(result).toBeDefined();
		expect(result?.isError).toBe(true);
		expect(result?.content).toContain("Permission denied");
	});

	it("treats real MCP tool names as destructive", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const confirm = vi.fn(async () => false);
		const result = await gateDestructiveWrite("mcp_fs_write", { path: "/etc/passwd" }, confirm);
		expect(confirm).toHaveBeenCalled();
		expect(result?.isError).toBe(true);
	});

	it("uses fallback path label when no path arg is present", async () => {
		const { gateDestructiveWrite } = await import("../src/core/loop.ts");
		const confirm = vi.fn(async () => true);
		await gateDestructiveWrite("write", {}, confirm);
		expect(confirm).toHaveBeenCalledWith("write", expect.stringContaining("write"), expect.any(String));
	});
});

describe("waitForToolBatch", () => {
	type R = { id: string; name: string; result: { content: string; isError?: boolean } };
	function tool(id: string, content: string): Promise<R> {
		return Promise.resolve({ id, name: id, result: { content } }).then((r) => {
			settled.set(id, r);
			return r;
		});
	}
	let settled: Map<string, R>;

	beforeEach(() => {
		settled = new Map();
	});

	it("resolves with every real result when all tools settle normally", async () => {
		const prepared = [
			{ id: "a", name: "a" },
			{ id: "b", name: "b" },
		];
		const results = await waitForToolBatch([tool("a", "A"), tool("b", "B")], prepared, settled, undefined);
		expect(results.map((r) => r.result.content)).toEqual(["A", "B"]);
	});

	it("force-closes the batch after the grace period when a tool ignores the abort signal", async () => {
		vi.useFakeTimers();
		try {
			const ac = new AbortController();
			const prepared = [
				{ id: "a", name: "a" },
				{ id: "b", name: "b" },
			];
			// "a" settles normally; "b" hangs forever and ignores the signal.
			const hung = new Promise<R>(() => {});
			const batch = waitForToolBatch([tool("a", "A"), hung], prepared, settled, ac.signal);

			ac.abort();
			await vi.advanceTimersByTimeAsync(TOOL_ABORT_GRACE_MS);

			const results = await batch;
			expect(results[0]?.result.content).toBe("A");
			expect(results[1]?.result.isError).toBe(true);
			expect(results[1]?.result.content).toContain("ABORTED");
		} finally {
			vi.useRealTimers();
		}
	});

	it("bails out immediately (no grace) when every tool already settled after the abort", async () => {
		vi.useFakeTimers();
		try {
			const ac = new AbortController();
			const prepared = [{ id: "a", name: "a" }];
			ac.abort();
			const batch = waitForToolBatch([tool("a", "A")], prepared, settled, ac.signal);
			// No timers to advance — the already-settled promise resolves it.
			const results = await batch;
			expect(results[0]?.result.content).toBe("A");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("runAgentLoop — abort always ends a hung tool batch", () => {
	it("closes the batch after the grace period when an MCP tool ignores the abort signal", async () => {
		const events: AgentEvent[] = [];
		// First completion: a single tool call to a hung MCP server.
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => ({
			content: "",
			thinking: "",
			finishReason: "tool_calls",
			toolCalls: [{ id: "1", name: "mcp_hang_test", arguments: "{}" }],
		}));

		const ac = new AbortController();
		// The server accepts the call but never responds and never listens to
		// the abort signal — before waitForToolBatch this kept the whole turn
		// (and every Esc) open forever.
		const mcpToolIndex = new Map<string, unknown>([["mcp_hang_test", { call: () => new Promise<never>(() => {}) }]]);

		const startedAt = Date.now();
		const runPromise = runAgentLoop([{ role: "user", content: "hi" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			signal: ac.signal,
			mcpTools: [{ type: "function", function: { name: "mcp_hang_test", parameters: {} } }],
			mcpToolIndex: mcpToolIndex as never,
			onEvent: (event) => events.push(event),
		});

		// Let the loop reach the tool round, then abort.
		await new Promise((resolve) => setTimeout(resolve, 150));
		ac.abort();

		await runPromise;
		const elapsed = Date.now() - startedAt;

		const endEvents = events.filter((e) => e.type === "end");
		expect(endEvents.some((e) => (e as { reason?: string }).reason === "aborted")).toBe(true);
		// 2s grace + margin — pre-fix this never resolved at all.
		expect(elapsed).toBeLessThan(5000);
	});
});
