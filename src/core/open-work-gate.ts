/**
 * Turn-end open-work gate: when the model stops without tool calls while the
 * active plan still has open steps, inject a `<system-reminder>` and continue
 * sampling (capped per user prompt).
 *
 * Open work is read from the plan on disk: `- [ ]` checklist items, or `###`
 * headings under `## Steps` when there is no checklist (an older plan, or one
 * edited by hand — plan_write/plan_edit now normalize fresh headings into
 * checkboxes). The two sources aren't equally actionable: checklist items can
 * be closed with plan_check; heading-only items can't, since plan_check only
 * ever recognizes `- [ ]`. `closableViaPlanCheck` tracks which source is in
 * play so the reminder doesn't send the model chasing a tool call that can
 * never succeed.
 */

import type { PlanState } from "./plan.ts";
import { listOpenPlanSteps, listUncheckedPlanSteps, readActivePlan } from "./plan.ts";

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
	/** True when `openSteps` came from `- [ ]` checkboxes — closable via
	 * plan_check. False when they came from the `###` heading fallback (a plan
	 * authored before checklist normalization, or edited by hand): plan_check
	 * only ever recognizes checkboxes, so it has nothing to close there, and
	 * recommending it sends the model into a retry loop it can never win.
	 * Defaults true so existing callers that don't pass it keep the original
	 * (checkbox) guidance. */
	closableViaPlanCheck?: boolean;
}

export type OpenWorkGateDecision = { type: "continue" } | { type: "nudge"; reminder: string };

/** Pure decision — cap logic stays in the loop caller. */
export function evaluateOpenWorkGate(input: OpenWorkGateInput): OpenWorkGateDecision {
	if (input.openSteps.length === 0) return { type: "continue" };
	return { type: "nudge", reminder: buildOpenWorkGateReminder(input.openSteps, input.closableViaPlanCheck) };
}

export function buildOpenWorkGateReminder(openSteps: string[], closableViaPlanCheck = true): string {
	const lines = openSteps.map((s) => `- ${s}`).join("\n");
	const guidance = closableViaPlanCheck
		? "Advance the next open step with the appropriate tool call now. If you have a genuine external blocker, state it explicitly in this turn. Use plan_check to mark checklist items done only after the work is finished; do not stop while open steps remain."
		: "These are `###` step headings, not `- [ ]` checkboxes — plan_check will not close them, so do not retry it. If real work remains, advance the next step with the appropriate tool call now. If everything above is genuinely done, say so plainly in this turn instead of stopping silently: this reminder will keep firing (up to the per-prompt cap, then fall through to the user) because the plan file's format can't be fixed from build mode — that needs a human to switch back to plan mode.";
	const body = [
		"You have outstanding plan steps but ended your turn without a tool call.",
		"",
		"Pending:",
		lines,
		"",
		guidance,
	].join("\n");
	return wrapSystemReminder(body);
}

export function buildOpenWorkGateExhaustedReminder(maxFires: number): string {
	const body =
		`The agent attempted to end this turn ${maxFires} times with plan steps still open. ` +
		`Falling through to the user. Prompt the agent to continue explicitly, or update/clear the plan.`;
	return wrapSystemReminder(body);
}

function wrapSystemReminder(body: string): string {
	return `<system-reminder>\n${body}\n</system-reminder>`;
}

/**
 * Whether the gate should run for this loop config.
 * Build mode + planState + an active plan file on disk.
 */
export function isOpenWorkGateActive(planState: PlanState | undefined, config: OpenWorkGateConfig): boolean {
	if (!config.enabled) return false;
	if (!planState || planState.enabled) return false;
	const plan = readActivePlan(planState);
	return plan.exists && Boolean(plan.path);
}

export interface OpenWorkSteps {
	steps: string[];
	/** See `OpenWorkGateInput.closableViaPlanCheck`. */
	closableViaPlanCheck: boolean;
}

/** Fresh open steps from disk for the active plan (empty when inactive / missing). */
export function collectOpenWorkSteps(planState: PlanState | undefined): OpenWorkSteps {
	if (!planState || planState.enabled) return { steps: [], closableViaPlanCheck: true };
	const plan = readActivePlan(planState);
	if (!plan.exists) return { steps: [], closableViaPlanCheck: true };
	const checklistSteps = listUncheckedPlanSteps(plan.content);
	if (checklistSteps.length > 0) return { steps: checklistSteps, closableViaPlanCheck: true };
	return { steps: listOpenPlanSteps(plan.content), closableViaPlanCheck: false };
}
