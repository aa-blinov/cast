import { describe, expect, it } from "vitest";
import {
	collectLoadedSkills,
	formatLoadedSkillsReminder,
	formatPostCompactReminder,
	injectPostCompactReminder,
	reminderStateFromPlan,
} from "../src/core/compaction-reminder.ts";
import type { Message } from "../src/core/llm.ts";
import type { PlanState } from "../src/core/plan.ts";
import { listOpenPlanSteps, listUncheckedPlanSteps } from "../src/core/plan.ts";

describe("formatPostCompactReminder", () => {
	it("returns undefined when there is no actionable state (omit-when-empty)", () => {
		expect(formatPostCompactReminder()).toBeUndefined();
		expect(formatPostCompactReminder({ mode: "build" })).toBeUndefined();
		expect(formatPostCompactReminder({ readFiles: ["a.ts"] })).toBeUndefined();
	});

	it("wraps sections in system-reminder", () => {
		const out = formatPostCompactReminder({
			mode: "plan",
			modifiedFiles: ["src/auth.ts"],
			openSteps: ["wire login"],
			openStepsTotal: 1,
			planName: "auth",
		});
		expect(out).toBeDefined();
		expect(out!.startsWith("<system-reminder>")).toBe(true);
		expect(out!.endsWith("</system-reminder>")).toBe(true);
		expect(out).toContain("## Mode");
		expect(out).toContain("plan mode is active");
		expect(out).toContain("## Files Edited This Session");
		expect(out).toContain("These files were modified by you during this session:");
		expect(out).toContain("- src/auth.ts");
		expect(out).toContain("## TODO List");
		expect(out).toContain("- [pending] wire login");
		expect(out).toContain("plan `auth`");
	});

	it("lists open plan steps with truncation trailer", () => {
		const out = formatPostCompactReminder({
			planName: "ship",
			openSteps: ["a", "b"],
			openStepsTotal: 5,
		});
		expect(out).toContain("- [pending] a");
		expect(out).toContain("(3 more)");
	});
});

describe("injectPostCompactReminder", () => {
	it("appends a trailing user message and leaves the summary marker untouched", () => {
		const messages: Message[] = [
			{ role: "system", content: "persona" },
			{ role: "system", content: "[Compacted context — 4 messages summarized]\nsummary only" },
			{ role: "user", content: "recent" },
		];
		const reminder = formatPostCompactReminder({ modifiedFiles: ["src/a.ts"] })!;
		injectPostCompactReminder(messages, reminder);

		const marker = messages[1]!;
		expect(marker.role).toBe("system");
		expect(marker.content as string).not.toContain("<system-reminder>");
		expect(marker.content as string).toContain("summary only");

		const last = messages[messages.length - 1]!;
		expect(last.role).toBe("user");
		expect(last.content).toBe(reminder);
		expect(last.content as string).toContain("src/a.ts");
	});

	it("is a no-op when reminder is undefined", () => {
		const messages: Message[] = [{ role: "user", content: "hi" }];
		injectPostCompactReminder(messages, undefined);
		expect(messages).toHaveLength(1);
	});
});

describe("listUncheckedPlanSteps", () => {
	it("skips checked items and fenced examples", () => {
		const content = [
			"# Plan",
			"- [x] done",
			"- [ ] real step",
			"```",
			"- [ ] fake in fence",
			"```",
			"* [ ] another",
		].join("\n");
		expect(listUncheckedPlanSteps(content)).toEqual(["real step", "another"]);
	});
});

describe("listOpenPlanSteps", () => {
	it("prefers unchecked checkboxes over Steps headings", () => {
		const content = ["## Steps", "### 1. Heading step", "- [ ] checkbox step", "### 2. Another heading"].join("\n");
		expect(listOpenPlanSteps(content)).toEqual(["checkbox step"]);
	});

	it("falls back to ### headings under ## Steps when there is no checklist", () => {
		const content = [
			"## Context",
			"Why",
			"## Steps",
			"### 1. Segment registry (`src/ui/statusbar.ts`)",
			"details",
			"### 2. StatusBarPicker",
			"## Verification",
			"### Not a step",
		].join("\n");
		expect(listOpenPlanSteps(content)).toEqual(["1. Segment registry (`src/ui/statusbar.ts`)", "2. StatusBarPicker"]);
	});

	it("ignores headings inside fenced blocks under Steps", () => {
		const content = ["## Steps", "### 1. Real", "```md", "### fake heading in fence", "```", "### 2. Also real"].join(
			"\n",
		);
		expect(listOpenPlanSteps(content)).toEqual(["1. Real", "2. Also real"]);
	});

	it("skips an empty duplicate ## Steps in favor of the one with ### children", () => {
		const content = ["## Steps", "## Steps", "### 1. Create email tools", "### 2. Wire catalog"].join("\n");
		expect(listOpenPlanSteps(content)).toEqual(["1. Create email tools", "2. Wire catalog"]);
	});
});

describe("reminderStateFromPlan", () => {
	it("returns plan mode when enabled", () => {
		const state: PlanState = { enabled: true, plansDir: "/tmp/no-such-plans" };
		expect(reminderStateFromPlan(state)).toEqual({ mode: "plan" });
	});

	it("returns empty object without planState", () => {
		expect(reminderStateFromPlan(undefined)).toEqual({});
	});
});

describe("skills loaded before a compaction", () => {
	const skillBlock = (name: string, text = "steps") =>
		`<skill name="${name}" location="/x/${name}/SKILL.md">\nReferences are relative to /x/${name}.\n\n${text}\n</skill>`;

	it("finds a skill that arrived as a tool result or as a /skill message, once each, newest last", () => {
		const found = collectLoadedSkills([
			{ role: "user", content: skillBlock("alpha", "old") },
			{ role: "assistant", content: "ok" },
			{ role: "tool", tool_call_id: "1", content: skillBlock("beta") },
			{ role: "tool", tool_call_id: "2", content: skillBlock("alpha", "new") },
			{ role: "user", content: "an ordinary message" },
		] as never);
		expect(found.map((s) => s.name)).toEqual(["beta", "alpha"]);
		expect(found[1]!.block).toContain("new");
	});

	it("keeps the latest three, each cut to a bound", () => {
		const many = ["a", "b", "c", "d"].map((n) => ({ role: "tool", tool_call_id: n, content: skillBlock(n) }));
		expect(collectLoadedSkills(many as never).map((s) => s.name)).toEqual(["b", "c", "d"]);
		const huge = collectLoadedSkills([
			{ role: "tool", tool_call_id: "h", content: skillBlock("huge", "z".repeat(50_000)) },
		] as never);
		expect(huge[0]!.block.length).toBeLessThan(12_200);
		expect(huge[0]!.block.endsWith("</skill>")).toBe(true);
	});

	it("says nothing when no skill was loaded, and puts the skills back as a reminder otherwise", () => {
		expect(formatLoadedSkillsReminder([])).toBeUndefined();
		const reminder = formatLoadedSkillsReminder([{ name: "alpha", block: skillBlock("alpha") }])!;
		expect(reminder.startsWith("<system-reminder>")).toBe(true);
		expect(reminder).toContain("still apply");
		expect(reminder).toContain('<skill name="alpha"');
	});
});
