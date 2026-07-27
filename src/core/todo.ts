/**
 * Build-mode todo list: a small externalized task tracker the model writes
 * to via the `todo_write` tool. Kept off the session's `messages` array (own
 * SessionState field) so it survives compaction, and re-injected into the
 * system prompt on every turn (see loop.ts's syncSystemPrompt) rather than
 * relying on the model to remember it across a long tool-call sequence —
 * that's what a big task list actually loses track of.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	priority: TodoPriority;
}

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);
const PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"]);

export type ValidateTodosResult = { ok: true; todos: TodoItem[] } | { ok: false; error: string };

/** Validates a raw `todo_write` call's `todos` argument end to end — shape,
 * enum values, and the "exactly one in_progress" invariant — so callers get
 * one clear error instead of a partial write or a downstream crash. */
export function validateTodos(raw: unknown): ValidateTodosResult {
	if (!Array.isArray(raw)) return { ok: false, error: "todos must be an array" };
	const todos: TodoItem[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object") return { ok: false, error: `todos[${i}] must be an object` };
		const rec = item as Record<string, unknown>;
		const content = typeof rec.content === "string" ? rec.content.trim() : "";
		if (!content) return { ok: false, error: `todos[${i}].content is required` };
		if (typeof rec.status !== "string" || !STATUSES.has(rec.status as TodoStatus)) {
			return { ok: false, error: `todos[${i}].status must be one of pending, in_progress, completed, cancelled` };
		}
		if (typeof rec.priority !== "string" || !PRIORITIES.has(rec.priority as TodoPriority)) {
			return { ok: false, error: `todos[${i}].priority must be one of high, medium, low` };
		}
		todos.push({ content, status: rec.status as TodoStatus, priority: rec.priority as TodoPriority });
	}
	const inProgress = todos.filter((t) => t.status === "in_progress").length;
	if (inProgress > 1) {
		return { ok: false, error: `only one todo can be in_progress at a time (found ${inProgress})` };
	}
	return { ok: true, todos };
}

const STATUS_MARK: Record<TodoStatus, string> = {
	pending: "[ ]",
	in_progress: "[~]",
	completed: "[x]",
	cancelled: "[-]",
};

/** Rendered into the system prompt every build-mode turn (see loop.ts). */
export function formatTodoList(todos: TodoItem[]): string {
	return todos.map((t) => `- ${STATUS_MARK[t.status]} (${t.priority}) ${t.content}`).join("\n");
}

/** Count of todos that still represent open work (not completed/cancelled). */
export function remainingTodoCount(todos: TodoItem[]): number {
	return todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
}
