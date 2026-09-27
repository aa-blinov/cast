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
	// Reset, not just clear: a test may install a fallback implementation.
	vi.mocked(streamAndCollect).mockReset();
	vi.mocked(streamAndCollect).mockImplementation(async () => {
		throw new Error("test streamAndCollect stub always throws");
	});
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
			// The independent completion check reads the evidence and agrees.
			.mockImplementationOnce(async () => ({ content: "COMPLETE", thinking: "", finishReason: "stop" as const }))
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

	it("lets an independent check turn a close down once, citing the gap, then trusts the next", async () => {
		startGoal(SESSION, "update all three files", 5);
		let judged = "";
		let rejection = "";
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "did a.txt" }))
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "a.txt done" }))
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				judged = messages.map((m) => String(m.content)).join("\n");
				return { content: "INCOMPLETE: b.txt and c.txt were never checked", thinking: "", finishReason: "stop" };
			})
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				rejection = String(messages[messages.length - 1]?.content ?? "");
				return goalUpdateCall({ status: "complete", note: "a, b and c all verified" })();
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

		expect(judged).toContain("You check whether an agent's goal is actually done");
		expect(judged).toContain("update all three files");
		expect(judged).toContain("a.txt done");
		expect(rejection).toContain("b.txt and c.txt were never checked");
		// Turned down once; the next close goes through without another check.
		expect(readGoal(SESSION)).toMatchObject({ status: "complete", judgeRejected: true });
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(5);
	});

	it("lets the close through when the check itself fails", async () => {
		startGoal(SESSION, "one thing", 5);
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "done" }))
			.mockImplementationOnce(goalUpdateCall({ status: "complete", note: "verified" }))
			.mockImplementationOnce(async () => {
				throw new Error("judge provider down");
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

		expect(readGoal(SESSION)?.status).toBe("complete");
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
		// Past the scripted turns the model just stops, so the run ends on the
		// goal's own idle rule rather than on a provider failure (which pauses it).
		vi.mocked(streamAndCollect).mockImplementation(async () => stop());
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

	it("ends the run at the iteration cap without spending the goal's continuations", async () => {
		// The cap used to break out, fall into the goal's stop point, push a
		// continuation, break on the cap again — until every continuation was
		// spent without a model call and the goal was marked budget_limited.
		startGoal(SESSION, "long job", 5);
		let n = 0;
		vi.mocked(streamAndCollect).mockImplementation(async () => ({
			content: "",
			thinking: "",
			finishReason: "tool_calls" as const,
			toolCalls: [{ id: `t${n}`, name: "ls", arguments: JSON.stringify({ path: `/tmp/${n++}` }) }],
		}));

		const out = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			maxOuterIterations: 2,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(readGoal(SESSION)).toMatchObject({ status: "active", continuations: 0 });
		expect(out.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("stops driving after two passes in a row that change nothing, leaving the goal open", async () => {
		startGoal(SESSION, "needs the user", 5);
		vi.mocked(streamAndCollect).mockImplementation(async () => stop());
		const warnings: string[] = [];

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: (w) => warnings.push(w),
		});

		// Pass one continues, pass two is nudged, pass three stops the drive.
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);
		expect(readGoal(SESSION)).toMatchObject({ status: "active", continuations: 2 });
		expect(warnings.some((w) => w.includes("two passes in a row changed nothing"))).toBe(true);
	});

	it("parks the goal when the provider fails mid-goal, like an abort", async () => {
		startGoal(SESSION, "fragile work", 5);

		await runAgentLoop([{ role: "user", content: "start" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(readGoal(SESSION)).toMatchObject({
			status: "paused",
			note: "The previous turn failed before it finished.",
		});
	});

	it("sees a goal cleared or reworded mid-run on the very next model call", async () => {
		const { editGoalObjective } = await import("../src/core/goal.ts");
		const lsCall = (id: string) => ({
			content: "",
			thinking: "",
			finishReason: "tool_calls" as const,
			toolCalls: [{ id, name: "ls", arguments: JSON.stringify({ path: `/tmp/${id}` }) }],
		});
		const seen: Array<{ system: string; tools: string[] }> = [];
		const capture = (messages: Message[], tools: unknown) =>
			seen.push({
				system: String(messages.find((m) => m.role === "system")?.content ?? ""),
				tools: (tools as Array<{ function: { name: string } }>).map((t) => t.function.name),
			});

		startGoal(SESSION, "make the old thing", 5);
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async (_c, _m, messages, tools) => {
				capture(messages, tools);
				editGoalObjective(SESSION, "make the new thing");
				return lsCall("a");
			})
			.mockImplementationOnce(async (_c, _m, messages, tools) => {
				capture(messages, tools);
				clearGoal(SESSION);
				return lsCall("b");
			})
			.mockImplementationOnce(async (_c, _m, messages, tools) => {
				capture(messages, tools);
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

		expect(seen[0]!.system).toContain("make the old thing");
		expect(seen[1]!.system).toContain("make the new thing");
		expect(seen[2]!.system).not.toContain("make the new thing");
		expect(seen[2]!.tools).not.toContain("goal_update");
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(3);
	});

	it("doesn't drive the goal while a plan is being written", async () => {
		const { createPlanState } = await import("../src/core/plan.ts");
		startGoal(SESSION, "plan then build", 5);
		const planState = createPlanState(fakeHome, "goal-plan");
		planState.enabled = true;
		vi.mocked(streamAndCollect).mockImplementation(async () => stop());

		await runAgentLoop([{ role: "user", content: "plan it" }], {
			config: testConfig,
			model: "test-model",
			cwd: fakeHome,
			systemPrompt: "base",
			sessionId: SESSION,
			planState,
			onEvent: () => {},
			onWarning: () => {},
		});

		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(1);
		expect(readGoal(SESSION)).toMatchObject({ status: "active", continuations: 0 });
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
		vi.mocked(streamAndCollect).mockImplementation(async () => stop());
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
