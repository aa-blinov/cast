import { describe, expect, it, vi } from "vitest";

vi.mock("htm", () => ({ default: { bind: () => () => null } }), { virtual: true });
vi.mock("preact", () => ({ h: () => null }), { virtual: true });
vi.mock(
	"preact/hooks",
	() => ({ useState: (value: unknown) => [typeof value === "function" ? value() : value, vi.fn()] }),
	{ virtual: true },
);

vi.mock("../src/server/public/lazy.js", () => ({ lazy: () => () => null }));

import { latestPlan, PLAN_DECISION_OPTIONS, PlanDecisionCard, QuestionCard } from "../src/server/public/plan-cards.js";

describe("web plan cards", () => {
	it("exposes the three plan transition choices", () => {
		expect(PLAN_DECISION_OPTIONS.map((option) => option.value)).toEqual(["continue", "implement", "clean"]);
	});

	it("exports both card components", () => {
		expect(typeof PlanDecisionCard).toBe("function");
		expect(typeof QuestionCard).toBe("function");
	});
});

describe("latestPlan", () => {
	const done = (result: string) => ({ toolCalls: [{ name: "plan_done", result }] });

	it("reads the summary and the project-relative file of the last plan_done", () => {
		const result = JSON.stringify({ name: "p", summary: "Do it", path: "/work/proj/.cast/plans/s/p.md" });
		expect(latestPlan([{ toolCalls: [] }, done(result)], "/work/proj")).toEqual({
			name: "p",
			summary: "Do it",
			relPath: ".cast/plans/s/p.md",
		});
	});

	it("offers no file when the plan is outside the project, and nothing when unreadable", () => {
		const outside = JSON.stringify({ summary: "x", path: "/elsewhere/p.md" });
		expect(latestPlan([done(outside)], "/work/proj")?.relPath).toBeNull();
		expect(latestPlan([done("not json")], "/work/proj")).toBeNull();
		expect(latestPlan([], "/work/proj")).toBeNull();
	});
});
