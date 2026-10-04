/**
 * Post-compaction state reminder: a separate `<system-reminder>` message after
 * the summary, omitted when there is nothing actionable to preserve.
 *
 * Sections when present:
 * - Mode (plan / build + active plan name)
 * - Files Edited This Session ← modified file tags
 * - TODO List ← open plan steps (`- [ ]`, or `###` under `## Steps`)
 */

import { basename } from "node:path";
import type { Message } from "./llm.ts";
import { listOpenPlanSteps, type PlanState, readActivePlan } from "./plan.ts";
import { escapeSystemReminderTags } from "./system-reminder.ts";

const MAX_OPEN_STEPS = 8;
const MAX_FILES = 12;

export interface PostCompactReminderState {
	/** Active agent mode, if known. */
	mode?: "plan" | "build";
	/** Active plan basename without `.md`. */
	planName?: string;
	/** Open step texts (`- [ ]` body, or `###` heading under Steps). */
	openSteps?: string[];
	/** Total open count when `openSteps` is truncated. */
	openStepsTotal?: number;
	readFiles?: string[];
	modifiedFiles?: string[];
}

/** Snapshot plan/mode fields for a post-compact reminder. */
export function reminderStateFromPlan(planState: PlanState | undefined): PostCompactReminderState {
	if (!planState) return {};
	if (planState.enabled) return { mode: "plan" };

	const plan = readActivePlan(planState);
	if (!plan.exists || !plan.path) return { mode: "build" };

	const planName = basename(plan.path, ".md");
	const openSteps = listOpenPlanSteps(plan.content);
	if (openSteps.length === 0) return { mode: "build", planName };

	return {
		mode: "build",
		planName,
		openSteps: openSteps.slice(0, MAX_OPEN_STEPS),
		openStepsTotal: openSteps.length,
	};
}

function formatEditedFiles(files: string[] | undefined): string | undefined {
	if (!files || files.length === 0) return undefined;
	const shown = files.slice(0, MAX_FILES);
	const extra = files.length - shown.length;
	const body = shown.map((f) => `- ${f}`).join("\n");
	const trailer = extra > 0 ? `\n(${extra} more)` : "";
	return `## Files Edited This Session\nThese files were modified by you during this session:\n${body}${trailer}`;
}

function formatTodoList(
	openSteps: string[] | undefined,
	openStepsTotal: number | undefined,
	planName: string | undefined,
): string | undefined {
	if (!openSteps || openSteps.length === 0) return undefined;
	const total = openStepsTotal ?? openSteps.length;
	const lines = openSteps.map((s) => `- [pending] ${s}`).join("\n");
	const remaining = total - openSteps.length;
	const trailer = remaining > 0 ? `\n(${remaining} more)` : "";
	const planBit = planName ? ` (plan \`${planName}\`)` : "";
	return (
		`## TODO List\n` +
		`This is your task list from before the conversation was compacted${planBit} — it is still ` +
		`active. Keep working through the items below and update their status as you make progress:\n` +
		`${lines}${trailer}`
	);
}

/**
 * Format the `<system-reminder>` block, or `undefined` when nothing actionable
 * (omit-when-empty — empty reminders must not be injected).
 */
export function formatPostCompactReminder(state: PostCompactReminderState = {}): string | undefined {
	const sections: string[] = [];

	if (state.mode === "plan") {
		sections.push(
			"## Mode\nplan mode is active — explore and author the plan; do not implement (no write/edit; bash is inspection-only).",
		);
	} else if (state.mode === "build" && state.planName) {
		sections.push(`## Mode\nbuild mode. Active plan: \`${state.planName}\`.`);
	}

	const edited = formatEditedFiles(state.modifiedFiles);
	if (edited) sections.push(edited);

	const todos = formatTodoList(state.openSteps, state.openStepsTotal, state.planName);
	if (todos) sections.push(todos);

	if (sections.length === 0) return undefined;
	return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}

const SKILL_BLOCK_START = '<skill name="';
const MAX_SKILLS_KEPT = 3;
const MAX_SKILL_CHARS = 12_000;
const SKILL_NAME_RE = /^<skill name="([^"]*)"/;

/**
 * The skills loaded in a conversation, newest last, each once: a skill's instructions arrive as a tool result (or as
 * the message a `/skill` command sends), which the summary does not carry, so a workflow loaded early would be lost
 * halfway through. Only the latest few are kept, each cut to a bound.
 */
export function collectLoadedSkills(messages: Message[]): Array<{ name: string; block: string }> {
	const latest = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "tool" && message.role !== "user") continue;
		if (typeof message.content !== "string" || !message.content.startsWith(SKILL_BLOCK_START)) continue;
		const name = SKILL_NAME_RE.exec(message.content)?.[1];
		if (!name) continue;
		// Re-inserted so a skill loaded twice counts as the more recent load.
		latest.delete(name);
		latest.set(name, message.content);
	}
	return [...latest.entries()].slice(-MAX_SKILLS_KEPT).map(([name, block]) => ({
		name,
		block:
			block.length > MAX_SKILL_CHARS
				? `${block.slice(0, MAX_SKILL_CHARS)}\n[…cut; load the skill again for the rest]\n</skill>`
				: block,
	}));
}

/** The reminder that puts loaded skills back after a compaction, for those no longer in the conversation. */
export function formatLoadedSkillsReminder(skills: Array<{ name: string; block: string }>): string | undefined {
	if (skills.length === 0) return undefined;
	const body = skills.map((s) => escapeSystemReminderTags(s.block)).join("\n\n");
	return `<system-reminder>\nSkills you loaded earlier in this conversation. The conversation was compacted; their instructions still apply:\n\n${body}\n</system-reminder>`;
}

/**
 * Inject the reminder as its own trailing user message after the compaction
 * summary — never merge it into the summary text.
 */
export function injectPostCompactReminder(messages: Message[], reminder: string | undefined): void {
	if (!reminder?.trim()) return;
	messages.push({ role: "user", content: reminder });
}
