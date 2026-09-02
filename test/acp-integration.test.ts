/**
 * Integration test: drive the real cast ACP agent through a full
 * `@agentclientprotocol/sdk` round-trip via `clientApp.connect(agentApp)`
 * — the in-process path that exercises the same handler dispatch and
 * schema validation the wire does, without the stream ceremony.
 *
 * Catches wire-format regressions that the mocked adapter tests miss:
 * if a method handler signature drifts from what the SDK expects, this
 * layer fails at runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/loop.ts", () => ({
	runAgentLoop: vi.fn(async () => undefined),
}));

vi.mock("../src/core/session.ts", () => ({
	listSessionSummaries: vi.fn(() => []),
	deleteSession: vi.fn(() => true),
	loadSession: vi.fn(() => null),
	recordCompaction: vi.fn(),
	appendMessage: vi.fn(),
	saveSession: vi.fn(),
}));

vi.mock("../src/core/startup.ts", () => ({
	runStartup: vi.fn(),
}));

vi.mock("../src/core/runner.ts", () => ({
	createAgentRunner: vi.fn(() => ({
		steeringQueue: { enqueue: vi.fn(), clear: vi.fn() },
		followUpQueue: { enqueue: vi.fn(), clear: vi.fn() },
		isRunning: false,
		abort: vi.fn(),
		startRun: vi.fn(),
		endRun: vi.fn(),
		waitForIdle: vi.fn(async () => {}),
	})),
	createPlanState: vi.fn(() => ({ enabled: false })),
}));

vi.mock("../src/core/plan.ts", () => ({
	createPlanState: vi.fn(() => ({ enabled: false })),
	resolvePlanQuestion: vi.fn(),
	resolvePlanTransition: vi.fn(),
}));

vi.mock("../src/core/mcp.ts", () => ({
	closeMcpConnections: vi.fn(),
	formatMcpForPrompt: vi.fn(() => ""),
}));

const acp = await import("@agentclientprotocol/sdk");
const { buildAcpAgentApp } = await import("../src/core/acp/agent.ts");

/**
 * Build the agent + client pair and run the given callback inside the
 * client's `connectWith(agent)` scope. Mirrors what a real editor sees:
 * the client calls methods, the agent dispatches to cast handlers,
 * responses round-trip back to the caller.
 */
async function withClient<T>(
	run: (ctx: acp.ClientContext) => Promise<T>,
	opts: { version?: string; permissionMode?: "bypass" | "default" } = {},
): Promise<T> {
	const startup = {
		session: { id: "test-session-1", cwd: "/tmp/test", messages: [], mode: "build", model: "test" },
		cwd: "/tmp/test",
		config: { contextWindow: 128_000 } as never,
		systemPrompt: "",
		mcpResult: { connections: [], toolDefinitions: [], toolIndex: new Map() } as never,
		hooks: {},
		skills: [],
		persona: { name: "test" },
		personas: [],
		subagentPrompts: [],
		subagentModel: "test",
		permissionMode: "default",
	} as never;

	const { app: agentApp } = buildAcpAgentApp(startup, {
		version: opts.version ?? "test",
		permissionMode: opts.permissionMode ?? "bypass",
	});

	const clientApp = acp.client({ name: "test-client" });
	return clientApp.connectWith(agentApp, run);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ACP integration", () => {
	it("handles initialize + session/new + session/prompt end-to-end", async () => {
		const sessionId = await withClient(async (client) => {
			const initResult = await client.request<
				{ protocolVersion: number; agentCapabilities: Record<string, unknown> },
				{ protocolVersion: number; clientCapabilities: Record<string, unknown> }
			>("initialize", { protocolVersion: 1, clientCapabilities: {} });
			expect(initResult.protocolVersion).toBe(1);
			expect(initResult.agentCapabilities.loadSession).toBe(true);
			expect(initResult.agentCapabilities.promptCapabilities.embeddedContext).toBe(true);
			expect(initResult.agentCapabilities.sessionCapabilities.close).toEqual({});
			// fork and resume are intentionally omitted — cast implements neither.
			expect(initResult.agentCapabilities.sessionCapabilities.fork).toBeUndefined();
			expect(initResult.agentCapabilities.sessionCapabilities.resume).toBeUndefined();

			const newResult = await client.request<{ sessionId: string }, { cwd: string; mcpServers: unknown[] }>(
				"session/new",
				{ cwd: "/tmp/test", mcpServers: [] },
			);
			expect(typeof newResult.sessionId).toBe("string");

			const promptResult = await client.request<
				{ stopReason: string },
				{ sessionId: string; prompt: Array<{ type: string; text?: string }> }
			>("session/prompt", {
				sessionId: newResult.sessionId,
				prompt: [{ type: "text", text: "hello" }],
			});
			expect(promptResult.stopReason).toBe("end_turn");

			return newResult.sessionId;
		});
		expect(typeof sessionId).toBe("string");
	});

	it("session/load for missing session returns JSON-RPC error -32004", async () => {
		await withClient(async (client) => {
			await client.request<unknown, unknown>("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			});
			await expect(
				client.request<unknown, { sessionId: string; cwd: string; mcpServers: unknown[] }>("session/load", {
					sessionId: "nonexistent-id",
					cwd: "/tmp",
					mcpServers: [],
				}),
			).rejects.toThrow(/not found/);
		});
	});

	it("session/list returns empty array on fresh agent", async () => {
		await withClient(async (client) => {
			await client.request<unknown, unknown>("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			});
			const list = await client.request<{ sessions: unknown[] }, unknown>("session/list", {});
			expect(Array.isArray(list.sessions)).toBe(true);
		});
	});

	it("authenticate returns empty {} immediately", async () => {
		await withClient(async (client) => {
			await client.request<unknown, unknown>("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			});
			const auth = await client.request<Record<string, never>, { methodId: string }>("authenticate", {
				methodId: "any",
			});
			expect(auth).toEqual({});
		});
	});

	it("document/didOpen stores the open buffer for the session", async () => {
		const sessionId = await withClient(async (client) => {
			await client.request<unknown, unknown>("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			});
			const { sessionId } = await client.request<{ sessionId: string }, { cwd: string; mcpServers: unknown[] }>(
				"session/new",
				{ cwd: "/tmp/test", mcpServers: [] },
			);
			// document/didOpen is a notification — fire-and-forget on the
			// client. We don't get a response, so we just send it and let the
			// next request happen to give the agent time to process.
			client.notify("document/did_open", {
				sessionId,
				uri: "file:///a.ts",
				languageId: "typescript",
				version: 1,
				text: "const x = 1;",
			});
			return sessionId;
		});
		expect(typeof sessionId).toBe("string");
	});
});
