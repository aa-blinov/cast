import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";

// Same stub as loop.test.ts: the loop must never reach a real provider.
vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return {
		...actual,
		createClient: () => ({}),
		streamAndCollect: vi.fn(async () => {
			throw new Error("test streamAndCollect stub always throws");
		}),
	};
});

const { runAgentLoop } = await import("../src/core/loop.ts");
const { streamAndCollect } = await import("../src/core/llm.ts");
const { startGoal, readGoal, clearGoal } = await import("../src/core/goal.ts");

const testConfig: AppConfig = {
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
};

// Goals live under ~/.cast/goals and sessions under ~/.cast/sessions — point
// both at a throwaway home so a test can never touch the developer's own.
let fakeHome: string;
let realHome: string | undefined;
let fakeDb: string;
let realDb: string | undefined;
const SESSION = "goal-loop-session";

beforeEach(() => {
	vi.mocked(streamAndCollect).mockClear();
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "cast-goal-loop-home-"));
	process.env.HOME = fakeHome;
	realDb = process.env.CAST_SESSIONS_DB;
	fakeDb = join(mkdtempSync(join(tmpdir(), "cast-goal-loop-db-")), "sessions.db");
	process.env.CAST_SESSIONS_DB = fakeDb;
	resetDbConnectionForTests();
});

afterEach(() => {
	clearGoal(SESSION);
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(fakeHome, { recursive: true, force: true });
	rmSync(join(fakeDb, ".."), { recursive: true, force: true });
});

const stop = () => ({ content: "done", thinking: "", finishReason: "stop" as const });

function goalUpdateCall(args: Record<string, unknown>) {
	return () => ({
		content: "",
		thinking: "",
		finishReason: "tool_calls" as const,
		toolCalls: [{ id: "g-1", name: "goal_update", arguments: JSON.stringify(args) }],
	});
}

describe("runAgentLoop — durable goal", () => {
	it("carries the objective in the system prompt and offers goal_update", async () => {
		startGoal(SESSION, "make the importer idempotent", 0);
		let systemPrompt = "";
		let toolNames: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_client, _model, messages, tools) => {
			systemPrompt = String(messages.find((m: Message) => m.role === "system")?.content ?? "");
			toolNames = tools.map((tool: { function: { name: string } }) => tool.function.name);
			return stop();
		});

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(systemPrompt).toContain("## Active goal");
		expect(systemPrompt).toContain("make the importer idempotent");
		expect(toolNames).toContain("goal_update");
		// The turn counts toward the goal's history.
		expect(readGoal(SESSION)?.turns).toBe(1);
	});

	// The point of the feature: the turn does not end while the goal is open.
	it("continues instead of stopping, and spends the budget doing it", async () => {
		startGoal(SESSION, "finish every file", 1);
		const seen: string[] = [];
		const record = async (_c: unknown, _m: unknown, messages: Message[]) => {
			seen.push(String(messages[messages.length - 1]?.content ?? ""));
			return stop();
		};
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(record)
			.mockImplementationOnce(record)
			.mockImplementationOnce(record);

		const warnings: string[] = [];
		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: (message) => warnings.push(message),
		});

		// Pass 1 is the user's message, pass 2 the continuation, pass 3 the
		// wrap-up once the single continuation is spent.
		expect(seen[1]).toContain("The goal above is still open");
		expect(seen[2]).toContain("used its continuation budget");
		expect(warnings.some((w) => w.includes("continuation budget"))).toBe(true);
		// Exhaustion is terminal, so later turns don't pay for it again.
		expect(readGoal(SESSION)?.status).toBe("budget_limited");
	});

	// One run in twenty closed a three-file goal after the first file, with a
	// note that was true about the work done and silent about the rest. The
	// first "complete" now buys a demand for proof instead of a close.
	it("answers the first complete with a challenge and closes on the second", async () => {
		startGoal(SESSION, "one thing", 5);
		let challenge = "";
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "did the thing" }))
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				challenge = String(messages[messages.length - 1]?.content ?? "");
				return goalUpdateCall({ status: "complete", note: "checked each requirement, all green" })();
			})
			.mockImplementationOnce(stop);

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(challenge).toContain("Not closed yet");
		expect(challenge).toContain("Work from the objective");
		expect(readGoal(SESSION)?.status).toBe("complete");
		// The close is the second call's doing, and nothing continued after it.
		expect(readGoal(SESSION)?.continuations).toBe(0);
	});

	it("keeps the goal active when the agent stops at the challenge", async () => {
		startGoal(SESSION, "one thing", 0);
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "did the thing" }))
			.mockImplementationOnce(stop);

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		// Challenged but never proven: the goal must not close itself.
		expect(readGoal(SESSION)?.status).not.toBe("complete");
		expect(readGoal(SESSION)?.completionChallenged).toBe(true);
	});

	// A missing or misspelled status used to fall through to "complete".
	it("refuses a goal_update without a valid status", async () => {
		// A budget, so the goal stays active rather than terminalising on
		// exhaustion — what is under test is the status, not the budget.
		startGoal(SESSION, "one thing", 5);
		let toolResult = "";
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(goalUpdateCall({ note: "still stuck on the build" }))
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				toolResult = String(messages[messages.length - 1]?.content ?? "");
				return stop();
			});

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(toolResult).toContain('status must be "complete" or "blocked"');
		expect(readGoal(SESSION)?.status).toBe("active");
	});

	it("keeps the goal active on a first blocker and blocks on the third", async () => {
		startGoal(SESSION, "one thing", 0);
		const blocked = goalUpdateCall({ status: "blocked", note: "registry unreachable" });
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(blocked)
			.mockImplementationOnce(blocked)
			.mockImplementationOnce(blocked)
			.mockImplementationOnce(stop);

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(readGoal(SESSION)?.status).toBe("blocked");
		expect(readGoal(SESSION)?.blockedStreak).toBe(3);
	});

	// Subagents share the parent's session id, so without the gate a delegated
	// task would inherit the goal and could close its parent's.
	it("gives a nested run neither the goal block nor the tool", async () => {
		startGoal(SESSION, "parent objective", 5);
		let systemPrompt = "";
		let toolNames: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, messages, tools) => {
			systemPrompt = String(messages.find((m: Message) => m.role === "system")?.content ?? "");
			toolNames = tools.map((tool: { function: { name: string } }) => tool.function.name);
			return stop();
		});

		await runAgentLoop([{ role: "user", content: "child task" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			skipTurnRunnerLock: true,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(systemPrompt).not.toContain("parent objective");
		expect(toolNames).not.toContain("goal_update");
		expect(readGoal(SESSION)?.status).toBe("active");
	});

	it("parks the goal when the turn is aborted, and says so on the way back", async () => {
		startGoal(SESSION, "slow work", 5);
		const controller = new AbortController();
		vi.mocked(streamAndCollect).mockImplementationOnce(async () => {
			controller.abort();
			throw new Error("Request was aborted.");
		});

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			signal: controller.signal,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(readGoal(SESSION)?.status).toBe("paused");

		let systemPrompt = "";
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, messages) => {
			systemPrompt = String(messages.find((m: Message) => m.role === "system")?.content ?? "");
			return stop();
		});
		await runAgentLoop([{ role: "user", content: "continue" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(systemPrompt).toContain("interrupted before it finished");
		expect(readGoal(SESSION)?.status).toBe("active");
	});
});
