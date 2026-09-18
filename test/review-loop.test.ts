import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { Message } from "../src/core/llm.ts";

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
const { buildReviewScope, startReviewState, readReviewState, clearReviewState } = await import("../src/core/review.ts");

const testConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "t",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 120_000,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
};

const SESSION = "review-loop-session";
let fakeHome: string;
let realHome: string | undefined;
let fakeDb: string;
let realDb: string | undefined;
let repo: string;

beforeEach(async () => {
	vi.mocked(streamAndCollect).mockClear();
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "cast-review-loop-home-"));
	process.env.HOME = fakeHome;
	realDb = process.env.CAST_SESSIONS_DB;
	fakeDb = join(mkdtempSync(join(tmpdir(), "cast-review-loop-db-")), "sessions.db");
	process.env.CAST_SESSIONS_DB = fakeDb;
	resetDbConnectionForTests();

	// A scope with one real file, so review_report has something to verify against.
	repo = mkdtempSync(join(tmpdir(), "cast-review-loop-repo-"));
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
	await startReviewState(SESSION, repo, {
		files: [{ path: "src/a.ts", status: "modified", changedLines: 2 }],
		skipped: [],
		groups: [],
		rules: [],
		range: "working tree vs HEAD",
	} as Awaited<ReturnType<typeof buildReviewScope>>);
});

afterEach(() => {
	clearReviewState(SESSION);
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	if (realDb === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = realDb;
	resetDbConnectionForTests();
	rmSync(fakeHome, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
	rmSync(join(fakeDb, ".."), { recursive: true, force: true });
});

const stop = () => ({ content: "done", thinking: "", finishReason: "stop" as const });

function reportCall(findings: unknown[]) {
	return () => ({
		content: "",
		thinking: "",
		finishReason: "tool_calls" as const,
		toolCalls: [{ id: "r-1", name: "review_report", arguments: JSON.stringify({ findings }) }],
	});
}

async function run(onWarning: (message: string) => void = () => {}): Promise<void> {
	await runAgentLoop([{ role: "user", content: "review" }], {
		config: testConfig,
		model: "test-model",
		cwd: repo,
		systemPrompt: "base",
		sessionId: SESSION,
		onEvent: () => {},
		onWarning,
	});
}

describe("runAgentLoop — open code review", () => {
	it("offers review_report while a review is open", async () => {
		let toolNames: string[] = [];
		vi.mocked(streamAndCollect).mockImplementationOnce(async (_c, _m, _msgs, tools) => {
			toolNames = tools.map((tool: { function: { name: string } }) => tool.function.name);
			return stop();
		});
		await run();
		expect(toolNames).toContain("review_report");
	});

	// Measured on nine public pull requests: four reviewed the diff and wrote
	// the conclusion as prose, so no line was ever checked against a file.
	it("asks once when the turn would end without the findings being checked", async () => {
		const seen: string[] = [];
		const record = async (_c: unknown, _m: unknown, messages: Message[]) => {
			seen.push(String(messages[messages.length - 1]?.content ?? ""));
			return stop();
		};
		vi.mocked(streamAndCollect).mockImplementationOnce(record).mockImplementationOnce(record);

		const warnings: string[] = [];
		await run((message) => warnings.push(message));

		expect(seen[1]).toContain("hasn't gone through `review_report`");
		// Asked once, not twice — the second pass ends the turn.
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(warnings.some((w) => w.includes("never checked against the files"))).toBe(true);
		// The scope is closed rather than left for a later turn to check
		// against a diff that has moved on.
		expect(readReviewState(SESSION)).toBeUndefined();
	});

	it("does not ask when the findings already went through the tool", async () => {
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(reportCall([{ path: "src/a.ts", line: 2, quote: "const b = 2;", issue: "unused" }]))
			.mockImplementationOnce(stop);

		const warnings: string[] = [];
		await run((message) => warnings.push(message));

		// Two passes: the tool call and the summary after it. No reminder.
		expect(vi.mocked(streamAndCollect)).toHaveBeenCalledTimes(2);
		expect(warnings).toHaveLength(0);
		expect(readReviewState(SESSION)).toBeUndefined();
	});

	it("treats an empty report as a real answer, not a missing one", async () => {
		let toolResult = "";
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(reportCall([]))
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				toolResult = String(messages[messages.length - 1]?.content ?? "");
				return stop();
			});

		const warnings: string[] = [];
		await run((message) => warnings.push(message));

		expect(toolResult).toContain("No findings recorded");
		expect(warnings).toHaveLength(0);
	});

	it("verifies the positions it is given and says what moved", async () => {
		let toolResult = "";
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(
				reportCall([
					{ path: "src/a.ts", line: 1, quote: "const b = 2;", issue: "drifted" },
					{ path: "src/a.ts", line: 1, quote: "nowhere()", issue: "invented" },
				]),
			)
			.mockImplementationOnce(async (_c: unknown, _m: unknown, messages: Message[]) => {
				toolResult = String(messages[messages.length - 1]?.content ?? "");
				return stop();
			});
		await run();

		expect(toolResult).toContain("1 stand, 1 dropped");
		expect(toolResult).toContain("relocated — src/a.ts:2");
	});
});
