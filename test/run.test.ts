import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseInteractiveAction,
	parseInteractiveRequest,
	runNonInteractive,
	turnOverPredicate,
} from "../src/core/run.ts";

// runNonInteractive is a thin SSE client over the daemon — stub the transport
// so the event stream can be replayed exactly, which is what its stdout/exit
// contract is made of.
const mockSubscribe = vi.fn();
const mockClient = vi.fn(
	async (): Promise<{ baseUrl: string; token: string } | undefined> => ({ baseUrl: "http://127.0.0.1:0", token: "t" }),
);
const mockAnswerConfirm = vi.fn(async () => undefined);
const mockEnsureSession = vi.fn(async (..._args: unknown[]) => ({ id: "sess-1", resumed: false }));
const mockFetch = vi.fn(async (..._args: unknown[]) => ({ status: 404, data: null }));
vi.mock("../src/server/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/server/client.ts")>();
	return {
		...actual,
		ensureServerClient: () => mockClient(),
		ensureServerSession: (...args: unknown[]) => mockEnsureSession(...args),
		serverFetch: (...args: unknown[]) => mockFetch(...args),
		submitServerChat: async () => undefined,
		subscribeServerEvents: (...args: unknown[]) => mockSubscribe(...args),
		answerServerBashConfirm: (...args: unknown[]) => mockAnswerConfirm(...(args as [])),
	};
});

describe("interactive run protocol", () => {
	it("accepts each supported action", () => {
		expect(parseInteractiveAction('{"type":"prompt","text":"inspect the project"}')).toEqual({
			type: "prompt",
			text: "inspect the project",
		});
		expect(parseInteractiveAction('{"type":"set_mode","mode":"plan"}')).toEqual({ type: "set_mode", mode: "plan" });
		expect(parseInteractiveAction('{"type":"answer_question","values":["a","b"]}')).toEqual({
			type: "answer_question",
			values: ["a", "b"],
		});
		expect(parseInteractiveAction('{"type":"plan_review","choice":"clean"}')).toEqual({
			type: "plan_review",
			choice: "clean",
		});
	});

	it("rejects malformed picker actions before touching a session", () => {
		expect(() => parseInteractiveAction('{"type":"prompt"}')).toThrow("prompt.text must be a string");
		expect(() => parseInteractiveAction('{"type":"answer_question","values":[1]}')).toThrow(
			"answer_question.values must be an array of strings",
		);
		expect(() => parseInteractiveAction('{"type":"plan_review","choice":"discard"}')).toThrow(
			"plan_review.choice must be continue, implement, or clean",
		);
	});
});

describe("interactive run protocol: ids and abort", () => {
	it("carries the caller's id (string or number) with the action, and accepts abort", () => {
		expect(parseInteractiveRequest('{"id":"r1","type":"state"}')).toEqual({ id: "r1", action: { type: "state" } });
		expect(parseInteractiveRequest('{"id":7,"type":"abort"}')).toEqual({ id: "7", action: { type: "abort" } });
		expect(parseInteractiveRequest('{"type":"exit"}')).toEqual({ action: { type: "exit" } });
	});
});

describe("when a turn is over for the client", () => {
	it("counts a failed turn (error, then status error) as over, but not the daemon's snapshot of an earlier failure", () => {
		const over = turnOverPredicate();
		// The first status a subscription gets is the session as it stands: still `error` from the last turn.
		expect(over({ type: "status", status: "error" } as never)).toBe(false);
		expect(over({ type: "status", status: "running" } as never)).toBe(false);
		expect(over({ type: "error", message: "boom" } as never)).toBe(false);
		expect(over({ type: "status", status: "error" } as never)).toBe(true);
	});

	it("counts session_end and a non-stop end as over, and a clean stop as not yet", () => {
		expect(turnOverPredicate()({ type: "session_end" } as never)).toBe(true);
		expect(turnOverPredicate()({ type: "end", reason: "disconnected" } as never)).toBe(true);
		expect(turnOverPredicate()({ type: "end", reason: "stop" } as never)).toBe(false);
		expect(turnOverPredicate()({ type: "end", reason: "aborted" } as never)).toBe(false);
	});
});

describe("one-shot run exit contract", () => {
	function replay(replayed: Array<Record<string, unknown>>): void {
		mockSubscribe.mockImplementation((_client, _id, onEvent: (e: unknown) => void) => {
			for (const event of replayed) onEvent(event);
			return { done: Promise.resolve("until"), ready: Promise.resolve(), close: () => {} };
		});
	}

	beforeEach(() => {
		process.exitCode = undefined;
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
	});

	it("exits non-zero when the provider cuts the stream mid-answer", async () => {
		// loop.ts emits reason "disconnected" precisely so a truncated answer
		// isn't mistaken for a clean exit; `out=$(cast run …)` can only see it
		// through the exit code.
		replay([
			{ type: "token", text: "partial ans" },
			{ type: "end", reason: "disconnected" },
		]);
		await runNonInteractive({} as never, { message: "hi", format: "text" } as never);
		expect(process.exitCode).toBe(1);
	});

	it("still exits zero on a clean stop", async () => {
		replay([
			{ type: "token", text: "done" },
			{ type: "end", reason: "stop" },
		]);
		await runNonInteractive({} as never, { message: "hi", format: "text" } as never);
		expect(process.exitCode).toBeUndefined();
	});

	it("surfaces a notice (the runaway-loop cap, a refusal) on stderr instead of dropping it", async () => {
		replay([
			{ type: "notice", message: "Turn hit the iteration safety cap (40) — stopping." },
			{ type: "end", reason: "stop" },
		]);
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		await runNonInteractive({} as never, { message: "hi", format: "text" } as never);
		expect(written.join("")).toContain("iteration safety cap");
	});

	it("answers a confirmation no one here can give with a no, at once, and says why", async () => {
		replay([
			{ type: "bash_confirm", id: "c1", command: "read /etc/hosts", reason: "outside the project" },
			{ type: "end", reason: "stop" },
		]);
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		await runNonInteractive({} as never, { message: "hi", format: "text" } as never);
		expect(mockAnswerConfirm).toHaveBeenCalledWith(expect.anything(), "sess-1", "c1", false);
		expect(written.join("")).toContain("read /etc/hosts needs confirmation (outside the project)");
	});
	it("exits non-zero and says so when the daemon connection drops before the turn is over", async () => {
		mockSubscribe.mockImplementation((_client, _id, onEvent: (e: unknown) => void) => {
			onEvent({ type: "token", text: "partial" });
			return { done: Promise.resolve("closed"), ready: Promise.resolve(), close: () => {} };
		});
		const written: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		});
		await runNonInteractive({} as never, { message: "hi", format: "text" } as never);
		expect(process.exitCode).toBe(1);
		expect(written.join("")).toContain("Lost the connection to the cast daemon");
	});

	it("exits 2 for a persona the daemon does not have, listing the ones it does", async () => {
		replay([{ type: "end", reason: "stop" }]);
		mockFetch.mockResolvedValueOnce({ status: 200, data: [{ name: "senior" }, { name: "qa" }] });
		await expect(
			runNonInteractive({ cliPersona: "nosuch" } as never, { message: "hi", format: "text" } as never),
		).rejects.toThrow('unknown persona "nosuch". Available: senior, qa');
	});

	it("asks the daemon to fail, not to start a new session, when -c has nothing to continue", async () => {
		replay([{ type: "end", reason: "stop" }]);
		mockEnsureSession.mockClear();
		await runNonInteractive({ resumeRequested: true } as never, { message: "hi", format: "text" } as never);
		expect(mockEnsureSession.mock.calls[0]?.[1]).toMatchObject({ requireResume: true });
		mockEnsureSession.mockClear();
		await runNonInteractive(
			{ resumeRequested: true, resumeId: "abc" } as never,
			{ message: "hi", format: "text" } as never,
		);
		expect(mockEnsureSession.mock.calls[0]?.[1]).toMatchObject({ requireResume: false });
	});
	it("says the daemon did not start, or that CAST_NO_DAEMON turned it off, instead of one message for both", async () => {
		mockClient.mockResolvedValueOnce(undefined);
		await expect(runNonInteractive({} as never, { message: "hi", format: "text" } as never)).rejects.toThrow(
			"cast run could not reach the cast daemon: it did not start",
		);
		const before = process.env.CAST_NO_DAEMON;
		process.env.CAST_NO_DAEMON = "1";
		try {
			mockClient.mockResolvedValueOnce(undefined);
			await expect(runNonInteractive({} as never, { message: "hi", format: "text" } as never)).rejects.toThrow(
				"CAST_NO_DAEMON=1 turns it off",
			);
		} finally {
			if (before === undefined) delete process.env.CAST_NO_DAEMON;
			else process.env.CAST_NO_DAEMON = before;
		}
	});
});
