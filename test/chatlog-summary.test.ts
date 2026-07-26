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
