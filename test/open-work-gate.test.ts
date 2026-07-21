import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildOpenWorkGateExhaustedReminder,
	buildOpenWorkGateReminder,
	collectOpenWorkSteps,
	DEFAULT_OPEN_WORK_GATE_MAX_FIRES,
	defaultOpenWorkGateConfig,
	evaluateOpenWorkGate,
} from "../src/core/open-work-gate.ts";
import { execPlanWrite, type PlanState } from "../src/core/plan.ts";

const TEST_PLANS_DIR = join(import.meta.dirname, "__test_tmp__", "open-work-gate-plans");

function testState(sessionId: string): PlanState {
	return { enabled: false, plansDir: join(TEST_PLANS_DIR, sessionId) };
}

describe("evaluateOpenWorkGate", () => {
	it("continues when there are no open steps", () => {
		expect(evaluateOpenWorkGate({ openSteps: [] })).toEqual({ type: "continue" });
	});

	it("nudges with a reminder listing the provided open steps", () => {
		const openSteps = ["step alpha", "step beta"];
		const decision = evaluateOpenWorkGate({ openSteps });
		expect(decision.type).toBe("nudge");
		if (decision.type !== "nudge") return;
		expect(decision.reminder).toContain("<system-reminder>");
		expect(decision.reminder).toContain("</system-reminder>");
		for (const step of openSteps) {
			expect(decision.reminder).toContain(`- ${step}`);
		}
		expect(decision.reminder).toContain("ended your turn without a tool call");
	});
});

describe("buildOpenWorkGateReminder", () => {
	it("wraps the body in system-reminder tags", () => {
		const reminder = buildOpenWorkGateReminder(["only"]);
		expect(reminder.startsWith("<system-reminder>\n")).toBe(true);
		expect(reminder.endsWith("\n</system-reminder>")).toBe(true);
		expect(reminder).toContain("- only");
	});

	it("recommends plan_check by default (checkbox-backed steps)", () => {
		const reminder = buildOpenWorkGateReminder(["only"]);
		expect(reminder).toContain("Use plan_check to mark checklist items done");
	});

	it("does not recommend plan_check for heading-fallback steps it can't close", () => {
		const reminder = buildOpenWorkGateReminder(["1. Heading step"], false);
		expect(reminder).not.toContain("Use plan_check to mark checklist items done");
		expect(reminder).toContain("plan_check will not close them");
		expect(reminder).toContain("do not retry it");
	});
});

describe("buildOpenWorkGateExhaustedReminder", () => {
	it("includes the max-fires cap number", () => {
		const reminder = buildOpenWorkGateExhaustedReminder(2);
		expect(reminder).toContain("<system-reminder>");
		expect(reminder).toContain("2 times");
		expect(reminder).toContain("Falling through to the user");
	});
});

describe("collectOpenWorkSteps", () => {
	beforeEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
		mkdirSync(TEST_PLANS_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
	});

	it("is closable via plan_check when the plan uses checkboxes", () => {
		const state = testState("checklist");
		execPlanWrite({ name: "main", content: "# Plan\n\n## Steps\n- [ ] a\n- [x] b" }, state);

		expect(collectOpenWorkSteps(state)).toEqual({ steps: ["a"], closableViaPlanCheck: true });
	});

	it("is not closable via plan_check for a plan without checkboxes (heading fallback)", () => {
		const state = testState("headings-only");
		// Written directly to disk, bypassing plan_write's normalization — the
		// shape an older or hand-edited plan can still be in.
		mkdirSync(state.plansDir, { recursive: true });
		writeFileSync(
			join(state.plansDir, "main.md"),
			"# Plan\n\n## Steps\n\n### 1. First\n\nSpec.\n\n### 2. Second\n\nSpec.",
			"utf-8",
		);

		expect(collectOpenWorkSteps(state)).toEqual({
			steps: ["1. First", "2. Second"],
			closableViaPlanCheck: false,
		});
	});

	it("returns empty/closable when there is no active plan", () => {
		const state = testState("none");
		expect(collectOpenWorkSteps(state)).toEqual({ steps: [], closableViaPlanCheck: true });
	});
});

describe("defaultOpenWorkGateConfig", () => {
	it("defaults to enabled with maxFiresPerPrompt of 2", () => {
		const cfg = defaultOpenWorkGateConfig();
		expect(cfg.enabled).toBe(true);
		expect(cfg.maxFiresPerPrompt).toBe(2);
		expect(DEFAULT_OPEN_WORK_GATE_MAX_FIRES).toBe(2);
	});
});
