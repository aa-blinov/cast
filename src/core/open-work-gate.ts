/**
 * Turn-end open-work gate: when the model stops without tool calls while the
 * active plan still has unfinished linked todos, inject a `<system-reminder>` and continue
 * sampling (capped per user prompt).
 *
 * The approved plan is a stable specification. Its projected todo items are
 * the execution state, so this gate never mutates or interprets the plan file.
 */

import type { PlanState } from "./plan.ts";
import { readActivePlan } from "./plan.ts";
import type { TodoItem } from "./todo.ts";

/** Default cap on how many times the gate may force-continue per user prompt. */
export const DEFAULT_OPEN_WORK_GATE_MAX_FIRES = 2;

export interface OpenWorkGateConfig {
	/** When false, the gate never runs. Default true (subject to `isOpenWorkGateActive`). */
	enabled: boolean;
	/** Hard cap on nudge fires before fallthrough. */
	maxFiresPerPrompt: number;
}

export function defaultOpenWorkGateConfig(): OpenWorkGateConfig {
	return {
		enabled: true,
		maxFiresPerPrompt: DEFAULT_OPEN_WORK_GATE_MAX_FIRES,
	};
}

export interface OpenWorkGateInput {
	openSteps: string[];
}

export type OpenWorkGateDecision = { type: "continue" } | { type: "nudge"; reminder: string };

/** Pure decision — cap logic stays in the loop caller. */
export function evaluateOpenWorkGate(input: OpenWorkGateInput): OpenWorkGateDecision {
	if (input.openSteps.length === 0) return { type: "continue" };
	return { type: "nudge", reminder: buildOpenWorkGateReminder(input.openSteps) };
}

export function buildOpenWorkGateReminder(openSteps: string[]): string {
	const lines = openSteps.map((s) => `- ${s}`).join("\n");
	const body = [
		"You have unfinished approved-plan tasks but ended your turn without a tool call.",
		"",
		"Pending:",
		lines,
		"",
		"Advance the next task with the appropriate tool call now. Update its todo status only after the work is finished and verified. If there is a genuine external blocker, state it explicitly; do not stop while unfinished tasks remain.",
	].join("\n");
	return wrapSystemReminder(body);
}

export function buildOpenWorkGateExhaustedReminder(maxFires: number): string {
	const body =
		`The agent attempted to end this turn ${maxFires} times with approved-plan tasks still open. ` +
		`Falling through to the user. Prompt the agent to continue explicitly, or update the task list.`;
	return wrapSystemReminder(body);
}

function wrapSystemReminder(body: string): string {
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * Whether the gate should run for this loop config.
 * Build mode + an active plan + unfinished todos projected from that plan.
 */
export function isOpenWorkGateActive(
	planState: PlanState | undefined,
	todos: TodoItem[],
	config: OpenWorkGateConfig,
): boolean {
	if (!config.enabled) return false;
	if (!planState || planState.enabled) return false;
	const plan = readActivePlan(planState);
	return (
		plan.exists &&
		Boolean(plan.path) &&
		todos.some((todo) => todo.planStep && todo.status !== "completed" && todo.status !== "cancelled")
	);
}

/** Current unfinished steps from the plan-derived execution state. */
export function collectOpenWorkSteps(todos: TodoItem[]): string[] {
	return todos
		.filter((todo) => todo.planStep && todo.status !== "completed" && todo.status !== "cancelled")
		.map((todo) => todo.content);
}
