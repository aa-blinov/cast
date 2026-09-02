import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInteractiveAction, runNonInteractive } from "../src/core/run.ts";

// runNonInteractive is a thin SSE client over the daemon — stub the transport
// so the event stream can be replayed exactly, which is what its stdout/exit
// contract is made of.
const mockSubscribe = vi.fn();
vi.mock("../src/server/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/server/client.ts")>();
	return {
		...actual,
		ensureServerClient: async () => ({ baseUrl: "http://127.0.0.1:0", token: "t" }),
		ensureServerSession: async () => ({ id: "sess-1" }),
		submitServerChat: async () => undefined,
		subscribeServerEvents: (...args: unknown[]) => mockSubscribe(...args),
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

describe("one-shot run exit contract", () => {
	function replay(replayed: Array<Record<string, unknown>>): void {
		mockSubscribe.mockImplementation((_client, _id, onEvent: (e: unknown) => void) => {
			for (const event of replayed) onEvent(event);
			return { done: Promise.resolve(), close: () => {} };
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
});
