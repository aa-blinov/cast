import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({ useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()] }),
	{ virtual: true },
);

import { PLAN_DECISION_OPTIONS, PlanDecisionCard, QuestionCard } from "../src/server/public/plan-cards.js";

describe("web plan cards", () => {
	it("exposes the three plan transition choices", () => {
		expect(PLAN_DECISION_OPTIONS.map((option) => option.value)).toEqual(["continue", "implement", "clean"]);
	});

	it("exports both card components", () => {
		expect(typeof PlanDecisionCard).toBe("function");
		expect(typeof QuestionCard).toBe("function");
	});
});
