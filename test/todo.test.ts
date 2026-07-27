import { describe, expect, it } from "vitest";
import { formatTodoList, remainingTodoCount, validateTodos } from "../src/core/todo.ts";

describe("validateTodos", () => {
	it("accepts a well-formed list", () => {
		const result = validateTodos([
			{ content: "Do the thing", status: "in_progress", priority: "high" },
			{ content: "Then this", status: "pending", priority: "medium" },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.todos).toHaveLength(2);
			expect(result.todos[0]).toEqual({ content: "Do the thing", status: "in_progress", priority: "high" });
		}
	});

	it("trims content and accepts an empty list", () => {
		const result = validateTodos([{ content: "  padded  ", status: "pending", priority: "low" }]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.todos[0]?.content).toBe("padded");
		expect(validateTodos([])).toEqual({ ok: true, todos: [] });
	});

	it("rejects a non-array", () => {
		const result = validateTodos("not an array");
		expect(result.ok).toBe(false);
	});

	it("rejects empty content", () => {
		const result = validateTodos([{ content: "  ", status: "pending", priority: "low" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("content");
	});

	it("rejects an invalid status", () => {
		const result = validateTodos([{ content: "x", status: "done", priority: "low" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("status");
	});

	it("rejects an invalid priority", () => {
		const result = validateTodos([{ content: "x", status: "pending", priority: "urgent" }]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("priority");
	});

	it("rejects more than one in_progress item", () => {
		const result = validateTodos([
			{ content: "a", status: "in_progress", priority: "high" },
			{ content: "b", status: "in_progress", priority: "low" },
		]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("in_progress");
	});
});

describe("formatTodoList", () => {
	it("renders each status with a distinct marker", () => {
		const rendered = formatTodoList([
			{ content: "a", status: "pending", priority: "low" },
			{ content: "b", status: "in_progress", priority: "high" },
			{ content: "c", status: "completed", priority: "medium" },
			{ content: "d", status: "cancelled", priority: "low" },
		]);
		expect(rendered).toBe("- [ ] (low) a\n- [~] (high) b\n- [x] (medium) c\n- [-] (low) d");
	});
});

describe("remainingTodoCount", () => {
	it("counts only pending/in_progress items", () => {
		const count = remainingTodoCount([
			{ content: "a", status: "pending", priority: "low" },
			{ content: "b", status: "in_progress", priority: "high" },
			{ content: "c", status: "completed", priority: "medium" },
			{ content: "d", status: "cancelled", priority: "low" },
		]);
		expect(count).toBe(2);
	});
});
