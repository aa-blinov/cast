import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnCheckpoint } from "../src/core/checkpoint.ts";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";
import {
	addUsage,
	appendCheckpoint,
	appendMessage,
	appendSessionEvent,
	clearSessionMessages,
	commitCheckpointWatermark,
	compactMessages,
	countTurnMessages,
	createSession,
	deleteSession,
	dropLastCheckpoint,
	estimateTokens,
	findCheckpointBoundaryForMessages,
	forkSession,
	getCheckpointWatermark,
	getFullHistory,
	getFullHistoryWithReasoning,
	getHistoryPage,
	getMessageImage,
	getMessagesAfterCheckpoint,
	getMostRecentSession,
	getSessionEvents,
	listSessionSummaries,
	listSessions,
	loadCheckpoints,
	loadSession,
	loadSessionByShareToken,
	loadSubagentRuns,
	markImageMessagesOutOfContext,
	migrateLegacySessionsToDb,
	recordCompaction,
	resetSessionContext,
	saveSession,
	saveSubagentRun,
	searchSessionSummaries,
	shouldCompact,
	updateLastCheckpoint,
} from "../src/core/session.ts";

describe("addUsage subagent attribution", () => {
	const mkUsage = (over: Partial<import("../src/core/llm.ts").Usage> = {}) => ({
		promptTokens: 100,
		completionTokens: 50,
		totalTokens: 150,
		...over,
	});

	it("folds subagent usage into totals AND subagentTokens, without touching context size", () => {
		const s = createSession("gpt-4o", tmpdir());
		addUsage(s, mkUsage(), { subagent: false });
		expect(s.usage.subagentTokens).toBe(0);
		expect(s.lastPromptTokens).toBe(100);

		addUsage(s, mkUsage({ promptTokens: 999, totalTokens: 200 }), { subagent: true });
		expect(s.usage.totalTokens).toBe(350); // subagent counted in grand total
		expect(s.usage.subagentTokens).toBe(200); // and tracked separately
		expect(s.lastPromptTokens).toBe(100); // subagent prompt did NOT change context size
	});

	it("folds background usage into totals without changing the active context size", () => {
		const s = createSession("gpt-4o", tmpdir());
		s.lastPromptTokens = 100;
		addUsage(s, mkUsage({ promptTokens: 999 }), { background: true });
		expect(s.usage.totalTokens).toBe(150);
		expect(s.usage.subagentTokens).toBe(0);
		expect(s.lastPromptTokens).toBe(100);
	});
});

// ============================================================================
// estimateTokens
// ============================================================================

describe("estimateTokens", () => {
	it("returns ~0 for empty messages", () => {
		expect(estimateTokens([])).toBeLessThan(5);
	});

	it("estimates tokens for a single message", () => {
		const messages: Message[] = [{ role: "user", content: "Hello, how are you?" }];
		const tokens = estimateTokens(messages);
		expect(tokens).toBeGreaterThan(0);
		expect(tokens).toBeLessThan(100);
	});

	it("scales with message count", () => {
		const one: Message[] = [{ role: "user", content: "Hello" }];
		const ten: Message[] = Array.from({ length: 10 }, () => ({ role: "user", content: "Hello" }));
		expect(estimateTokens(ten)).toBeGreaterThan(estimateTokens(one));
	});
});

// ============================================================================
// countTurnMessages
// ============================================================================

describe("countTurnMessages", () => {
	it("counts one per user message and one per non-tool-call assistant reply", () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
			{ role: "user", content: "read a file" },
			{ role: "assistant", content: "reading now" },
		];
		expect(countTurnMessages(messages)).toBe(4); // system excluded, 2 user + 2 assistant
	});

	it("does not count tool-call-only assistant messages as separate turns", () => {
		// One user request that takes two tool-call rounds before the real
		// reply — three assistant completions in the raw array, but from the
		// user's point of view this is still just "I asked, it answered".
		const messages: Message[] = [
			{ role: "user", content: "read a.ts then b.ts and summarize" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: '{"path":"b.ts"}' } }],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c2", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "Both files do X and Y." },
		];
		expect(countTurnMessages(messages)).toBe(2); // 1 user + 1 final reply
	});

	it("returns 0 for an empty or purely system/tool array", () => {
		expect(countTurnMessages([])).toBe(0);
		expect(countTurnMessages([{ role: "system", content: "sys" }])).toBe(0);
	});
});

// ============================================================================
// shouldCompact
// ============================================================================

describe("shouldCompact", () => {
	const config = {
		contextWindow: 1000,
		maxResponseTokens: 100,
		compactionThreshold: 0.75,
	};

	it("returns false when under threshold", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		expect(shouldCompact(messages, config as any)).toBe(false);
	});

	it("returns true when over threshold", () => {
		const messages: Message[] = [{ role: "user", content: "Hello" }];
		// shouldCompact now uses API-reported promptTokens, not message estimation.
		expect(shouldCompact(messages, config as any, 800)).toBe(true);
	});
});

// ============================================================================
// compactMessages
// ============================================================================

describe("compactMessages", () => {
	it("returns compacted messages with summary", async () => {
		const messages: Message[] = [
			{ role: "system", content: "You are helpful." },
			{ role: "user", content: "Hello" },
			{ role: "assistant", content: "Hi there!" },
			{ role: "user", content: "What is 2+2?" },
			{ role: "assistant", content: "4" },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "You're welcome" },
		];

		const summarize = async (text: string) => `Summary of: ${text.slice(0, 50)}`;

		const result = await compactMessages(messages, summarize, {
			contextWindow: 100_000,
			maxResponseTokens: 8192,
			compactionThreshold: 0.75,
		} as any);

		expect(result.messages.length).toBeLessThan(messages.length);
		expect(result.messages.some((m) => typeof m.content === "string" && m.content.includes("Compacted"))).toBe(true);
		expect(result.summary.messagesCompacted).toBeGreaterThan(0);
		expect(result.summary.tokensBefore).toBeGreaterThan(0);
	});

	it("surfaces tool_calls in the text sent to the summarizer instead of dropping them", async () => {
		// Real messages from this codebase carry tool_calls as a sibling field
		// (OpenAI shape), with content: null when the turn is purely a tool
		// call — not Anthropic-style content blocks. A summarizer that can't
		// see this loses almost everything a coding agent actually did.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "Read config.ts and tell me the default context window" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "src/config.ts" }) },
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "call_1", content: "contextWindow: 128_000" } as unknown as Message,
			{ role: "assistant", content: "128,000 tokens." },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "You're welcome" },
		];

		let capturedText = "";
		const summarize = async (text: string) => {
			capturedText = text;
			return "summary";
		};

		await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(capturedText).not.toContain("[structured content]");
		expect(capturedText).toContain("read");
		expect(capturedText).toContain("src/config.ts");
	});

	it("appends deterministic read/modified file tags to the summary, extracted from tool_calls", async () => {
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "Look at a.ts, then update b.ts" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.ts" }) } },
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c2",
						type: "function",
						function: {
							name: "edit",
							arguments: JSON.stringify({
								path: "b.ts",
								ops: [{ op: "replace", anchor: "1:abc", content: "y" }],
							}),
						},
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c2", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "Done" },
			{ role: "user", content: "Thanks" },
			{ role: "assistant", content: "Sure" },
			// Padding so the 60% split point lands after both tool calls above,
			// not between them — otherwise this test would depend on exactly
			// where compactMessages happens to draw the line.
			{ role: "user", content: "One more thing" },
			{ role: "assistant", content: "Sure thing" },
		];

		// File tags are appended deterministically to the model's *output*,
		// not folded into its input — assert both ends: the model never sees
		// the tags (nothing for it to garble or omit)...
		let capturedText = "";
		const summarize = async (text: string) => {
			capturedText = text;
			return "summary";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(capturedText).not.toContain("<read-files>");

		// ...and the final marker has them regardless of what the model said.
		const marker = result.messages.find(
			(m) => typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		const markerText = marker?.content as string;
		expect(markerText).toContain("<read-files>");
		expect(markerText).toContain("a.ts");
		expect(markerText).toContain("<modified-files>");
		expect(markerText).toContain("b.ts");
	});

	it("skips summarizing when there is no safe cut point (degenerate history)", async () => {
		// A single unbroken assistant/tool pair with nothing before it in the
		// non-system slice: the naive 60% split lands on the tool result, and
		// walking back to a safe boundary has nowhere to go but index 0 —
		// i.e. nothing is safely compactable yet.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "output" } as unknown as Message,
		];

		let called = false;
		const summarize = async () => {
			called = true;
			return "should not be called";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(called).toBe(false);
		expect(result.summary.messagesCompacted).toBe(0);
		expect(result.messages).toBe(messages);
	});

	it("threads an existing compaction summary through as previousSummary instead of stacking markers", async () => {
		const previousMarker =
			"[Compacted context — 5 messages summarized]\n" +
			"## Goal\nBuild a CLI tool.\n\n<read-files>\nold.ts\n</read-files>";

		const messages: Message[] = [
			{ role: "system", content: "You are a coding agent." },
			{ role: "system", content: previousMarker },
			{ role: "user", content: "turn 1" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c1",
						type: "function",
						function: { name: "read", arguments: JSON.stringify({ path: "new.ts" }) },
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "read new.ts" },
			{ role: "user", content: "turn 2" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "c2",
						type: "function",
						function: {
							name: "edit",
							arguments: JSON.stringify({
								path: "other.ts",
								ops: [{ op: "replace", anchor: "1:abc", content: "b" }],
							}),
						},
					},
				],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c2", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "edited other.ts" },
			{ role: "user", content: "turn 3" },
			{ role: "assistant", content: "done" },
		];

		let receivedPreviousSummary: string | undefined;
		const summarize = async (_text: string, previousSummary?: string) => {
			receivedPreviousSummary = previousSummary;
			return "## Goal\nBuild a CLI tool.\n\nUpdated with turns 1-2.";
		};

		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(receivedPreviousSummary).toContain("Build a CLI tool");
		expect(receivedPreviousSummary).not.toContain("[Compacted context");

		const compactionMarkers = result.messages.filter(
			(m) => typeof m.content === "string" && m.content.startsWith("[Compacted context"),
		);
		expect(compactionMarkers).toHaveLength(1);

		// File paths from the old marker's tags survive into the new one,
		// merged with paths touched by the newly-compacted turns.
		const markerText = compactionMarkers[0]!.content as string;
		expect(markerText).toContain("old.ts");
		expect(markerText).toContain("new.ts");
		expect(markerText).toContain("other.ts");
	});
});

// ============================================================================
// Compaction never orphans a tool result
// ============================================================================

describe("compaction cut points never split a tool_calls/tool pair", () => {
	/** Irregular history: each user turn gets a random-length chain of
	 * assistant(tool_calls)+tool round trips before a plain-text reply —
	 * matches how a real coding-agent session actually looks, unlike a
	 * uniform period-3 pattern that can hide off-by-one boundary bugs. */
	function buildRealisticHistory(turns: number, seed: number): Message[] {
		let s = seed;
		const rand = () => {
			s = (s * 1103515245 + 12345) & 0x7fffffff;
			return s / 0x7fffffff;
		};
		const messages: Message[] = [{ role: "system", content: "sys" }];
		let callId = 0;
		for (let t = 0; t < turns; t++) {
			messages.push({ role: "user", content: `turn ${t}` });
			const rounds = 1 + Math.floor(rand() * 4);
			for (let r = 0; r < rounds; r++) {
				messages.push({
					role: "assistant",
					content: null,
					tool_calls: [{ id: `c${callId}`, type: "function", function: { name: "bash", arguments: "{}" } }],
				} as unknown as Message);
				messages.push({
					role: "tool",
					tool_call_id: `c${callId}`,
					content: `result ${callId}`,
				} as unknown as Message);
				// A `read` on an image file mixed in ~1/4 of the time — the
				// synthetic role:"user" relay message (no text part, only
				// image_url) that must never be mistaken for a real turn
				// boundary (see safeCutIndex's isRealTurnStart).
				if (rand() < 0.25) {
					messages.push({
						role: "user",
						content: [{ type: "image_url", image_url: { url: `data:image/png;base64,c${callId}` } }],
					} as unknown as Message);
				}
				callId++;
			}
			messages.push({ role: "assistant", content: `done with turn ${t}` });
		}
		return messages;
	}

	function firstDanglingToolIndex(seq: Message[]): number {
		for (let i = 0; i < seq.length; i++) {
			if (seq[i]?.role !== "tool") continue;
			const prev = seq[i - 1] as { role: string; tool_calls?: unknown } | undefined;
			if (!prev || prev.role !== "assistant" || !prev.tool_calls) return i;
		}
		return -1;
	}

	it("compactMessages never leaves a tool result without its assistant tool_calls", async () => {
		const summarize = async () => "summary";
		for (let seed = 1; seed <= 20; seed++) {
			for (const turns of [10, 15, 20, 25]) {
				const messages = buildRealisticHistory(turns, seed);
				const result = await compactMessages(messages, summarize, {
					contextWindow: 1,
					maxResponseTokens: 0,
					compactionThreshold: 0,
				} as any);
				expect(firstDanglingToolIndex(result.messages)).toBe(-1);
			}
		}
	});

	/** Unlike firstDanglingToolIndex (which assumes one tool_calls per
	 *  assistant message and checks only the immediately preceding row — fine
	 *  for buildRealisticHistory's serial rounds), this tolerates a *parallel*
	 *  batch: several tool results (each possibly followed by its own
	 *  image_url relay) all declared by one earlier assistant message, not
	 *  each other. Tracks every tool_call_id declared so far instead. */
	function findOrphanedToolResult(messages: Message[]): number {
		const declared = new Set<string>();
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i] as { role: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string };
			if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
				for (const tc of m.tool_calls) declared.add(tc.id);
			}
			if (m.role === "tool" && m.tool_call_id && !declared.has(m.tool_call_id)) return i;
		}
		return -1;
	}

	it("compactMessages doesn't land mid-batch on a parallel read-image call, orphaning later tool results (regression)", async () => {
		// Reproduces the production incident: one assistant message fires 5
		// parallel `read` calls on images; each tool result is immediately
		// followed by its own synthetic image_url "user" message (no text
		// part — see loop.ts's castToolCallId comment). safeCutIndex used to
		// treat every role:"user" row as a valid turn boundary, so a cut could
		// land right after the *first* image relay — keeping tool results 2-5
		// while discarding the one assistant message that declared all of
		// them, producing exactly the provider's "tool result's tool id not
		// found" 400.
		const messages: Message[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "check these 5 photos" },
			{
				role: "assistant",
				content: null,
				tool_calls: Array.from({ length: 5 }, (_, i) => ({
					id: `read${i}`,
					type: "function",
					function: { name: "read", arguments: "{}" },
				})),
			} as unknown as Message,
			...Array.from({ length: 5 }, (_, i) => [
				{ role: "tool", tool_call_id: `read${i}`, content: `[Image: photo${i}.jpg]` } as unknown as Message,
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,p${i}` } }],
				} as unknown as Message,
			]).flat(),
			{ role: "assistant", content: "None of these are Bengals." },
			{ role: "user", content: "are you sure?" },
			{ role: "assistant", content: "Yes." },
		];

		const summarize = async () => "summary";
		// A target that (before the fix) lands squarely inside the batch —
		// right after the first image relay, index 5 (system, user, assistant,
		// tool0, image0 = indices 0-4; landing at 5 is mid-batch).
		const result = await compactMessages(messages, summarize, {
			contextWindow: 1,
			maxResponseTokens: 0,
			compactionThreshold: 0,
		} as any);

		expect(findOrphanedToolResult(result.messages)).toBe(-1);
	});
});

// ============================================================================
// Session persistence — per-project directories, legacy flat files, delete
// ============================================================================

describe("session persistence", () => {
	let realHome: string | undefined;
	let realDb: string | undefined;
	let fakeHome: string;
	let projectA: string;
	let projectB: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		realDb = process.env.CAST_SESSIONS_DB;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-session-test-"));
		process.env.HOME = fakeHome;
		process.env.CAST_SESSIONS_DB = join(fakeHome, ".cast", "sessions", "sessions.db");
		mkdirSync(join(fakeHome, ".cast", "sessions"), { recursive: true });
		resetDbConnectionForTests();
		projectA = join(fakeHome, "projects", "a");
		projectB = join(fakeHome, "projects", "b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(() => {
		resetDbConnectionForTests();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
		if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
		else process.env.CAST_SESSIONS_DB = realDb;
	});

	it("createSession records the cwd it was created in", () => {
		const session = createSession("gpt-4o", projectA);
		expect(session.cwd).toBe(projectA);
	});

	it("saveSession/loadSession round-trips a session under its project directory", () => {
		const session = createSession("gpt-4o", projectA);
		session.messages.push({ role: "user", content: "hello" });
		saveSession(session);

		const loaded = loadSession(session.id);
		expect(loaded?.id).toBe(session.id);
		expect(loaded?.cwd).toBe(projectA);
		expect(loaded?.messages).toEqual(session.messages);
	});

	it("commits a durable checkpoint watermark monotonically and survives reload", () => {
		const session = createSession("gpt-4o", projectA);
		const first: Message = { role: "user", content: "first" };
		const second: Message = { role: "assistant", content: "second" };
		session.messages.push(first, second);
		saveSession(session);

		expect(getCheckpointWatermark(session.id)).toBeUndefined();
		expect(commitCheckpointWatermark(session.id, structuredClone(second))).toBe(true);
		const committed = getCheckpointWatermark(session.id);
		expect(committed).toBeTypeOf("string");
		expect(committed).not.toBe("");

		// A delayed writer may finish with an older snapshot, but it must never
		// move the durable boundary backwards.
		expect(commitCheckpointWatermark(session.id, structuredClone(first))).toBe(false);
		expect(getCheckpointWatermark(session.id)).toBe(committed);
	});

	it("does not advance the watermark when the target message was never persisted", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);

		expect(commitCheckpointWatermark(session.id, { role: "user", content: "not persisted" })).toBe(false);
		expect(getCheckpointWatermark(session.id)).toBeUndefined();
	});

	it("uses the watermark to recover a durable delta after the active context was compacted", () => {
		const session = createSession("gpt-4o", projectA);
		const covered: Message = { role: "assistant", content: "covered" };
		const pending: Message = { role: "user", content: "pending" };
		session.messages.push(covered, pending);
		saveSession(session);
		commitCheckpointWatermark(session.id, covered);

		const active = [covered, pending];
		expect(findCheckpointBoundaryForMessages(session.id, active)).toBe(0);
		expect(getMessagesAfterCheckpoint(session.id)).toEqual([pending]);
	});

	it("forkSession copies the active context into an independent new session", () => {
		const source = createSession("gpt-4o", projectA);
		source.persona = "coding";
		source.mode = "plan";
		source.messages = [
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "original request" },
			{ role: "assistant", content: "original answer" },
		];
		source.reasoning = { 2: "reasoning" };
		source.turnMeta = { 2: { model: "gpt-4o", completedAt: "2026-08-09T00:00:00.000Z" } };
		source.usage.totalTokens = 99;
		saveSession(source);

		const fork = forkSession(source);
		expect(fork.id).not.toBe(source.id);
		expect(fork.messages).toEqual(source.messages);
		expect(fork.messages).not.toBe(source.messages);
		expect(fork.usage.totalTokens).toBe(0);
		expect(fork.mode).toBe("plan");
		expect(fork.reasoning).toEqual(source.reasoning);
		fork.messages[1] = { role: "user", content: "branch-only change" };
		expect(source.messages[1]).toEqual({ role: "user", content: "original request" });
		expect(loadSession(fork.id)?.messages).toEqual([
			{ role: "system", content: "system prompt" },
			{ role: "user", content: "original request" },
			{ role: "assistant", content: "original answer" },
		]);
	});

	it("persists undo checkpoints across save/load and drops the last on undo", () => {
		const session = createSession("gpt-4o", projectA);
		session.messages.push({ role: "user", content: "hello" });
		saveSession(session);

		const chk1 = { id: "c1", timestamp: new Date().toISOString(), cwd: projectA, gitCommitSha: "abc123" };
		const chk2 = { id: "c2", timestamp: new Date().toISOString(), cwd: projectA, gitCommitSha: "def456" };
		appendCheckpoint(session.id, chk1);
		appendCheckpoint(session.id, chk2);

		const loaded = loadSession(session.id);
		expect(loaded?.checkpoints?.map((c) => c.id)).toEqual(["c1", "c2"]);

		// /undo pops the most recent checkpoint and drops its row.
		dropLastCheckpoint(session.id);
		const afterUndo = loadSession(session.id);
		expect(afterUndo?.checkpoints?.map((c) => c.id)).toEqual(["c1"]);
	});

	it("persists shadow backups added after a checkpoint is created", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);
		const checkpoint: TurnCheckpoint = { id: "c1", timestamp: new Date().toISOString(), cwd: projectA, backups: [] };
		appendCheckpoint(session.id, checkpoint);
		checkpoint.backups.push({ relPath: "created.txt", existedBefore: false });
		updateLastCheckpoint(session.id, checkpoint);

		expect(loadCheckpoints(session.id)[0]?.backups).toEqual([{ relPath: "created.txt", existedBefore: false }]);
	});

	it("appends and reads back live session events in order", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);

		appendSessionEvent(session.id, "tool_start", { id: "call_1", name: "bash" });
		appendSessionEvent(session.id, "retry", { attempt: 2, reason: "boom" });
		appendSessionEvent(session.id, "error", { message: "kaput" });

		const events = getSessionEvents(session.id);
		expect(events.map((e) => e.type)).toEqual(["tool_start", "retry", "error"]);
		expect(events[1]!.payload).toEqual({ attempt: 2, reason: "boom" });
		expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
	});

	it("persists subagent transcripts and loads them back in order", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);

		saveSubagentRun({
			sessionId: session.id,
			toolCallId: "call_1",
			persona: "worker",
			model: "gpt-4o",
			startedAt: "2026-01-01T00:00:00.000Z",
			endReason: "stop",
			messages: [
				{ role: "user", content: "do the thing" },
				{ role: "assistant", content: "done" },
			],
		});
		saveSubagentRun({
			sessionId: session.id,
			toolCallId: "call_2",
			persona: "explorer",
			model: "gpt-4o",
			startedAt: "2026-01-01T00:00:01.000Z",
			endReason: "stop",
			messages: [{ role: "user", content: "explore" }],
		});

		const runs = loadSubagentRuns(session.id);
		expect(runs).toHaveLength(2);
		expect(runs[0]?.toolCallId).toBe("call_1");
		expect(runs[0]?.persona).toBe("worker");
		expect(runs[0]?.messages).toEqual([
			{ role: "user", content: "do the thing" },
			{ role: "assistant", content: "done" },
		]);
		expect(runs[1]?.toolCallId).toBe("call_2");
	});

	it("cascades checkpoints and subagent runs when the session is deleted", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);
		appendCheckpoint(session.id, { id: "c1", timestamp: "t", cwd: projectA });
		saveSubagentRun({
			sessionId: session.id,
			toolCallId: "call_1",
			startedAt: "t",
			endReason: "stop",
			messages: [],
		});

		deleteSession(session.id);

		expect(loadCheckpoints(session.id)).toEqual([]);
		expect(loadSubagentRuns(session.id)).toEqual([]);
	});

	it("markImageMessagesOutOfContext drops rejected image_url messages from the session", () => {
		const session = createSession("gpt-4o", projectA);
		const img = "data:image/png;base64,iVBORw0KGgo=";
		session.messages.push(
			{ role: "user", content: "plain text" },
			{
				role: "user",
				content: [
					{ type: "text", text: "see" },
					{ type: "image_url", image_url: { url: img } },
				],
			},
		);
		saveSession(session);

		markImageMessagesOutOfContext(session.id);

		const loaded = loadSession(session.id);
		expect(loaded?.messages.map((m) => JSON.stringify(m.content))).toEqual(['"plain text"']);
	});

	it("derives the title when any caller appends the first user message", () => {
		const session = createSession("gpt-4o", projectA);
		appendMessage(session, { role: "user", content: "  First\nmessage becomes the session title  " });
		appendMessage(session, { role: "user", content: "A later message does not replace it" });
		expect(session.title).toBe("First message becomes the session title");
	});

	it("backfills legacy untitled sessions without restoring an explicitly cleared title", () => {
		const session = createSession("gpt-4o", projectA);
		session.messages.push({ role: "user", content: "  First\nmessage becomes the session title  " });
		saveSession(session);

		const db = getDb();
		db.prepare("UPDATE sessions SET title = NULL WHERE id = ?").run(session.id);
		migrateLegacySessionsToDb();

		expect(listSessionSummaries().find((summary) => summary.id === session.id)?.title).toBe(
			"First message becomes the session title",
		);

		getDb().prepare("UPDATE sessions SET title = '' WHERE id = ?").run(session.id);
		migrateLegacySessionsToDb();
		expect(loadSession(session.id)?.title).toBe("");
	});

	it("persists pending plan picker state in SQLite", () => {
		const session = createSession("gpt-4o", projectA);
		session.planQuestion = {
			questions: [
				{
					question: "Choose a cache backend",
					options: [
						{ value: "memory", label: "In-memory" },
						{ value: "redis", label: "Redis" },
					],
					recommended: "memory",
				},
			],
		};
		session.planTransition = { kind: "done" };
		saveSession(session);

		expect(loadSession(session.id)).toMatchObject({
			planQuestion: session.planQuestion,
			planTransition: { kind: "done" },
		});
	});

	it("loadSessionByShareToken finds a session by its share token, not its id", () => {
		const session = createSession("gpt-4o", projectA);
		session.shareToken = "tok_abc123";
		saveSession(session);

		expect(loadSessionByShareToken("tok_abc123")?.id).toBe(session.id);
		expect(loadSessionByShareToken(session.id)).toBeNull();
		expect(loadSessionByShareToken("wrong-token")).toBeNull();
	});

	it("clearing shareToken on an already-shared session revokes the old token", () => {
		const session = createSession("gpt-4o", projectA);
		session.shareToken = "tok_to_revoke";
		saveSession(session);
		expect(loadSessionByShareToken("tok_to_revoke")).not.toBeNull();

		session.shareToken = undefined;
		saveSession(session);
		expect(loadSessionByShareToken("tok_to_revoke")).toBeNull();
		expect(loadSession(session.id)?.shareToken).toBeUndefined();
	});

	it("normalizes cache_control-damaged messages on load", () => {
		// Older builds let applyCacheControl mutate live message objects and
		// persisted the request-only shape (text-part arrays with
		// cache_control). Loading must flatten those back to plain strings so
		// a provider switch doesn't 400 on the resumed history.
		const session = createSession("gpt-4o", projectA);
		session.messages.push(
			{
				role: "user",
				content: [
					{ type: "text", text: "hello ", cache_control: { type: "ephemeral" } },
					{ type: "text", text: "world" },
				],
			} as never,
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
					{ type: "text", text: "what is this?", cache_control: { type: "ephemeral" } },
				],
			} as never,
		);
		saveSession(session);

		const loaded = loadSession(session.id);
		// All-text array → flattened to a plain string, markers gone.
		expect(loaded?.messages[0]?.content).toBe("hello world");
		// Multimodal array stays an array but loses cache_control.
		const parts = loaded?.messages[1]?.content as Array<Record<string, unknown>>;
		expect(Array.isArray(parts)).toBe(true);
		expect(parts[0]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } });
		expect(parts[1]).toEqual({ type: "text", text: "what is this?" });
	});

	it("keeps sessions from different projects in separate directories", () => {
		const a = createSession("gpt-4o", projectA);
		saveSession(a);
		const b = createSession("gpt-4o", projectB);
		saveSession(b);

		// listSessions must see both even though they're nested under
		// different encoded-cwd subdirectories.
		const all = listSessions().map((s) => s.id);
		expect(all).toContain(a.id);
		expect(all).toContain(b.id);
	});

	it("still finds a legacy flat-file session (no cwd, saved directly under sessions/)", () => {
		const legacy = createSession("gpt-4o", projectA);
		delete (legacy as { cwd?: string }).cwd;
		saveSession(legacy); // cwd-less -> writes to the flat root, not a project subdir

		const loaded = loadSession(legacy.id);
		expect(loaded?.id).toBe(legacy.id);
		expect(loaded?.cwd).toBeUndefined();

		const all = listSessions().map((s) => s.id);
		expect(all).toContain(legacy.id);
	});

	it("deleteSession removes a nested session and reports success", () => {
		const session = createSession("gpt-4o", projectA);
		saveSession(session);

		expect(deleteSession(session.id)).toBe(true);
		expect(loadSession(session.id)).toBeNull();
		expect(listSessions().map((s) => s.id)).not.toContain(session.id);
	});

	it("deleteSession returns false for an id that doesn't exist", () => {
		expect(deleteSession("no-such-session-id")).toBe(false);
	});

	it("deleteSession doesn't touch other sessions in the same or other projects", () => {
		const keep = createSession("gpt-4o", projectA);
		saveSession(keep);
		const other = createSession("gpt-4o", projectB);
		saveSession(other);
		const toDelete = createSession("gpt-4o", projectA);
		saveSession(toDelete);

		deleteSession(toDelete.id);

		const remaining = listSessions().map((s) => s.id);
		expect(remaining).toContain(keep.id);
		expect(remaining).toContain(other.id);
		expect(remaining).not.toContain(toDelete.id);
	});

	it("getMostRecentSession is cwd-scoped when given a path", async () => {
		// Two projects, each with its own latest session. The default
		// (no-cwd) lookup used to fall through to a global "most recent
		// across every project" — that was the bug cast -c inherited from
		// when sessions were the only resume handle, but it's not what
		// users expect: a session in project A should not auto-resume when
		// the user is in project B's cwd. `cast -c` passes cwd; this test
		// pins the per-cwd contract.
		const older = createSession("gpt-4o", projectA);
		saveSession(older);
		await new Promise((r) => setTimeout(r, 5));
		const newer = createSession("gpt-4o", projectB);
		saveSession(newer);

		// Scoped to projectA — finds the only session in that cwd.
		expect(getMostRecentSession(projectA)?.id).toBe(older.id);
		// Scoped to projectB — finds the newer one.
		expect(getMostRecentSession(projectB)?.id).toBe(newer.id);
		// A cwd with no saved session returns null (not "the most recent
		// from somewhere else") — that's the behaviour cast -c relies on
		// to refuse silently resuming an unrelated project.
		expect(getMostRecentSession("/nonexistent/cwd")).toBeNull();
	});

	it("listSessionSummaries builds the index and serves summaries from it", () => {
		const a = createSession("gpt-4o", projectA);
		a.messages.push({ role: "user", content: "hello alpha world" });
		saveSession(a);
		const b = createSession("gpt-4o", projectB);
		b.messages.push({ role: "user", content: "beta question" }, { role: "assistant", content: "beta answer" });
		saveSession(b);

		const summaries = listSessionSummaries();
		expect(summaries.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
		const sb = summaries.find((s) => s.id === b.id)!;
		expect(sb.msgCount).toBe(2);
		expect(sb.firstUserMessage).toBe("beta question");
		expect(sb.cwd).toBe(projectB);
	});

	it("searchSessionSummaries finds a session by message content via the FTS index", () => {
		const a = createSession("gpt-4o", projectA);
		a.messages.push({ role: "user", content: "hello alpha world" });
		saveSession(a);
		const b = createSession("gpt-4o", projectB);
		b.messages.push({ role: "user", content: "beta question" }, { role: "assistant", content: "beta answer" });
		saveSession(b);

		expect(searchSessionSummaries("beta answer").map((s) => s.id)).toEqual([b.id]);
		expect(searchSessionSummaries("nonexistent-term")).toEqual([]);
		expect(
			searchSessionSummaries("")
				.map((s) => s.id)
				.sort(),
		).toEqual([a.id, b.id].sort());
	});

	it("listSessionSummaries.msgCount excludes intermediate tool-call-only assistant steps", () => {
		const s = createSession("gpt-4o", projectA);
		s.messages.push(
			{ role: "user", content: "read a.ts" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
			} as unknown as Message,
			{ role: "tool", tool_call_id: "c1", content: "ok" } as unknown as Message,
			{ role: "assistant", content: "a.ts does X." },
		);
		saveSession(s);

		const summary = listSessionSummaries().find((x) => x.id === s.id)!;
		expect(summary.msgCount).toBe(2); // 1 user + 1 final reply, not 3
	});

	it("heals a stale index entry when the session file changes", async () => {
		const s = createSession("gpt-4o", projectA);
		s.messages.push({ role: "user", content: "original topic" });
		saveSession(s);
		listSessionSummaries(); // build index
		await new Promise((r) => setTimeout(r, 5)); // ensure mtime moves
		s.messages.push({ role: "assistant", content: "freshly added reply" });
		saveSession(s);

		const summary = listSessionSummaries().find((x) => x.id === s.id)!;
		expect(summary.msgCount).toBe(2);
		expect(searchSessionSummaries("freshly added reply").map((x) => x.id)).toEqual([s.id]);
	});

	it("prunes index entries for deleted sessions and survives a corrupt index", () => {
		const keep = createSession("gpt-4o", projectA);
		saveSession(keep);
		const gone = createSession("gpt-4o", projectB);
		saveSession(gone);
		listSessionSummaries(); // build index with both
		deleteSession(gone.id);
		expect(listSessionSummaries().map((s) => s.id)).toEqual([keep.id]);

		// Corrupt index → rebuilt silently, correct data still served.
		writeFileSync(join(fakeHome, ".cast", "sessions", "index.json"), "not json{");
		expect(listSessionSummaries().map((s) => s.id)).toEqual([keep.id]);
	});

	it("does not mistake index.json for a legacy flat session", () => {
		const s = createSession("gpt-4o", projectA);
		saveSession(s);
		listSessionSummaries(); // creates root-level index.json
		// Neither the full listing nor the summaries may pick the index up as a session.
		expect(listSessions().map((x) => x.id)).toEqual([s.id]);
		expect(listSessionSummaries().map((x) => x.id)).toEqual([s.id]);
		expect(getMostRecentSession()?.id).toBe(s.id);
	});

	it("recordCompaction flips superseded rows without deleting them, and getFullHistory still returns everything", () => {
		const s = createSession("gpt-4o", projectA);
		const m1: Message = { role: "user", content: "first" };
		const m2: Message = { role: "assistant", content: "second" };
		const m3: Message = { role: "user", content: "third" };
		s.messages.push(m1, m2, m3);
		saveSession(s);

		const marker: Message = { role: "system", content: "[Compacted context — 2 messages summarized]\nsummary" };
		const compacted = [marker, m3];
		recordCompaction(s, s.messages, compacted);
		s.messages = compacted;
		saveSession(s);

		// The model-facing working set is just the shrunk view.
		const reloaded = loadSession(s.id)!;
		expect(reloaded.messages).toEqual(compacted);

		// But nothing was actually deleted — full history still has all 4 rows
		// (the 3 original messages plus the marker). The marker sorts right
		// before the "recent" messages it precedes in the in-context view
		// (m3 kept going, m1/m2 folded into it), not strictly by insertion time.
		const full = getFullHistory(s.id);
		expect(full).toEqual([m1, m2, marker, m3]);
	});

	it("keeps the durable checkpoint watermark stable across compaction seq shifts", () => {
		const s = createSession("gpt-4o", projectA);
		const m1: Message = { role: "user", content: "first" };
		const m2: Message = { role: "assistant", content: "second" };
		const m3: Message = { role: "user", content: "third" };
		s.messages.push(m1, m2, m3);
		saveSession(s);
		commitCheckpointWatermark(s.id, m3);
		const watermark = getCheckpointWatermark(s.id);
		expect(watermark).toBeTypeOf("string");

		recordCompaction(s, s.messages, [
			{ role: "system", content: "[Compacted context — 2 messages summarized]\nsummary" },
			m3,
		]);

		// The watermark is an immutable message id, so compaction shifts the seq
		// without moving it; the boundary and delta resolve the id to the live seq.
		expect(getCheckpointWatermark(s.id)).toBe(watermark);
		expect(findCheckpointBoundaryForMessages(s.id, [m3])).toBe(0);
		expect(getMessagesAfterCheckpoint(s.id)).toEqual([]);
	});

	it("clearSessionMessages deletes all message rows but keeps the session row", () => {
		const s = createSession("gpt-4o", projectA);
		s.messages.push({ role: "user", content: "hello" });
		saveSession(s);
		expect(getFullHistory(s.id)).toHaveLength(1);

		clearSessionMessages(s);
		saveSession(s);

		expect(getFullHistory(s.id)).toHaveLength(0);
		expect(loadSession(s.id)?.id).toBe(s.id);
	});

	it("a fresh system-prompt object every turn supersedes the previous one instead of piling up", () => {
		// loop.ts's syncSystemPrompt rebuilds messages[0] as a brand-new object
		// every turn, even when the text is identical — saveSession must treat
		// that as "replaces the old system row", not "another permanent
		// in-context row", or the working set balloons by one system message
		// per turn forever.
		const s = createSession("gpt-4o", projectA);
		s.messages = [
			{ role: "system", content: "SYS v1" },
			{ role: "user", content: "hi" },
		];
		saveSession(s);

		s.messages = [
			{ role: "system", content: "SYS v2" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		saveSession(s);

		const reloaded = loadSession(s.id)!;
		expect(reloaded.messages.filter((m) => m.role === "system")).toHaveLength(1);
		expect(reloaded.messages.find((m) => m.role === "system")?.content).toBe("SYS v2");

		// Nothing lost — the old system prompt is still in full history.
		const full = getFullHistory(s.id);
		expect(full.filter((m) => m.role === "system")).toHaveLength(2);
	});

	it("a repeated identical system-prompt object (unchanged text) does not write a duplicate row", () => {
		// Within one turn, syncSystemPrompt reruns on every tool-call round —
		// a fresh object each time, but usually with identical text. Full
		// history shouldn't grow a near-duplicate multi-KB row per round.
		const s = createSession("gpt-4o", projectA);
		s.messages = [
			{ role: "system", content: "SYS unchanged" },
			{ role: "user", content: "hi" },
		];
		saveSession(s);

		// Same text, new object — simulates the next tool-call round's rebuild.
		s.messages = [
			{ role: "system", content: "SYS unchanged" },
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "thinking..." },
		];
		saveSession(s);

		const full = getFullHistory(s.id);
		expect(full.filter((m) => m.role === "system")).toHaveLength(1);
	});

	it("persists per-message reasoning and survives a reload, re-keyed to full-history indices", () => {
		const s = createSession("gpt-4o", projectA);
		s.messages = [
			{ role: "user", content: "explain" },
			{ role: "assistant", content: "because X" },
		];
		// Web bridge sets this keyed by index into session.messages right
		// before saving (see bridge.ts's post-turn reasoning zip).
		s.reasoning = { 1: "thinking about X..." };
		saveSession(s);

		const { messages, reasoning } = getFullHistoryWithReasoning(s.id);
		expect(messages).toHaveLength(2);
		expect(reasoning[1]).toBe("thinking about X...");
		expect(reasoning[0]).toBeUndefined();

		// A plain loadSession (the in-context working set) also carries it.
		const reloaded = loadSession(s.id)!;
		expect(reloaded.reasoning?.[1]).toBe("thinking about X...");
	});

	it("persists per-turn provider/model/timing and survives a reload, re-keyed to full-history indices", () => {
		const s = createSession("gpt-4o", projectA);
		s.messages = [
			{ role: "user", content: "explain" },
			{ role: "assistant", content: "because X" },
		];
		// Web bridge sets this keyed by index into session.messages right
		// before saving (see bridge.ts's post-turn write, mirrors reasoning above).
		s.turnMeta = {
			1: { provider: "minimax", model: "MiniMax-M3", totalMs: 11700, completedAt: "2026-01-01T00:00:00.000Z" },
		};
		saveSession(s);

		const { messages, turnMeta } = getFullHistoryWithReasoning(s.id);
		expect(messages).toHaveLength(2);
		expect(turnMeta[1]).toEqual({
			provider: "minimax",
			model: "MiniMax-M3",
			totalMs: 11700,
			completedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(turnMeta[0]).toBeUndefined();

		// A plain loadSession (the in-context working set) also carries it.
		const reloaded = loadSession(s.id)!;
		expect(reloaded.turnMeta?.[1]?.model).toBe("MiniMax-M3");

		// getHistoryPage (the paginated view the web client actually reads)
		// carries it too, re-keyed to the page's own array indices.
		const page = getHistoryPage(s.id);
		expect(page.turnMeta[1]?.totalMs).toBe(11700);
	});

	it("getFullHistoryWithReasoning and getHistoryPage report the DB seq per message", () => {
		const s = createSession("gpt-4o", projectA);
		s.messages = [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "hello" },
		];
		saveSession(s);

		const full = getFullHistoryWithReasoning(s.id);
		expect(full.seqs).toHaveLength(2);
		expect(full.seqs[1]).toBeGreaterThan(full.seqs[0]!);

		const page = getHistoryPage(s.id);
		expect(page.seqs).toEqual(full.seqs);
	});

	describe("getMessageImage", () => {
		it("decodes the raw bytes back out of an image_url data: URL at the given seq/index", () => {
			const s = createSession("gpt-4o", projectA);
			const b64 = Buffer.from("not a real jpeg, just test bytes").toString("base64");
			s.messages = [
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64}` } }],
				} as unknown as Message,
			];
			saveSession(s);

			const { seqs } = getFullHistoryWithReasoning(s.id);
			const image = getMessageImage(s.id, seqs[0]!, 0);
			expect(image?.mimeType).toBe("image/jpeg");
			expect(image?.buffer.toString()).toBe("not a real jpeg, just test bytes");
		});

		it("returns undefined for a seq/index that doesn't hold an image", () => {
			const s = createSession("gpt-4o", projectA);
			s.messages = [{ role: "user", content: "just text" }];
			saveSession(s);

			const { seqs } = getFullHistoryWithReasoning(s.id);
			expect(getMessageImage(s.id, seqs[0]!, 0)).toBeUndefined();
			expect(getMessageImage(s.id, 999_999, 0)).toBeUndefined();
		});
	});

	it("getHistoryPage walks a long session back to front with no gaps or duplicates", () => {
		const s = createSession("gpt-4o", projectA);
		for (let i = 0; i < 50; i++) {
			s.messages.push({ role: "user", content: `q${i}` }, { role: "assistant", content: `a${i}` });
		}
		saveSession(s);

		const page1 = getHistoryPage(s.id, undefined, 5);
		expect(page1.messages).toHaveLength(10); // 5 turns * (user + assistant)
		expect(page1.messages.at(-1)).toEqual({ role: "assistant", content: "a49" });
		expect(page1.hasMore).toBe(true);

		let cursor = page1.oldestSeq;
		let hasMore = page1.hasMore;
		let total = page1.messages.length;
		let pages = 1;
		while (hasMore) {
			const p = getHistoryPage(s.id, cursor, 5);
			total += p.messages.length;
			cursor = p.oldestSeq;
			hasMore = p.hasMore;
			pages++;
		}
		expect(total).toBe(100); // 50 turns * 2 messages, nothing missed or duplicated
		expect(pages).toBe(10);
	});

	it("getHistoryPage never splits a tool_calls/tool pair across a page boundary", () => {
		const s = createSession("gpt-4o", projectA);
		for (let i = 0; i < 20; i++) {
			s.messages.push(
				{ role: "user", content: `q${i}` },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: "{}" } }],
				} as unknown as Message,
				{ role: "tool", tool_call_id: `c${i}`, content: "ok" } as unknown as Message,
				{ role: "assistant", content: `final${i}` },
			);
		}
		saveSession(s);

		let cursor: number | undefined;
		let hasMore = true;
		while (hasMore) {
			const p = getHistoryPage(s.id, cursor, 3);
			expect(p.messages[0]?.role).toBe("user"); // every page starts cleanly on a turn boundary
			const toolResultIds = new Set(
				p.messages.filter((m) => m.role === "tool").map((m) => (m as { tool_call_id: string }).tool_call_id),
			);
			for (const m of p.messages) {
				if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) continue;
				for (const tc of m.tool_calls) expect(toolResultIds.has(tc.id)).toBe(true);
			}
			cursor = p.oldestSeq;
			hasMore = p.hasMore;
		}
	});
});

describe("resetSessionContext", () => {
	it("keeps the full transcript visible while clearing only the model-facing context", () => {
		const session = createSession("gpt-4o", join(tmpdir(), "cast-clean-context-test"));
		session.messages.push(
			{ role: "user", content: "Build a release dashboard" },
			{ role: "assistant", content: "I will investigate." },
		);
		saveSession(session);

		expect(resetSessionContext(session)).toBe("Build a release dashboard");
		expect(session.messages).toEqual([]);
		saveSession(session);

		expect(loadSession(session.id)?.messages).toEqual([]);
		expect(getFullHistory(session.id)).toEqual([
			{ role: "user", content: "Build a release dashboard" },
			{ role: "assistant", content: "I will investigate." },
		]);
	});
});

describe("migrateLegacySessionsToDb", () => {
	let fakeHome: string;
	let realHome: string | undefined;
	let projectDir: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-migrate-test-"));
		process.env.HOME = fakeHome;
		resetDbConnectionForTests();
		projectDir = join(fakeHome, ".cast", "sessions", "--project-a--");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		resetDbConnectionForTests();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	/** Writes a pre-SQLite session file pair (metadata .json + messages
	 *  .jsonl) directly to disk — the on-disk shape migrateLegacySessionsToDb
	 *  has to import, independent of whatever the current saveSession writes. */
	function writeLegacySession(id: string, messages: Message[]): void {
		const meta = {
			id,
			model: "gpt-4o",
			cwd: join(fakeHome, "project-a"),
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cost: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				uncachedTokens: 0,
				subagentTokens: 0,
			},
		};
		writeFileSync(join(projectDir, `${id}.json`), JSON.stringify(meta), "utf-8");
		writeFileSync(join(projectDir, `${id}.jsonl`), `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`, "utf-8");
	}

	it("imports a legacy .json/.jsonl session pair into the database, leaving the source files untouched", () => {
		writeLegacySession("legacy-1", [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);

		const count = migrateLegacySessionsToDb();
		expect(count).toBe(1);

		const loaded = loadSession("legacy-1");
		expect(loaded?.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);

		// Source files are a rollback safety net — never touched.
		expect(existsSync(join(projectDir, "legacy-1.json"))).toBe(true);
		expect(existsSync(join(projectDir, "legacy-1.jsonl"))).toBe(true);
	});

	it("skips sessions whose id is already in the database", () => {
		writeLegacySession("legacy-2", [{ role: "user", content: "test" }]);
		migrateLegacySessionsToDb();

		// Second run finds the id already present — nothing new to import.
		const count = migrateLegacySessionsToDb();
		expect(count).toBe(0);
	});

	it("skips stray files without an id (config exports, partial saves) instead of crashing the whole migration", () => {
		// Stray file at the sessions root — picked up by legacySessionFilePaths
		// but lacks a real session id. Must not crash the import, must not insert.
		const strayPath = join(fakeHome, ".cast", "sessions", "stray-config.json");
		writeFileSync(strayPath, JSON.stringify({ model: "gpt-4o", cwd: "/somewhere", no_id_here: true }), "utf-8");

		// And a sibling with a non-string id (older schema quirk).
		const brokenPath = join(fakeHome, ".cast", "sessions", "broken.json");
		writeFileSync(brokenPath, JSON.stringify({ id: 42, model: "gpt-4o" }), "utf-8");

		const count = migrateLegacySessionsToDb();
		expect(count).toBe(0);

		// Both files still on disk (migration is additive, never destructive).
		expect(existsSync(strayPath)).toBe(true);
		expect(existsSync(brokenPath)).toBe(true);
	});
});

// ============================================================================
// listSessionSummaries — SQL-only aggregation
// ============================================================================
// The legacy path did a SELECT content_json FROM messages WHERE session_id = ?
// AND role IN ('user','assistant') ORDER BY seq for every session and then
// JSON.parsed every row — a 218-session DB with thousands of messages each
// paid 9 MB of content_json allocation plus 9000 JSON.parse calls per
// listing. The new path uses three group-by aggregates (covering index
// for user/assistant counts, a partial index for the with-tool-calls
// subtraction) and one MIN(seq) PK lookup per session for the first user
// message. The test below pins the contract: a session's full message
// history is never loaded for listing purposes — no message JSON.parse on
// the hot path even when the session is huge.
describe("listSessionSummaries — SQL-only aggregation", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let projectDir: string;
	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = join(tmpdir(), `cast-summaries-perf-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		process.env.HOME = fakeHome;
		resetDbConnectionForTests();
		projectDir = join(fakeHome, "projects", "perf");
		mkdirSync(projectDir, { recursive: true });
	});
	afterEach(() => {
		resetDbConnectionForTests();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("never reads content_json during a list — only aggregate queries + first-user lookup", () => {
		const s = createSession("gpt-4o", projectDir);
		// 200 messages, mostly tool-result clutter — any path that loads
		// them all in steady state is the regression we're guarding against.
		s.messages.push({ role: "user", content: "first user message that becomes the row description" });
		for (let i = 0; i < 50; i++) {
			s.messages.push({
				role: "assistant",
				content: null,
				tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: '{"path":"x"}' } }],
			} as unknown as Message);
			s.messages.push({ role: "tool", tool_call_id: `c${i}`, content: "tool result noise" } as unknown as Message);
			s.messages.push({ role: "user", content: `intermediate user ${i}` });
			s.messages.push({ role: "assistant", content: `final reply ${i}` });
		}
		saveSession(s);

		const db = getDb();
		const observedSqls: string[] = [];
		const realPrepare = db.prepare.bind(db);
		const spy = vi.spyOn(db, "prepare").mockImplementation((source: string) => {
			observedSqls.push(source);
			return realPrepare(source);
		});
		try {
			const summaries = listSessionSummaries();
			const summary = summaries.find((x) => x.id === s.id)!;
			// 51 user (1 initial + 50 intermediate) + 50 final-reply
			// assistant = 101. The 50 tool-call-only assistant steps are
			// excluded by the same countTurnMessages semantic.
			expect(summary.msgCount).toBe(101);
			expect(summary.firstUserMessage).toBe("first user message that becomes the row description");
		} finally {
			spy.mockRestore();
		}

		// The legacy path issued one SELECT content_json per session. With
		// 200 messages stuffed in, that would have read all 101 user/assistant
		// rows. Instead we see only the aggregate queries + first-user lookup.
		const contentJsonScans = observedSqls.filter((sql) =>
			/SELECT\s+content_json\s+FROM\s+messages\s+WHERE\s+session_id\s*=\s*\?/i.test(sql),
		);
		expect(contentJsonScans).toEqual([]);
		const fullHistoryScans = observedSqls.filter((sql) =>
			/SELECT\s+content_json\s+FROM\s+messages\s+WHERE\s+session_id\s+IN/i.test(sql),
		);
		expect(fullHistoryScans).toEqual([]);
		// The first-user lookup is one query per session, all using the
		// MIN(seq) JOIN — that's the only place content_json legitimately
		// appears, and it's O(N) index lookups, not a single bulk scan.
		const firstUserScans = observedSqls.filter((sql) => /MIN\(seq\)\s+AS\s+min_seq/i.test(sql));
		expect(firstUserScans.length).toBe(1);
	});

	it("firstUserMessage handles multi-line text and trimmed corners", () => {
		const s = createSession("gpt-4o", projectDir);
		s.messages.push({ role: "user", content: "  Hello\n\nWorld  " });
		s.messages.push({ role: "assistant", content: "reply" });
		saveSession(s);
		const summary = listSessionSummaries().find((x) => x.id === s.id)!;
		// Newlines flattened to spaces, surrounding whitespace trimmed. The
		// two-space run between "Hello" and "World" is preserved (only
		// \n is collapsed — same behavior as getFirstUserMessage).
		expect(summary.firstUserMessage).toBe("Hello  World");
	});
});
