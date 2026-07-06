import { describe, expect, it } from "vitest";
import { clampTailToRows } from "../src/ui/ChatLog.tsx";

describe("clampTailToRows", () => {
	it("returns text unchanged when it fits the row budget", () => {
		const text = "a\nb\nc";
		const r = clampTailToRows(text, 10, 80);
		expect(r.text).toBe(text);
		expect(r.hiddenLines).toBe(0);
		expect(r.usedRows).toBe(3);
	});

	it("keeps only the last N lines when over budget", () => {
		const text = ["l1", "l2", "l3", "l4", "l5"].join("\n");
		const r = clampTailToRows(text, 2, 80);
		expect(r.text).toBe("l4\nl5");
		expect(r.hiddenLines).toBe(3);
		expect(r.usedRows).toBe(2);
	});

	it("counts a wrapped long line as multiple rows", () => {
		// columns=10 → a 25-char line wraps to ceil(25/10)=3 rows.
		const long = "x".repeat(25);
		const text = `short\n${long}`;
		const r = clampTailToRows(text, 3, 10);
		// The long line alone costs 3 rows, filling the budget; "short" is dropped.
		expect(r.text).toBe(long);
		expect(r.hiddenLines).toBe(1);
		expect(r.usedRows).toBe(3);
	});

	it("always keeps at least the last line even if it exceeds the budget", () => {
		const long = "y".repeat(100);
		const r = clampTailToRows(long, 2, 10); // 100/10 = 10 rows > budget 2
		expect(r.text).toBe(long);
		expect(r.hiddenLines).toBe(0);
	});

	it("bounds a huge reasoning block to the budget (the actual bug scenario)", () => {
		const huge = Array.from({ length: 500 }, (_, i) => `reasoning line ${i}`).join("\n");
		const budget = 15;
		const r = clampTailToRows(huge, budget, 80);
		expect(r.usedRows).toBeLessThanOrEqual(budget);
		expect(r.text.split("\n").length).toBe(15);
		expect(r.hiddenLines).toBe(485);
		// The tail is preserved (most recent lines the user is watching).
		expect(r.text.endsWith("reasoning line 499")).toBe(true);
	});

	it("handles empty text", () => {
		expect(clampTailToRows("", 10, 80)).toEqual({ text: "", hiddenLines: 0, usedRows: 0 });
	});

	it("treats a non-positive budget as at least one line", () => {
		const r = clampTailToRows("a\nb\nc", 0, 80);
		expect(r.text).toBe("c");
		expect(r.hiddenLines).toBe(2);
	});
});
