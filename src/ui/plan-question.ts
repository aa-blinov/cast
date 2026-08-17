/**
 * Question-picker orchestration for the TUI.
 *
 * Renders the model's question schema as a sequence of single-choice picks
 * via `pickers.pickOption`, with an extra `__other__` option that opens a
 * free-text prompt. The sentinel never reaches the bridge — when picked,
 * `pickers.promptText` collects a typed answer, and that string (not the
 * sentinel) is what we return for that question.
 *
 * Lives outside `App.tsx` so the orchestration can be unit-tested against a
 * mock `Pickers` (the same pattern `connection-pickers.test.ts` uses).
 */

import type { PlanQuestion } from "../core/plan.ts";
import type { Pickers } from "../pickers/types.ts";

/** Sentinel value prepended to every question's option list. The model never
 *  sees this in its input schema — we add it client-side for the picker UI
 *  only. */
const FREE_FORM = "__other__";

export interface ResolveResult {
	/** One value per question; a multi-select question yields an array of the
	 *  selected option values. */
	answers: Array<string | string[]>;
	/** Map of question index → "option" (model-picked), "multi" (several
	 *  picked), or "free-form" (custom text). Useful for the prompt-template
	 *  substitution that the bridge performs when composing the auto-submit
	 *  message. */
	sources: Array<"option" | "multi" | "free-form">;
}

/** Walk every question, get a value via pickOption (with the free-form
 *  sentinel) or pickMulti for multi-select questions, optionally falling
 *  through to promptText. Returns null on user cancel (Esc) at any point —
 *  the caller decides whether that's an abort or a retry. */
export async function resolvePlanQuestionWithPicker(
	question: PlanQuestion,
	pickers: Pickers,
): Promise<ResolveResult | null> {
	const answers: Array<string | string[]> = [];
	const sources: Array<"option" | "multi" | "free-form"> = [];
	for (const item of question.questions) {
		if (item.multi) {
			// biome-ignore lint/performance/noAwaitInLoops: sequential user interaction
			const picked = await pickers.pickMulti(
				item.options.map((option) => ({
					value: option.value,
					label: `${option.label}${option.value === item.recommended ? " (recommended)" : ""}`,
					...(option.description ? { description: option.description } : {}),
				})),
				{ title: item.question },
			);
			if (picked === null) return null;
			answers.push(picked);
			sources.push("multi");
			continue;
		}
		const choice = await pickers.pickOption(
			[
				...item.options.map((option) => ({
					value: option.value,
					label: `${option.label}${option.value === item.recommended ? " (recommended)" : ""}`,
					...(option.description ? { description: option.description } : {}),
				})),
				// noFreeForm questions (the skill-save confirmation) have
				// exhaustive options — a custom answer has no valid meaning.
				...(item.noFreeForm ? [] : [{ value: FREE_FORM, label: "Other… (custom answer)" }]),
			],
			{ title: item.question },
		);
		if (choice === null) return null;
		if (choice === FREE_FORM) {
			const custom = await pickers.promptText(`Your answer for: ${item.question}`, undefined, "Type your answer");
			if (custom === null || custom.trim() === "") return null;
			answers.push(custom);
			sources.push("free-form");
		} else {
			answers.push(choice);
			sources.push("option");
		}
	}
	return { answers, sources };
}
