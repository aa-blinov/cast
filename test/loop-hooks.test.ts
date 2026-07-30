/**
 * Real, end-to-end coverage for hooks wired through the agent loop
 * (`runToolWithHooks` in loop.ts) — as opposed to test/hooks.test.ts, which
 * exercises `runHooksForEvent` directly. These spawn real bash processes via
 * a real `bash` tool call inside a real `runAgentLoop` run; only the LLM
 * call itself is stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { HooksFile } from "../src/core/hooks.ts";
import type { Message } from "../src/core/llm.ts";

vi.mock("../src/core/llm.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/llm.ts")>();
	return {
		...actual,
		createClient: () => ({}),
		streamAndCollect: vi.fn(),
	};
});

const { runAgentLoop } = await import("../src/core/loop.ts");
const { streamAndCollect } = await import("../src/core/llm.ts");
type AgentEvent = Parameters<Parameters<typeof runAgentLoop>[1]["onEvent"]>[0];

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

function toolMessage(messages: Message[]): { role: "tool"; tool_call_id: string; content: string } {
	const m = messages.find((msg) => msg.role === "tool") as
		| { role: "tool"; tool_call_id: string; content: string }
		| undefined;
	if (!m) throw new Error("no tool message found");
	return m;
}

describe("runAgentLoop — PostToolUse hook blocking (real bash spawn)", () => {
	it("appends the hook's reason to a normal exit-2-with-stderr block", async () => {
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const hooks: HooksFile = {
			PostToolUse: [{ hooks: [{ command: "echo 'formatting failed' 1>&2; exit 2" }] }],
		};

		const messages = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			hooks,
			onEvent: () => {},
		});

		expect(toolMessage(messages).content).toContain("[Hook feedback: formatting failed]");
	});

	it("REGRESSION: still surfaces a block when the hook exits 2 with zero output (no reason)", async () => {
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo hi" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		// No stdout, no stderr — interpretHookOutput's `reason` comes out
		// undefined. Before the fix, `if (post.blocked && post.reason)` was
		// false here and the block vanished with zero trace: the tool
		// message below would've been the bare "hi\n" from `echo hi`, as if
		// the hook had never run at all.
		const hooks: HooksFile = {
			PostToolUse: [{ hooks: [{ command: "exit 2" }] }],
		};

		const messages = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			hooks,
			onEvent: () => {},
		});

		const content = toolMessage(messages).content;
		expect(content).toContain("[Hook feedback:");
		expect(content).toContain('Blocked by a PostToolUse hook for "bash"');
	});

	it("labels the fallback message PostToolUseFailure when the tool itself errored", async () => {
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				// `nonexistent_tool_xyz` isn't a real command — bash exits non-zero, isError: true.
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "nonexistent_tool_xyz" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const hooks: HooksFile = {
			PostToolUseFailure: [{ hooks: [{ command: "exit 2" }] }],
		};

		const messages = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			hooks,
			onEvent: () => {},
		});

		expect(toolMessage(messages).content).toContain('Blocked by a PostToolUseFailure hook for "bash"');
	});
});

describe("runAgentLoop — PreToolUse hook blocking (real bash spawn)", () => {
	it("blocks the tool call outright and never runs the command", async () => {
		const events: AgentEvent[] = [];
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo should-not-run" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const hooks: HooksFile = {
			PreToolUse: [{ hooks: [{ command: "exit 2" }] }],
		};

		const messages = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			hooks,
			onEvent: (e) => events.push(e),
		});

		const content = toolMessage(messages).content;
		expect(content).toContain('Blocked by a PreToolUse hook for "bash"');
		expect(content).not.toContain("should-not-run");
		const toolEnd = events.find((e) => e.type === "tool_end");
		expect(toolEnd && "result" in toolEnd ? toolEnd.result.isError : undefined).toBe(true);
	});

	it("updatedInput from a PreToolUse hook actually rewrites the args the tool runs with", async () => {
		vi.mocked(streamAndCollect)
			.mockImplementationOnce(async () => ({
				content: "",
				thinking: "",
				finishReason: "stop",
				toolCalls: [{ id: "t1", name: "bash", arguments: JSON.stringify({ command: "echo original" }) }],
			}))
			.mockImplementationOnce(async () => ({ content: "done", thinking: "", finishReason: "stop" }));

		const hooks: HooksFile = {
			PreToolUse: [
				{
					hooks: [
						{
							command: 'echo \'{"hookSpecificOutput":{"updatedInput":{"command":"echo rewritten"}}}\'',
						},
					],
				},
			],
		};

		const messages = await runAgentLoop([{ role: "user", content: "go" }], {
			config: testConfig,
			model: "test-model",
			cwd: process.cwd(),
			systemPrompt: "test",
			hooks,
			onEvent: () => {},
		});

		expect(toolMessage(messages).content).toContain("rewritten");
		expect(toolMessage(messages).content).not.toContain("original");
	});
});
