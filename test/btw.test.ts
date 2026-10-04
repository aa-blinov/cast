import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	askSideQuestion,
	completeHistory,
	describeInFlight,
	SideQuestionError,
	sideQuestionMessages,
} from "../src/core/btw.ts";
import type { AppConfig } from "../src/core/config.ts";
import { type Message, streamAndCollect } from "../src/core/llm.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/llm.ts")>()),
	streamAndCollect: vi.fn(),
}));

const config: AppConfig = {
	baseURL: "https://example.test/v1",
	apiKey: "k",
	contextWindow: 100_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.8,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeoutMs: 10_000,
	reasoningParams: { body: {}, enabled: false },
} as AppConfig;

const history: Message[] = [
	{ role: "system", content: "old system" },
	{ role: "user", content: "refactor the parser" },
	{ role: "assistant", content: "Done: parser.ts now has two passes." },
];

beforeEach(() => {
	vi.mocked(streamAndCollect).mockReset();
});

describe("completeHistory", () => {
	it("drops system messages and keeps a conversation whose tool calls were all answered", () => {
		const full: Message[] = [
			...history,
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
		];
		expect(completeHistory(full)).toEqual(full.slice(1));
	});

	it("stops before an assistant message whose tool call has no result yet", () => {
		const open: Message[] = [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
			},
		];
		expect(completeHistory(open)).toEqual([open[0]]);
	});
});

describe("describeInFlight", () => {
	it("says what the running turn has said and done, newest last, and nothing when there is none", () => {
		expect(describeInFlight(undefined)).toBe("");
		expect(describeInFlight([{ kind: "thinking", text: "hmm" }])).toBe("");
		const text = describeInFlight([
			{ kind: "content", text: "Let me run the tests." },
			{ kind: "tool", call: { name: "bash", args: '{"command":"npm test"}', status: "running" } },
			{ kind: "tool", call: { name: "read", args: '{"path":"a.ts"}', status: "ok", result: "file body" } },
		]);
		expect(text).toContain("The assistant said: Let me run the tests.");
		expect(text).toContain('The tool bash {"command":"npm test"} is running.');
		expect(text).toContain("The tool read");
		expect(text).toContain("finished (ok). Result: file body");
	});

	it("keeps the end of a long account, the part closest to now", () => {
		const text = describeInFlight([{ kind: "content", text: `${"x".repeat(9_000)}THE-END` }]);
		expect(text.length).toBeLessThan(4_100);
		expect(text.endsWith("THE-END")).toBe(true);
	});
});

describe("sideQuestionMessages", () => {
	it("is the system prompt, the conversation, then the question framed as a side question", () => {
		const messages = sideQuestionMessages("SYSTEM", history, "what did you change?", "The tool bash is running.");
		expect(messages[0]).toEqual({ role: "system", content: "SYSTEM" });
		expect(messages.slice(1, 3)).toEqual(history.slice(1));
		const last = String(messages.at(-1)!.content);
		expect(last).toContain("side question");
		expect(last).toContain("You have no tools");
		expect(last).toContain("The turn in progress");
		expect(last).toContain("The tool bash is running.");
		expect(last.endsWith("what did you change?")).toBe(true);
	});
});

describe("askSideQuestion", () => {
	it("asks the model with no tools, returns its answer, and leaves the conversation as it was", async () => {
		vi.mocked(streamAndCollect).mockResolvedValue({
			content: "  Two passes.  ",
			finishReason: "stop",
			usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
		} as never);
		const before = JSON.stringify(history);
		const answer = await askSideQuestion(
			{ config, model: "m", systemPrompt: "SYSTEM", history, sessionId: "s1" },
			"how many passes?",
		);
		expect(answer.text).toBe("Two passes.");
		expect(answer.usage?.totalTokens).toBe(13);
		const call = vi.mocked(streamAndCollect).mock.calls[0]!;
		expect(call[1]).toBe("m");
		expect(call[3]).toEqual([]);
		expect(String((call[2] as Message[]).at(-1)!.content)).toContain("how many passes?");
		expect(JSON.stringify(history)).toBe(before);
		expect(call[12]).toEqual({ sessionId: "s1", purpose: "btw" });
	});

	it("says so when the model returned nothing, instead of showing an empty answer", async () => {
		vi.mocked(streamAndCollect).mockResolvedValue({ content: "  ", finishReason: "length" } as never);
		const answer = await askSideQuestion({ config, model: "m", systemPrompt: "S", history }, "q");
		expect(answer.text).toContain("gave no answer");
	});

	it("refuses a conversation that fills the window, and does not call the model", async () => {
		const huge: Message[] = [{ role: "user", content: "x".repeat(500_000) }];
		await expect(askSideQuestion({ config, model: "m", systemPrompt: "S", history: huge }, "q")).rejects.toThrow(
			/run \/compact first/,
		);
		expect(streamAndCollect).not.toHaveBeenCalled();
	});

	it("reports a provider error and a stop as errors of its own kind", async () => {
		vi.mocked(streamAndCollect).mockRejectedValue(new Error("429 slow down"));
		const failure = await askSideQuestion({ config, model: "m", systemPrompt: "S", history }, "q").catch(
			(e: unknown) => e,
		);
		expect(failure).toBeInstanceOf(SideQuestionError);
		expect((failure as Error).message).toBe("429 slow down");
		const controller = new AbortController();
		controller.abort();
		await expect(
			askSideQuestion({ config, model: "m", systemPrompt: "S", history, signal: controller.signal }, "q"),
		).rejects.toThrow("Stopped.");
	});
});
