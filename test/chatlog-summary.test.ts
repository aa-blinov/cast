import { renderToString } from "ink";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ChatLog, parseToolSummary } from "../src/ui/ChatLog.tsx";

describe("ChatLog tool rows", () => {
	it("renders real bash and MCP events as summaries without either result payload", () => {
		const output = renderToString(
			createElement(ChatLog, {
				messages: [
					{
						role: "assistant",
						content: "",
						blocks: [
							{
								kind: "tool",
								call: {
									id: "bash-1",
									name: "bash",
									args: JSON.stringify({ command: "git status --short" }),
									status: "ok",
									result: "MUTATED_RESULT_MUST_NOT_RENDER",
								},
							},
							{
								kind: "tool",
								call: {
									id: "mcp-1",
									name: "mcp_workspace_search",
									args: JSON.stringify({ query: "authentication" }),
									status: "error",
									result: "MCP_ERROR_PAYLOAD_MUST_NOT_RENDER",
								},
							},
						],
					},
				],
				streaming: null,
				error: null,
				retry: null,
				columns: 120,
			}),
			{ columns: 120 },
		);

		expect(output).toContain("[bash] [ok]");
		expect(output).toContain('command="git status --short"');
		expect(output).toContain("[workspace · search] [error]");
		expect(output).toContain('query="authentication"');
		expect(output).not.toContain("MUTATED_RESULT_MUST_NOT_RENDER");
		expect(output).not.toContain("MCP_ERROR_PAYLOAD_MUST_NOT_RENDER");
	});

	it("keeps the loader visible while hidden reasoning is the only live output", () => {
		const output = renderToString(
			createElement(ChatLog, {
				messages: [],
				streaming: { blocks: [{ kind: "thinking", text: "private reasoning" }] },
				error: null,
				retry: null,
				columns: 120,
				showReasoning: false,
			}),
			{ columns: 120 },
		);

		expect(output).toContain("⠋");
		expect(output).not.toContain("private reasoning");
	});

	it("keeps the loader after visible text until a tool starts or the turn ends", () => {
		const output = renderToString(
			createElement(ChatLog, {
				messages: [],
				streaming: { blocks: [{ kind: "content", text: "I will check that now." }] },
				error: null,
				retry: null,
				columns: 120,
				showReasoning: false,
			}),
			{ columns: 120 },
		);

		expect(output).toContain("I will check that now.");
		expect(output).toContain("⠋");
	});

	it("uses a running tool row instead of an extra loader", () => {
		const output = renderToString(
			createElement(ChatLog, {
				messages: [],
				streaming: {
					blocks: [{ kind: "tool", call: { id: "bash-1", name: "bash", args: "{}", status: "running" } }],
				},
				error: null,
				retry: null,
				columns: 120,
				showReasoning: false,
			}),
			{ columns: 120 },
		);

		expect(output).toContain("[bash] [running]");
		expect(output).not.toContain("⠋");
	});
});

describe("parseToolSummary — edit +added/-removed", () => {
	it("counts newString lines as added and oldString lines as removed", () => {
		const args = JSON.stringify({ filePath: "x.ts", oldString: "a\nb", newString: "x\ny\nz" });
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 3, removed: 2 });
	});

	it("treats an empty oldString (new-file creation) as zero removed", () => {
		const args = JSON.stringify({ filePath: "x.ts", oldString: "", newString: "line1\nline2" });
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 2, removed: 0 });
	});

	it("treats an empty newString (deletion) as zero added", () => {
		const args = JSON.stringify({ filePath: "x.ts", oldString: "line1\nline2", newString: "" });
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 0, removed: 2 });
	});
});

describe("parseToolSummary — todo_write", () => {
	it("summarizes as N/M done plus the in_progress item, not a raw JSON dump", () => {
		const args = JSON.stringify({
			todos: [
				{ content: "Fix the bug", status: "completed", priority: "high" },
				{ content: "Write the tests", status: "in_progress", priority: "high" },
				{ content: "Update the docs", status: "pending", priority: "medium" },
			],
		});
		expect(parseToolSummary("todo_write", args)).toEqual({ kind: "generic", text: "1/3 done — Write the tests" });
	});

	it("omits the dash suffix when nothing is in_progress", () => {
		const args = JSON.stringify({
			todos: [
				{ content: "a", status: "completed", priority: "low" },
				{ content: "b", status: "completed", priority: "low" },
			],
		});
		expect(parseToolSummary("todo_write", args)).toEqual({ kind: "generic", text: "2/2 done" });
	});

	it("falls back to the generic JSON dump when args don't parse as a todo list", () => {
		expect(parseToolSummary("todo_write", "not json")).toEqual({ kind: "generic", text: "not json" });
	});
});
