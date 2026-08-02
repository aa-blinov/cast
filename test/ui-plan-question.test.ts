import { describe, expect, it } from "vitest";
import type { PlanQuestion } from "../src/core/plan.ts";
import type { Pickers } from "../src/pickers/types.ts";
import { resolvePlanQuestionWithPicker } from "../src/ui/plan-question.ts";

/** A fake Pickers that hands back a queued answer to each call. The first
 *  call to pickOption pulls from `options`, the first promptText pull from
 *  `texts`, then null thereafter (simulating user cancel). */
function fakePickers({ options, texts }: { options: (string | null)[]; texts?: (string | null)[] }) {
	const oQueue = [...options];
	const tQueue = [...(texts ?? [])];
	const calls = { pickOption: 0, promptText: 0 };
	return {
		picker: {
			pickOption: async (_opts: unknown[], _meta: unknown) => {
				calls.pickOption += 1;
				return oQueue.shift() ?? null;
			},
			promptText: async (_label: string, _defaultValue?: string, _placeholder?: string) => {
				calls.promptText += 1;
				return tQueue.shift() ?? null;
			},
			log: () => {},
		} as unknown as Pickers,
		calls,
	};
}

const sampleQuestion: PlanQuestion = {
	questions: [
		{
			question: "Choose cache backend",
			options: [
				{ value: "memory", label: "In-memory" },
				{ value: "redis", label: "Redis" },
			],
			recommended: "redis",
		},
		{
			question: "Choose deployment target",
			options: [
				{ value: "k8s", label: "Kubernetes" },
				{ value: "vm", label: "VM" },
			],
		},
	],
};

describe("resolvePlanQuestionWithPicker", () => {
	it("returns option values when user picks from the model-provided list", async () => {
		const { picker, calls } = fakePickers({ options: ["redis", "k8s"] });
		const result = await resolvePlanQuestionWithPicker(sampleQuestion, picker);
		expect(result).toEqual({
			answers: ["redis", "k8s"],
			sources: ["option", "option"],
		});
		expect(calls.pickOption).toBe(2);
		expect(calls.promptText).toBe(0);
	});

	it("falls through to promptText when the user picks the free-form sentinel", async () => {
		// Q1 → "memory" (option), Q2 → "__other__" (sentinel, triggers promptText)
		const { picker, calls } = fakePickers({
			options: ["memory", "__other__"],
			texts: ["Use sqlite + a cron-based eviction job"],
		});
		const result = await resolvePlanQuestionWithPicker(sampleQuestion, picker);
		expect(result).toEqual({
			answers: ["memory", "Use sqlite + a cron-based eviction job"],
			sources: ["option", "free-form"],
		});
		expect(calls.pickOption).toBe(2);
		expect(calls.promptText).toBe(1);
	});

	it("returns null on first-pick cancel (Esc) and does not call promptText", async () => {
		const { picker, calls } = fakePickers({ options: [null], texts: ["unused"] });
		const result = await resolvePlanQuestionWithPicker(sampleQuestion, picker);
		expect(result).toBeNull();
		expect(calls.pickOption).toBe(1);
		expect(calls.promptText).toBe(0);
	});

	it("returns null when the user picks free-form then escapes the text prompt", async () => {
		const { picker, calls } = fakePickers({ options: ["__other__"], texts: [null] });
		const result = await resolvePlanQuestionWithPicker(sampleQuestion, picker);
		expect(result).toBeNull();
		expect(calls.pickOption).toBe(1);
		expect(calls.promptText).toBe(1);
	});

	it("returns null when the user enters an empty free-form answer (whitespace)", async () => {
		const { picker, calls } = fakePickers({ options: ["__other__"], texts: ["   "] });
		const result = await resolvePlanQuestionWithPicker(sampleQuestion, picker);
		expect(result).toBeNull();
		expect(calls.promptText).toBe(1);
	});

	it("never exposes the sentinel as a final answer — the free-form text replaces it", async () => {
		// Single-question schema, so the only pickOption call answers the free-form
		// sentinel and is replaced by the typed text.
		const single: PlanQuestion = {
			questions: [
				{
					question: "Anything custom?",
					options: [
						{ value: "yes", label: "Yes" },
						{ value: "no", label: "No" },
					],
				},
			],
		};
		const { picker } = fakePickers({ options: ["__other__"], texts: ["my custom answer"] });
		const result = await resolvePlanQuestionWithPicker(single, picker);
		expect(result?.answers).toEqual(["my custom answer"]);
		expect(result?.answers).not.toContain("__other__");
		expect(result?.sources).toEqual(["free-form"]);
	});
});
