import { describe, expect, it } from "vitest";
import { parseToolSummary } from "../src/ui/ChatLog.tsx";

describe("parseToolSummary — edit +added/-removed", () => {
	it("counts insert_after content as added lines", () => {
		const args = JSON.stringify({
			path: "x.ts",
			ops: [{ op: "insert_after", anchor: "5:abc:def", content: "line1\nline2" }],
		});
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 2, removed: 0 });
	});

	it("counts insert_before content as added lines too", () => {
		// insert_before used to have no matching branch at all — the loop
		// silently skipped it, so any edit call using only insert_before ops
		// always displayed "+0 -0" regardless of how much content was
		// actually inserted.
		const args = JSON.stringify({
			path: "x.ts",
			ops: [{ op: "insert_before", anchor: "5:abc:def", content: "line1\nline2\nline3" }],
		});
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 3, removed: 0 });
	});

	it("approximates replace churn from the anchor range plus new content length", () => {
		const args = JSON.stringify({
			path: "x.ts",
			ops: [{ op: "replace", anchor: "10:abc:def", end_anchor: "12:ghi:jkl", content: "a\nb" }],
		});
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 2, removed: 3 });
	});

	it("sums added/removed across multiple ops in one call", () => {
		const args = JSON.stringify({
			path: "x.ts",
			ops: [
				{ op: "insert_after", anchor: "1:aaa:bbb", content: "x" },
				{ op: "insert_before", anchor: "5:ccc:ddd", content: "y\nz" },
				{ op: "replace", anchor: "10:eee:fff", content: "w" },
			],
		});
		expect(parseToolSummary("edit", args)).toEqual({ kind: "edit", path: "x.ts", added: 4, removed: 1 });
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
