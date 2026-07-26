import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkPlanFileGate,
	checkReadOnlyCommand,
	createPlanState,
	enforcePlanCapAfterEdit,
	execPlanCheck,
	execPlanDiscard,
	execPlanDone,
	execPlanEnter,
	execPlanRead,
	finalizePlanFileWrite,
	isPlanFilePath,
	listOpenPlanSteps,
	MAX_PLAN_CHARS,
	modeDisabledTools,
	PLAN_TOOL_NAMES,
	type PlanState,
	planChecklistState,
	readActivePlan,
	readPlanFile,
	resolveActivePlanPath,
	slugifyPlanName,
} from "../src/core/plan.ts";

const TEST_PLANS_DIR = join(import.meta.dirname, "__test_tmp__", "plans");

/** PlanState rooted in the test dir — mirrors createPlanState's shape without
 * touching the real ~/.cast/plans. */
function testState(sessionId: string): PlanState {
	return { enabled: false, plansDir: join(TEST_PLANS_DIR, sessionId) };
}

/**
 * Stand-in for what tools.ts's createToolExecutor does around a real
 * write/edit call while plan mode is active: write the file, then run the
 * same finalize step (checklist normalization + activePlanPath). Plan
 * authoring itself goes through the ordinary write/edit tools now (see
 * plan.ts's file doc comment) — this only exercises the plan.ts-side gate
 * primitives, not the dispatcher wiring (that's test/tools.test.ts's job).
 */
function writePlan(state: PlanState, name: string, content: string): string {
	const path = join(state.plansDir, `${name}.md`);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf-8");
	finalizePlanFileWrite(path, state);
	return path;
}

describe("plan", () => {
	beforeEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
		mkdirSync(TEST_PLANS_DIR, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(TEST_PLANS_DIR)) rmSync(TEST_PLANS_DIR, { recursive: true });
	});

	describe("modeDisabledTools", () => {
		it("plan mode blocks only the build-only plan tools — write/edit stay advertised", () => {
			const gated = modeDisabledTools(true);
			// write/edit are gated per-call (checkPlanFileGate), not hidden outright —
			// the model authors the plan file with the same tools it edits code with.
			expect(gated).not.toContain("write");
			expect(gated).not.toContain("edit");
			expect(gated).toContain("plan_check");
			expect(gated).toContain("plan_enter");
			// bash stays advertised — the executor's read-only gate handles it
			expect(gated).not.toContain("bash");
			expect(gated).not.toContain("plan_read");
		});

		it("build mode blocks exactly the authoring-signal plan tools", () => {
			const gated = modeDisabledTools(false);
			expect([...gated].sort()).toEqual(["plan_discard", "plan_done"]);
		});

		it("every plan tool has an explicit mode decision (or is dual-mode plan_read)", () => {
			// A new PLAN_TOOL_NAMES entry must be placed in exactly one mode's
			// gate list — or knowingly left dual-mode like plan_read. This test
			// fails the moment someone adds a tool without deciding.
			const planGated = new Set(modeDisabledTools(true).filter((n) => n.startsWith("plan_")));
			const buildGated = new Set(modeDisabledTools(false));
			const dualMode = ["plan_read"];
			for (const name of PLAN_TOOL_NAMES) {
				const decisions = [planGated.has(name), buildGated.has(name), dualMode.includes(name)].filter(
					Boolean,
				).length;
				expect(decisions, `tool ${name} needs exactly one mode decision`).toBe(1);
			}
		});
	});

	describe("createPlanState", () => {
		it("derives a per-session plans directory", () => {
			const state = createPlanState("abc");
			expect(state.plansDir.endsWith(join(".cast", "plans", "abc"))).toBe(true);
			expect(state.enabled).toBe(false);
			expect(state.activePlanPath).toBeUndefined();
		});
	});

	describe("slugifyPlanName", () => {
		it("kebab-cases arbitrary names", () => {
			expect(slugifyPlanName("Auth Refactor!")).toBe("auth-refactor");
			expect(slugifyPlanName("  OAuth2 / PKCE flow  ")).toBe("oauth2-pkce-flow");
		});

		it("neutralizes path traversal", () => {
			expect(slugifyPlanName("../../etc/passwd")).toBe("etc-passwd");
			expect(slugifyPlanName("..")).toBe("");
		});
	});

	describe("checkReadOnlyCommand", () => {
		it("allows inspection pipelines", () => {
			expect(checkReadOnlyCommand("ls -la").ok).toBe(true);
			expect(checkReadOnlyCommand("cat src/app.ts | grep -n handler | head -5").ok).toBe(true);
			expect(checkReadOnlyCommand("git log --oneline -10 && git status").ok).toBe(true);
			expect(checkReadOnlyCommand("git diff HEAD~1 -- src/").ok).toBe(true);
			expect(checkReadOnlyCommand("LC_ALL=C sort file.txt | uniq -c").ok).toBe(true);
		});

		it("rejects anything that can write", () => {
			expect(checkReadOnlyCommand("rm -rf /tmp/x").ok).toBe(false);
			expect(checkReadOnlyCommand("echo hi > out.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("cat $(find_evil)").ok).toBe(false);
			expect(checkReadOnlyCommand("ls `rm -rf .`").ok).toBe(false);
			expect(checkReadOnlyCommand("npm test").ok).toBe(false);
			expect(checkReadOnlyCommand("sed -i 's/a/b/' file").ok).toBe(false);
			expect(checkReadOnlyCommand("git checkout main").ok).toBe(false);
			expect(checkReadOnlyCommand("git branch new-branch").ok).toBe(false);
			expect(checkReadOnlyCommand("ls && touch x").ok).toBe(false);
			expect(checkReadOnlyCommand("find . -name '*.md' | xargs rm").ok).toBe(false);
			expect(checkReadOnlyCommand("").ok).toBe(false);
		});

		it("rejects argument-level writers and executors on allowlisted binaries", () => {
			// find/fd can delete or exec through flags
			expect(checkReadOnlyCommand("find . -name '*.tmp' -delete").ok).toBe(false);
			expect(checkReadOnlyCommand("find . -exec rm {} \\;").ok).toBe(false);
			expect(checkReadOnlyCommand("fd -x rm").ok).toBe(false);
			// output flags write without any `>`
			expect(checkReadOnlyCommand("sort -o out.txt in.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("tree -o out.txt").ok).toBe(false);
			expect(checkReadOnlyCommand("git log --output=/tmp/x").ok).toBe(false);
			expect(checkReadOnlyCommand("git log --output /tmp/x").ok).toBe(false);
			// process substitution executes commands
			expect(checkReadOnlyCommand("diff <(rm -rf x) file").ok).toBe(false);
			// env launches arbitrary binaries
			expect(checkReadOnlyCommand("env sh -c 'rm -rf x'").ok).toBe(false);
			// uniq's second positional argument is an output file
			expect(checkReadOnlyCommand("uniq input.txt output.txt").ok).toBe(false);
			// ...while the plain read-only forms of the same binaries still pass
			expect(checkReadOnlyCommand("find . -name '*.md' -type f").ok).toBe(true);
			expect(checkReadOnlyCommand("sort in.txt | uniq -c").ok).toBe(true);
			expect(checkReadOnlyCommand("git log --oneline").ok).toBe(true);
		});
	});

	describe("planChecklistState", () => {
		it("counts unchecked and checked items", () => {
			const { unchecked, checked } = planChecklistState("## Steps\n- [ ] a\n- [x] b\n- [X] c\n* [ ] d\ntext");
			expect(unchecked).toBe(2);
			expect(checked).toBe(2);
		});

		it("returns zeros for a plan without a checklist", () => {
			expect(planChecklistState("# Plan\nJust prose.")).toEqual({ unchecked: 0, checked: 0 });
		});

		it("ignores checkbox-like lines inside code fences", () => {
			const content = "## Steps\n- [x] real step\n```markdown\n- [ ] example in docs\n```\n- [x] another";
			// Without fence-awareness the fenced example would keep the plan
			// "unfinished" forever (done-variant never triggers).
			expect(planChecklistState(content)).toEqual({ unchecked: 0, checked: 2 });
		});
	});

	describe("readPlanFile", () => {
		it("returns exists=false when file does not exist", () => {
			const result = readPlanFile("/nonexistent/plan.md");
			expect(result.exists).toBe(false);
			expect(result.content).toBe("");
			expect(result.headings).toEqual([]);
		});

		it("returns exists=false for empty file", () => {
			const path = join(TEST_PLANS_DIR, "empty.md");
			writeFileSync(path, "", "utf-8");
			const result = readPlanFile(path);
			expect(result.exists).toBe(false);
		});

		it("reads content and extracts headings", () => {
			const path = join(TEST_PLANS_DIR, "read.md");
			writeFileSync(
				path,
				"# Plan: Test\n\n## Context\nSome context\n\n## Steps\n1. Step one\n2. Step two\n\n## Verification\nRun tests\n",
				"utf-8",
			);
			const result = readPlanFile(path);
			expect(result.exists).toBe(true);
			expect(result.headings).toEqual(["Plan: Test", "Context", "Steps", "Verification"]);
			expect(result.content).toContain("Step one");
		});

		it("ignores heading-like lines inside code fences", () => {
			const path = join(TEST_PLANS_DIR, "fences.md");
			writeFileSync(
				path,
				"# Plan\n\n## Steps\n```bash\n# not a heading\necho hi\n```\n\n## Verification\nRun tests\n",
				"utf-8",
			);
			const result = readPlanFile(path);
			expect(result.headings).toEqual(["Plan", "Steps", "Verification"]);
		});

		it("reports read errors instead of pretending the plan does not exist", () => {
			// A directory exists but can't be read as a file → error, not exists=false-silence
			const result = readPlanFile(TEST_PLANS_DIR);
			expect(result.exists).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe("active plan resolution", () => {
		it("prefers the plan most recently written", () => {
			const state = testState("active-1");
			writePlan(state, "first", "# First");
			writePlan(state, "second", "# Second");
			writePlan(state, "first", "# First again");

			expect(resolveActivePlanPath(state)).toBe(join(state.plansDir, "first.md"));
			expect(readActivePlan(state).content).toBe("# First again");
		});

		it("falls back to the newest file on disk when the in-memory marker is gone (resume)", () => {
			const state = testState("active-2");
			writePlan(state, "old", "# Old");
			writePlan(state, "new", "# New");
			// Distinct mtimes — same-ms writes would make the order ambiguous.
			const past = new Date(Date.now() - 60_000);
			utimesSync(join(state.plansDir, "old.md"), past, past);

			const resumed = testState("active-2"); // fresh state, no activePlanPath
			expect(resolveActivePlanPath(resumed)).toBe(join(resumed.plansDir, "new.md"));
		});

		it("resolves to undefined when the session has no plans", () => {
			const state = testState("active-3");
			expect(resolveActivePlanPath(state)).toBeUndefined();
			expect(readActivePlan(state).exists).toBe(false);
		});
	});

	describe("isPlanFilePath / checkPlanFileGate", () => {
		it("accepts a .md file directly inside plansDir", () => {
			const state = testState("gate-1");
			const path = join(state.plansDir, "auth-refactor.md");
			expect(isPlanFilePath(path, state.plansDir)).toBe(true);
			expect(checkPlanFileGate(path, state).ok).toBe(true);
		});

		it("rejects a path outside plansDir — real source files stay off-limits", () => {
			const state = testState("gate-2");
			const outside = "/home/user/project/src/index.ts";
			expect(isPlanFilePath(outside, state.plansDir)).toBe(false);
			const result = checkPlanFileGate(outside, state);
			expect(result.ok).toBe(false);
			expect(result.ok || result.error).toContain(state.plansDir);
		});

		it("rejects a non-.md file even inside plansDir", () => {
			const state = testState("gate-3");
			const path = join(state.plansDir, "notes.txt");
			expect(checkPlanFileGate(path, state).ok).toBe(false);
		});

		it("rejects a nested subdirectory inside plansDir (no dirname match)", () => {
			const state = testState("gate-4");
			const path = join(state.plansDir, "sub", "plan.md");
			expect(checkPlanFileGate(path, state).ok).toBe(false);
		});

		it("rejects path traversal out of plansDir", () => {
			const state = testState("gate-5");
			const escaped = join(state.plansDir, "..", "escaped.md");
			expect(checkPlanFileGate(escaped, state).ok).toBe(false);
		});
	});

	describe("finalizePlanFileWrite", () => {
		it("makes the written path the active plan", () => {
			const state = testState("finalize-1");
			const path = writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] x");
			expect(state.activePlanPath).toBe(path);
		});

		it("normalizes bare ### step headings into checkboxes", () => {
			const state = testState("finalize-2");
			const path = writePlan(
				state,
				"main",
				"# Plan\n\n## Steps\n\n### 1. First step\n\nSome spec.\n\n### 2. Second step\n\nMore spec.",
			);
			const content = readFileSync(path, "utf-8");
			expect(content).toContain("### 1. First step\n\n- [ ] 1. First step");
			expect(content).toContain("### 2. Second step\n\n- [ ] 2. Second step");
			expect(content).toContain("Some spec.");
			expect(content).toContain("More spec.");
		});

		it("does not double-insert a checkbox already present under a step heading", () => {
			const state = testState("finalize-3");
			const path = writePlan(
				state,
				"main",
				"# Plan\n\n## Context\nInfo\n\n## Steps\n\n### 1. Bridge\n\n- [ ] 1. Bridge\n\nSpec text.",
			);
			// A follow-up write/edit to the same file re-runs normalization.
			finalizePlanFileWrite(path, state);
			const count = (readFileSync(path, "utf-8").match(/- \[ \] 1\. Bridge/g) ?? []).length;
			expect(count).toBe(1);
		});

		it("leaves plans without heading-style steps untouched", () => {
			const state = testState("finalize-4");
			const content = "# Plan\n\n## Steps\n- [ ] a\n- [x] b\n\n## Verification\nRun tests";
			const path = writePlan(state, "main", content);
			expect(readFileSync(path, "utf-8")).toBe(content);
		});

		it("plan_check can close a heading-style step end to end after normalization", () => {
			const state = testState("finalize-5");
			writePlan(state, "main", "# Plan\n\n## Steps\n\n### 1. Bridge\n\nWrap the runner.\n\n### 2. Server\n\nHTTP.");

			const parsed = JSON.parse(execPlanCheck({ item: "1. Bridge" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.remaining).toBe(1);

			// The open-work gate's own source of open steps agrees: one left.
			const remaining = listOpenPlanSteps(readActivePlan(state).content);
			expect(remaining).toEqual(["2. Server"]);
		});
	});

	describe("enforcePlanCapAfterEdit", () => {
		it("accepts a result within the cap", () => {
			const state = testState("cap-1");
			const path = writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] x");
			const before = readFileSync(path, "utf-8");
			expect(enforcePlanCapAfterEdit(path, before)).toEqual({ ok: true });
			expect(readFileSync(path, "utf-8")).toBe(before);
		});

		it("rolls back and errors when the file landed over MAX_PLAN_CHARS", () => {
			const state = testState("cap-2");
			const path = writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] x");
			const before = readFileSync(path, "utf-8");
			// Simulate an edit that already landed on disk (as execEdit would have
			// done) before the cap gets checked.
			writeFileSync(path, "y".repeat(MAX_PLAN_CHARS + 1), "utf-8");

			const result = enforcePlanCapAfterEdit(path, before);
			expect(result.ok).toBe(false);
			expect(result.ok || result.error).toContain("limit is");
			// Reverted — the oversized edit must not have landed.
			expect(readFileSync(path, "utf-8")).toBe(before);
		});
	});

	describe("execPlanRead", () => {
		it("returns exists=false and an empty plan list when no plan", () => {
			const state = testState("read-1");

			const result = execPlanRead({}, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.exists).toBe(false);
			expect(parsed.plans).toEqual([]);
		});

		it("returns the active plan plus the names of all session plans", () => {
			const state = testState("read-2");

			writePlan(state, "alt", "# Alt");
			writePlan(state, "main", "# Plan\n\n## Context\nInfo");

			const result = execPlanRead({}, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.exists).toBe(true);
			expect(parsed.name).toBe("main");
			expect(parsed.headings).toEqual(["Plan", "Context"]);
			expect(parsed.content).toContain("Info");
			expect(parsed.plans).toEqual(["alt", "main"]);
		});

		it("in plan mode, reads a named plan and makes it active for subsequent edits", () => {
			const state = testState("read-3");
			state.enabled = true;

			writePlan(state, "backend", "# Backend\n\n## Steps\n- [ ] api");
			writePlan(state, "frontend", "# Frontend\n\n## Steps\n- [ ] ui");

			// frontend is active; switch to backend by reading it
			const read = JSON.parse(execPlanRead({ name: "backend" }, state).content);
			expect(read.name).toBe("backend");
			expect(read.content).toContain("api");
			expect(state.activePlanPath).toBe(join(state.plansDir, "backend.md"));

			// A subsequent write/edit now targets backend, not frontend
			writePlan(state, "backend", "# Backend\n\n## Steps\n- [ ] api v2");
			expect(readPlanFile(join(state.plansDir, "frontend.md")).content).toContain("- [ ] ui");
		});

		it("in build mode, reading a named plan is reference-only and does not switch the active plan", () => {
			const state = testState("read-3b"); // enabled stays false — build mode

			writePlan(state, "backend", "# Backend");
			writePlan(state, "frontend", "# Frontend");

			const read = JSON.parse(execPlanRead({ name: "backend" }, state).content);
			expect(read.name).toBe("backend");
			// frontend (last written) keeps steering the implementation
			expect(state.activePlanPath).toBe(join(state.plansDir, "frontend.md"));
			expect(readActivePlan(state).content).toBe("# Frontend");
		});

		it("returns error with the plan list when the named plan does not exist", () => {
			const state = testState("read-4");
			writePlan(state, "main", "# Plan");

			const result = execPlanRead({ name: "nonexistent" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.plans).toEqual(["main"]);
		});
	});

	describe("execPlanCheck", () => {
		const CHECKLIST_PLAN =
			"# Plan\n\n## Steps\n- [ ] add plan_check tool\n- [ ] wire disabledTools\n- [x] already done\n\n## Verification\nnpm test";

		it("marks a checklist item done and reports the remaining count", () => {
			const state = testState("check-1");
			writePlan(state, "main", CHECKLIST_PLAN);

			const result = execPlanCheck({ item: "wire disabledTools" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("wire disabledTools");
			expect(parsed.remaining).toBe(1);

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] wire disabledTools");
			expect(file.content).toContain("- [ ] add plan_check tool");
		});

		it("reports allDone when the last item is checked", () => {
			const state = testState("check-2");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] only step");

			const parsed = JSON.parse(execPlanCheck({ item: "only step" }, state).content);
			expect(parsed.remaining).toBe(0);
			expect(parsed.allDone).toBe(true);
		});

		it("matches case-insensitively and prefers exact over substring", () => {
			const state = testState("check-3");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] add tool\n- [ ] add tool docs");

			const parsed = JSON.parse(execPlanCheck({ item: "Add Tool" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("add tool");

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] add tool\n");
			expect(file.content).toContain("- [ ] add tool docs");
		});

		it("returns error with candidates when the item is ambiguous", () => {
			const state = testState("check-4");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] fix loop.ts\n- [ ] fix tools.ts");

			const result = execPlanCheck({ item: "fix" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			expect(parsed.matchingItems).toEqual(["1. fix loop.ts", "2. fix tools.ts"]);
		});

		it("resolves ambiguity with a 1-based index", () => {
			const state = testState("check-idx");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] fix loop.ts\n- [ ] fix tools.ts");

			const parsed = JSON.parse(execPlanCheck({ item: "fix", index: 2 }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("fix tools.ts");

			const file = readActivePlan(state);
			expect(file.content).toContain("- [ ] fix loop.ts");
			expect(file.content).toContain("- [x] fix tools.ts");
		});

		it("rejects an out-of-range index with the numbered candidates", () => {
			const state = testState("check-idx-oob");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] fix loop.ts\n- [ ] fix tools.ts");

			const result = execPlanCheck({ item: "fix", index: 5 }, state);
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content).error).toContain("out of range");
		});

		it("returns error with the remaining items when nothing matches", () => {
			const state = testState("check-5");
			writePlan(state, "main", CHECKLIST_PLAN);

			const result = execPlanCheck({ item: "nonexistent step" }, state);
			expect(result.isError).toBe(true);
			const parsed = JSON.parse(result.content);
			// Already-checked items are not offered as candidates.
			expect(parsed.uncheckedItems).toEqual(["add plan_check tool", "wire disabledTools"]);
		});

		it("returns error when the plan has no unchecked items or no plan exists", () => {
			const state = testState("check-6");
			expect(execPlanCheck({ item: "x" }, state).isError).toBe(true);

			writePlan(state, "main", "# Plan\n\n## Steps\n- [x] all done");
			expect(execPlanCheck({ item: "all done" }, state).isError).toBe(true);
		});

		it("never matches checkbox-like lines inside code fences", () => {
			const state = testState("check-fence");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] update template\n```markdown\n- [ ] update sample\n```");

			// Substring common to both — only the real step is a candidate, so no
			// ambiguity error and the fenced example stays untouched.
			const parsed = JSON.parse(execPlanCheck({ item: "update" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.item).toBe("update template");

			const file = readActivePlan(state);
			expect(file.content).toContain("- [x] update template");
			expect(file.content).toContain("- [ ] update sample");
		});

		it("checks an item off in a named plan without touching the active one", () => {
			const state = testState("check-7");
			writePlan(state, "backend", "# Backend\n\n## Steps\n- [ ] api");
			writePlan(state, "frontend", "# Frontend\n\n## Steps\n- [ ] ui");

			const parsed = JSON.parse(execPlanCheck({ item: "api", plan: "backend" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.plan).toBe("backend");

			expect(readPlanFile(join(state.plansDir, "backend.md")).content).toContain("- [x] api");
			expect(readPlanFile(join(state.plansDir, "frontend.md")).content).toContain("- [ ] ui");
			// active plan (frontend) unchanged by targeting another plan
			expect(state.activePlanPath).toBe(join(state.plansDir, "frontend.md"));
		});

		it("returns error with the plan list for an unknown plan name", () => {
			const state = testState("check-8");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] x");

			const result = execPlanCheck({ item: "x", plan: "ghost" }, state);
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content).plans).toEqual(["main"]);
		});
	});

	describe("execPlanDiscard", () => {
		it("deletes a named plan; active falls back to the newest remaining", () => {
			const state = testState("discard-1");
			writePlan(state, "keep", "# Keep");
			writePlan(state, "drop", "# Drop");
			expect(state.activePlanPath).toBe(join(state.plansDir, "drop.md"));

			const parsed = JSON.parse(execPlanDiscard({ name: "drop" }, state).content);
			expect(parsed.success).toBe(true);
			expect(parsed.discarded).toBe("drop");
			expect(parsed.plans).toEqual(["keep"]);
			expect(parsed.active).toBe("keep");
			expect(existsSync(join(state.plansDir, "drop.md"))).toBe(false);
			expect(readActivePlan(state).content).toBe("# Keep");
		});

		it("errors with the plan list for an unknown name", () => {
			const state = testState("discard-2");
			writePlan(state, "main", "# Plan");

			const result = execPlanDiscard({ name: "ghost" }, state);
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content).plans).toEqual(["main"]);
		});

		it("requires a name and neutralizes traversal", () => {
			const state = testState("discard-3");
			expect(execPlanDiscard({}, state).isError).toBe(true);
			// "../x" slugs to "x" — outside files are unreachable by construction.
			expect(execPlanDiscard({ name: "../../etc/passwd" }, state).isError).toBe(true);
		});
	});

	describe("execPlanEnter", () => {
		it("returns the plan-suggested signal with the reason", () => {
			const state = testState("enter-1");
			const parsed = JSON.parse(execPlanEnter({ reason: "touches auth across 6 files" }, state).content);
			expect(parsed.planSuggested).toBe(true);
			expect(parsed.reason).toBe("touches auth across 6 files");
		});

		it("requires a reason", () => {
			const state = testState("enter-2");
			expect(execPlanEnter({}, state).isError).toBe(true);
			expect(execPlanEnter({ reason: "  " }, state).isError).toBe(true);
		});
	});

	describe("execPlanDone", () => {
		it("returns error when no plan exists", () => {
			const state = testState("done-1");

			const result = execPlanDone({}, state);
			expect(result.isError).toBe(true);
		});

		it("returns the plan ready signal without echoing the plan content back", () => {
			const state = testState("done-2");

			writePlan(state, "auth", "# Plan\n\n## Steps\n1. Do it");

			const result = execPlanDone({ summary: "Auth refactor" }, state);
			const parsed = JSON.parse(result.content);
			expect(parsed.planReady).toBe(true);
			expect(parsed.name).toBe("auth");
			expect(parsed.summary).toBe("Auth refactor");
			// The plan is already on disk and the UI reads it itself — echoing the
			// full content back invited the model to keep "refining" instead of
			// stopping, so it is deliberately omitted. A note states the contract.
			expect(parsed.content).toBeUndefined();
			expect(parsed.path).toBeTruthy();
			expect(parsed.note).toMatch(/turn ends/i);
		});
	});
});
