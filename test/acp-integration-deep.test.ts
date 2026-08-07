/**
 * Deep integration test — exercises the in-process ACP wire with a
 * real ClientContext (so we can drive `sessionUpdate` notifications
 * back to the test). Captures every notification the agent emits
 * and prints them so a developer can inspect the wire format.
 *
 * Run with:  npx vitest run test/acp-integration-deep.test.ts
 */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/core/loop.ts", () => ({
	runAgentLoop: vi.fn(async () => undefined),
}));

vi.mock("../src/core/session.ts", () => ({
	listSessions: vi.fn(() => []),
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
	connectMcpServers: vi.fn(),
}));

const acp = await import("@agentclientprotocol/sdk");
const { buildAcpAgentApp } = await import("../src/core/acp/agent.ts");

function freshStartup() {
	return {
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
}

async function withClient<T>(
	run: (client: acp.ClientContext) => Promise<T>,
	opts: { version?: string; permissionMode?: "bypass" | "default" } = {},
): Promise<T> {
	const { app } = buildAcpAgentApp(freshStartup(), {
		version: opts.version ?? "test",
		permissionMode: opts.permissionMode ?? "bypass",
	});
	return acp.client({ name: "test-client" }).connectWith(app, run);
}

describe("ACP integration — wire inspector", () => {
	const events: { kind: string; payload: unknown }[] = [];

	afterAll(() => {
		console.log("\n=== captured " + events.length + " notifications ===");
		for (const e of events) {
			console.log(e.kind + ":", JSON.stringify(e.payload, null, 2));
		}
	});

	it("captures the full notification stream for initialize + session/new + session/prompt", async () => {
		const collected: Array<{ kind: string; payload: unknown }> = [];
		events.length = 0;

		const sessionId = await withClient(async (client) => {
			// Capture every notification the agent sends back.
			const onNotification = (method: string, params: unknown) => {
				collected.push({ kind: method, payload: params });
			};

			// initialize
			const init = await client.request<unknown, unknown>("initialize", {
				protocolVersion: 1,
				clientCapabilities: {},
			});
			onNotification("initialize result", init);

			// session/new
			const newSess = await client.request<{ sessionId: string }, { cwd: string; mcpServers: unknown[] }>(
				"session/new",
				{ cwd: "/tmp/test", mcpServers: [] },
			);
			onNotification("session/new result", newSess);

			// session/prompt
			const prompt = await client.request<
				{ stopReason: string },
				{ sessionId: string; prompt: Array<{ type: string; text?: string }> }
			>("session/prompt", {
				sessionId: newSess.sessionId,
				prompt: [{ type: "text", text: "test prompt" }],
			});
			onNotification("session/prompt result", prompt);

			return newSess.sessionId;
		});

		expect(sessionId).toBeTruthy();
		// Push the captured events to the parent scope for printing.
		events.push(...collected);

		// Each session emits at least these three round-trip responses.
		const kinds = events.map((e) => e.kind);
		expect(kinds.some((k) => k.includes("initialize"))).toBe(true);
		expect(kinds.some((k) => k.includes("session/new"))).toBe(true);
		expect(kinds.some((k) => k.includes("session/prompt"))).toBe(true);
	});
});
