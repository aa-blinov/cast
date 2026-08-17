import { describe, expect, it } from "vitest";
import type { PlanQuestion } from "../src/core/plan.ts";
import type { Pickers } from "../src/pickers/types.ts";
import { resolvePlanQuestionWithPicker } from "../src/ui/plan-question.ts";

/** A fake Pickers that hands back a queued answer to each call. The first
 *  call to pickOption pulls from `options`, the first promptText pull from
 *  `texts`, the first pickMulti pull from `multi`, then null thereafter
 *  (simulating user cancel). */
function fakePickers({
	options,
	texts,
	multi,
}: {
	options: (string | null)[];
	texts?: (string | null)[];
	multi?: (string[] | null)[];
}) {
	const oQueue = [...options];
	const tQueue = [...(texts ?? [])];
	const mQueue = [...(multi ?? [])];
	const calls = { pickOption: 0, promptText: 0, pickMulti: 0 };
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
			pickMulti: async (_opts: unknown[], _meta: unknown) => {
				calls.pickMulti += 1;
				return mQueue.shift() ?? null;
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

	it("skips the free-form sentinel entirely for noFreeForm questions", async () => {
		// noFreeForm (the skill-save confirmation) has exhaustive options — the
		// sentinel must not be offered, so a custom answer can't be invented.
		const confirm: PlanQuestion = {
			questions: [
				{
					question: "Save reusable procedure as a skill?",
					options: [
						{ value: "save", label: "Save as /release" },
						{ value: "dismiss", label: "Dismiss" },
					],
					noFreeForm: true,
				},
			],
		};
		let offered: { value: string }[] | null = null;
		const picker = {
			pickOption: async (opts: unknown[]) => {
				offered = opts as { value: string }[];
				return "save";
			},
			promptText: async () => {
				throw new Error("promptText must not be reachable for noFreeForm");
			},
			log: () => {},
		} as unknown as Pickers;
		const result = await resolvePlanQuestionWithPicker(confirm, picker);
		expect(result).toEqual({ answers: ["save"], sources: ["option"] });
		expect(offered?.map((o) => o.value)).toEqual(["save", "dismiss"]);
	});

	it("collects several options for a multi-select question via pickMulti", async () => {
		const multi: PlanQuestion = {
			questions: [
				{
					question: "Which skills to create?",
					options: [
						{ value: "release", label: "Release" },
						{ value: "component", label: "Component" },
						{ value: "verify", label: "Verify" },
					],
					multi: true,
				},
			],
		};
		const { picker, calls } = fakePickers({ options: [], multi: [["release", "verify"]] });
		const result = await resolvePlanQuestionWithPicker(multi, picker);
		expect(result).toEqual({ answers: [["release", "verify"]], sources: ["multi"] });
		expect(calls.pickMulti).toBe(1);
		expect(calls.pickOption).toBe(0);
	});

	it("cancels a multi-select question (null) returns null without creating anything", async () => {
		const multi: PlanQuestion = {
			questions: [{ question: "Which?", options: [{ value: "a", label: "A" }], multi: true }],
		};
		const { picker, calls } = fakePickers({ options: [], multi: [null] });
		const result = await resolvePlanQuestionWithPicker(multi, picker);
		expect(result).toBeNull();
		expect(calls.pickMulti).toBe(1);
	});
});
