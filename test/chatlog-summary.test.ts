import { describe, expect, it } from "vitest";
import { parseToolSummary } from "../src/ui/ChatLog.tsx";

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
