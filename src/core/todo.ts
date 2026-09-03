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
	/** Stable plan-step text this operational task was projected from. */
	planStep?: string;
}

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);
const PRIORITIES = new Set<TodoPriority>(["high", "medium", "low"]);

/**
 * Bounds on the list, because it is re-rendered into the *system prompt* on
 * every build-mode turn and persisted with the session — so one oversized
 * write is not a one-off, it is a tax on every subsequent request and it
 * survives restarts. Nothing capped either dimension before: a 500-item list
 * and a single 100,000-character item were both accepted, which is enough to
 * crowd out the conversation or overflow the context outright.
 *
 * The limits are far above any real task list (Claude Code's own todo lists
 * rarely pass 20 items) and are stated in the error so the model can split
 * the work instead of guessing.
 */
const MAX_TODOS = 100;
const MAX_TODO_CONTENT_CHARS = 500;

export type ValidateTodosResult = { ok: true; todos: TodoItem[] } | { ok: false; error: string };

/** Validates a raw `todo_write` call's `todos` argument end to end — shape,
 * enum values, and the "exactly one in_progress" invariant — so callers get
 * one clear error instead of a partial write or a downstream crash. */
export function validateTodos(raw: unknown): ValidateTodosResult {
	if (!Array.isArray(raw)) return { ok: false, error: "todos must be an array" };
	if (raw.length > MAX_TODOS) {
		return {
			ok: false,
			error: `too many todos (${raw.length}) — at most ${MAX_TODOS}. The list is re-sent to the model every turn; keep it to the work actually in flight.`,
		};
	}
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object") return { ok: false, error: `todos[${i}] must be an object` };
		const rec = item as Record<string, unknown>;
		const content = typeof rec.content === "string" ? rec.content.trim() : "";
		if (!content) return { ok: false, error: `todos[${i}].content is required` };
		if (content.length > MAX_TODO_CONTENT_CHARS) {
			return {
				ok: false,
				error: `todos[${i}].content is ${content.length} characters — at most ${MAX_TODO_CONTENT_CHARS}. Summarize the task; put the detail in the plan or a file.`,
			};
		}
		// `content` is a todo's only identity — the plan-step links and the
		// TaskCreated/TaskCompleted hook diffs are both keyed by it — so two
		// items sharing one is ambiguous by construction, and silently accepting
		// it made a duplicate inherit the other's plan step.
		if (seen.has(content)) {
			return {
				ok: false,
				error: `todos[${i}].content duplicates an earlier todo ("${content}") — each todo must be distinct`,
			};
		}
		seen.add(content);
		if (typeof rec.status !== "string" || !STATUSES.has(rec.status as TodoStatus)) {
			return { ok: false, error: `todos[${i}].status must be one of pending, in_progress, completed, cancelled` };
		}
		if (typeof rec.priority !== "string" || !PRIORITIES.has(rec.priority as TodoPriority)) {
			return { ok: false, error: `todos[${i}].priority must be one of high, medium, low` };
		}
		const planStep = typeof rec.planStep === "string" ? rec.planStep.trim() : "";
		todos.push({
			content,
			status: rec.status as TodoStatus,
			priority: rec.priority as TodoPriority,
			...(planStep ? { planStep } : {}),
		});
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
