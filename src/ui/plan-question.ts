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
	answers: string[];
	/** Map of question index → "option" (model-picked) or "free-form"
	 *  (custom text). Useful for the prompt-template substitution that the
	 *  bridge performs when composing the auto-submit message. */
	sources: Array<"option" | "free-form">;
}

/** Walk every question, get a value via pickOption (with the free-form
 *  sentinel), optionally falling through to promptText. Returns null on user
 *  cancel (Esc) at any point — the caller decides whether that's an abort
 *  or a retry. */
export async function resolvePlanQuestionWithPicker(
	question: PlanQuestion,
	pickers: Pickers,
): Promise<ResolveResult | null> {
	const answers: string[] = [];
	const sources: Array<"option" | "free-form"> = [];
	for (const item of question.questions) {
		// biome-ignore lint/performance/noAwaitInLoops: sequential user interaction
		const choice = await pickers.pickOption(
			[
				...item.options.map((option) => ({
					value: option.value,
					label: `${option.label}${option.value === item.recommended ? " (recommended)" : ""}`,
					...(option.description ? { description: option.description } : {}),
				})),
				{ value: FREE_FORM, label: "Other… (custom answer)" },
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
