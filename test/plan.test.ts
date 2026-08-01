import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkPlanFileGate,
	checkReadOnlyCommand,
	createPlanState,
	createPlanTodos,
	enforcePlanCapAfterEdit,
	execPlanDone,
	execQuestion,
	finalizePlanFileWrite,
	isPlanFilePath,
	MAX_PLAN_CHARS,
	maybeActivatePlanOnRead,
	modeDisabledTools,
	PLAN_TOOL_NAMES,
	type PlanState,
	planChecklistState,
	readActivePlan,
	readPlanFile,
	readPlanQuestion,
	readPlanTransition,
	resolveActivePlanPath,
	resolvePlanQuestion,
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
			expect(gated).not.toContain("plan_done");
			// bash stays advertised — the executor's read-only gate handles it
			expect(gated).not.toContain("bash");
			// SSH is an arbitrary remote-command surface; unlike bash it has no
			// local read-only command gate, so plan mode removes it entirely.
			expect(gated).toContain("ssh");
			// read has no plan-mode-specific gating at all (see
			// maybeActivatePlanOnRead) — it's simply never in either list.
			expect(gated).not.toContain("read");
			expect(gated).not.toContain("question");
		});

		it("build mode blocks exactly the authoring-signal plan tools", () => {
			const gated = modeDisabledTools(false);
			expect([...gated].sort()).toEqual(["plan_done"]);
			expect(gated).not.toContain("question");
		});

		it("every plan tool has an explicit mode decision", () => {
			// A new PLAN_TOOL_NAMES entry must be placed in exactly one mode's
			// gate list. This test fails the moment someone adds a tool without
			// deciding (there is no dual-mode plan tool anymore — plan_read was
			// the last one, replaced by plain read + maybeActivatePlanOnRead).
			const planGated = new Set(modeDisabledTools(true).filter((n) => n.startsWith("plan_")));
			const buildGated = new Set(modeDisabledTools(false));
			for (const name of PLAN_TOOL_NAMES) {
				const decisions = [planGated.has(name), buildGated.has(name)].filter(Boolean).length;
				expect(decisions, `tool ${name} needs exactly one mode decision`).toBe(1);
			}
		});
	});

	describe("createPlanState", () => {
		it("derives a per-session plans directory", () => {
			const state = createPlanState("/project", "abc");
			expect(state.plansDir).toBe(join("/project", ".cast", "plans", "abc"));
			expect(state.enabled).toBe(false);
			expect(state.activePlanPath).toBeUndefined();
		});
	});

	describe("createPlanTodos", () => {
		it("projects open approved-plan steps into linked build todos", () => {
			const state = testState("todo-projection");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] add API\n- [x] old migration\n- [ ] verify UI");
			expect(createPlanTodos(state)).toEqual([
				{ content: "add API", status: "pending", priority: "medium", planStep: "add API" },
				{ content: "verify UI", status: "pending", priority: "medium", planStep: "verify UI" },
			]);
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
		async function expectCommand(command: string, ok: boolean): Promise<void> {
			expect((await checkReadOnlyCommand(command)).ok).toBe(ok);
		}

		it("allows inspection pipelines", async () => {
			await expectCommand("ls -la", true);
			await expectCommand("cat src/app.ts | grep -n handler | head -5", true);
			await expectCommand("git log --oneline -10 && git status", true);
			await expectCommand("git diff HEAD~1 -- src/", true);
			await expectCommand("LC_ALL=C sort file.txt | uniq -c", true);
		});

		it("allows fd-duplication and null-device redirects — neither writes a real file", async () => {
			await expectCommand("ls -la /tmp/foo 2>&1", true);
			await expectCommand("cat foo 2>&1 | grep bar", true);
			await expectCommand("ls -la /tmp/foo 2>/dev/null", true);
			await expectCommand("ls -la /tmp/foo >/dev/null 2>&1", true);
			// The redirect being safe doesn't whitelist an otherwise-unsafe command.
			await expectCommand("rm -rf /tmp/x 2>&1", false);
		});

		it("rejects anything that can write", async () => {
			for (const command of [
				"rm -rf /tmp/x",
				"echo hi > out.txt",
				"cat $(find_evil)",
				"ls `rm -rf .`",
				"npm test",
				"sed -i 's/a/b/' file",
				"git checkout main",
				"git branch new-branch",
				"ls && touch x",
				"find . -name '*.md' | xargs rm",
				"",
			])
				await expectCommand(command, false);
		});

		it("rejects argument-level writers and executors on allowlisted binaries", async () => {
			// find/fd can delete or exec through flags
			await expectCommand("find . -name '*.tmp' -delete", false);
			await expectCommand("find . -exec rm {} \\;", false);
			await expectCommand("fd -x rm", false);
			// output flags write without any `>`
			await expectCommand("sort -o out.txt in.txt", false);
			await expectCommand("sort --compress-program='touch should-not-run' in.txt", false);
			await expectCommand("tree -o out.txt", false);
			await expectCommand("git log --output=/tmp/x", false);
			await expectCommand("git log --output /tmp/x", false);
			// process substitution executes commands
			await expectCommand("diff <(rm -rf x) file", false);
			// env launches arbitrary binaries
			await expectCommand("env sh -c 'rm -rf x'", false);
			// uniq's second positional argument is an output file
			await expectCommand("uniq input.txt output.txt", false);
			// ...while the plain read-only forms of the same binaries still pass
			await expectCommand("find . -name '*.md' -type f", true);
			await expectCommand("sort in.txt | uniq -c", true);
			await expectCommand("git log --oneline", true);
			await expectCommand("yq -i '.version = 2' package.yaml", false);
			await expectCommand("date -s 'next week'", false);
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

		it("keeps normalized heading-style steps intact for todo projection", () => {
			const state = testState("finalize-5");
			writePlan(state, "main", "# Plan\n\n## Steps\n\n### 1. Bridge\n\nWrap the runner.\n\n### 2. Server\n\nHTTP.");

			expect(createPlanTodos(state).map((todo) => todo.content)).toEqual(["1. Bridge", "2. Server"]);
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

	describe("maybeActivatePlanOnRead", () => {
		// Stand-in for what tools.ts's dispatcher does after a successful `read`
		// while plan mode is active — see plan.ts's file doc comment for why
		// there's no dedicated plan_read tool anymore.

		it("in plan mode, reading a plan file makes it the active one", () => {
			const state = testState("read-3");
			state.enabled = true;

			writePlan(state, "backend", "# Backend\n\n## Steps\n- [ ] api");
			writePlan(state, "frontend", "# Frontend\n\n## Steps\n- [ ] ui");
			// frontend is active (written last); switch to backend by reading it.
			maybeActivatePlanOnRead(join(state.plansDir, "backend.md"), state);
			expect(state.activePlanPath).toBe(join(state.plansDir, "backend.md"));

			// A subsequent write/edit now targets backend, not frontend
			writePlan(state, "backend", "# Backend\n\n## Steps\n- [ ] api v2");
			expect(readPlanFile(join(state.plansDir, "frontend.md")).content).toContain("- [ ] ui");
		});

		it("in build mode, reading a plan file is reference-only and does not switch the active plan", () => {
			const state = testState("read-3b"); // enabled stays false — build mode

			writePlan(state, "backend", "# Backend");
			writePlan(state, "frontend", "# Frontend");

			maybeActivatePlanOnRead(join(state.plansDir, "backend.md"), state);
			// frontend (last written) keeps steering the implementation
			expect(state.activePlanPath).toBe(join(state.plansDir, "frontend.md"));
			expect(readActivePlan(state).content).toBe("# Frontend");
		});

		it("does nothing for a path outside plansDir, even in plan mode", () => {
			const state = testState("read-3c");
			state.enabled = true;
			writePlan(state, "main", "# Plan");

			maybeActivatePlanOnRead("/home/user/project/src/index.ts", state);
			expect(state.activePlanPath).toBe(join(state.plansDir, "main.md"));
		});
	});

	/* Removed with plan_check: plans are immutable specifications and todo_write
	 * is the sole execution-state surface. Retained test history below is kept
	 * inert until the next test-file consolidation. */
	/* describe("execPlanCheck", () => {
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

		// A real model-authored plan wraps long step descriptions across
		// several lines (only the first carries the "- [ ]" marker) and
		// routinely decorates them with markdown (**bold**, `code`) — a style
		// the plan-mode prompt explicitly encourages ("concrete", "name the
		// exact target"). Confirmed live against a real generated plan: neither
		// a plain-text recall of the visible words nor a decoration-stripped
		// paraphrase matched before this was fixed — only a byte-exact copy of
		// the markdown did, which no model naturally reproduces a turn later.
		describe("wrapped, markdown-decorated steps (real-plan shape)", () => {
			const WRAPPED_PLAN =
				"# Plan\n\n## Steps\n\n" +
				"- [ ] **Add the `deleted` Set** at the top of `server.js`,\n" +
				"      immediately after the existing `const widgets = [];` on line 3.\n" +
				"      One line: `const deleted = new Set();`. No abstraction.\n" +
				"- [ ] **Add the DELETE branch** in `server.js`, placed inside the\n" +
				"      existing `http.createServer` callback.\n" +
				"\n## Verification\nnpm test";

			it("matches a plain-text recall with no markdown decoration", () => {
				const state = testState("check-wrap-1");
				writePlan(state, "main", WRAPPED_PLAN);

				const parsed = JSON.parse(execPlanCheck({ item: "Add the deleted Set" }, state).content);
				expect(parsed.success).toBe(true);
				expect(readActivePlan(state).content).toContain("[x] **Add the `deleted` Set**");
			});

			it("matches text that only appears in a wrapped continuation line", () => {
				const state = testState("check-wrap-2");
				writePlan(state, "main", WRAPPED_PLAN);

				const parsed = JSON.parse(
					execPlanCheck({ item: "immediately after the existing const widgets" }, state).content,
				);
				expect(parsed.success).toBe(true);
			});

			it("still matches an exact copy of the markdown-decorated text", () => {
				const state = testState("check-wrap-3");
				writePlan(state, "main", WRAPPED_PLAN);

				const parsed = JSON.parse(execPlanCheck({ item: "**Add the `deleted` Set**" }, state).content);
				expect(parsed.success).toBe(true);
			});

			it("matches a short natural paraphrase of a different wrapped item", () => {
				const state = testState("check-wrap-4");
				writePlan(state, "main", WRAPPED_PLAN);

				const parsed = JSON.parse(execPlanCheck({ item: "add the delete branch" }, state).content);
				expect(parsed.success).toBe(true);
				expect(parsed.item).toContain("DELETE branch");
			});

			it("stops the continuation at the next bullet, not bleeding into the following item", () => {
				const state = testState("check-wrap-5");
				writePlan(state, "main", WRAPPED_PLAN);

				const parsed = JSON.parse(execPlanCheck({ item: "no abstraction" }, state).content);
				expect(parsed.success).toBe(true);
				expect(parsed.item).not.toContain("DELETE branch");
			});

			it("only flips the marker line's checkbox, leaving continuation lines untouched", () => {
				const state = testState("check-wrap-6");
				writePlan(state, "main", WRAPPED_PLAN);

				execPlanCheck({ item: "Add the deleted Set" }, state);
				const content = readActivePlan(state).content;
				expect(content).toContain("      immediately after the existing `const widgets = [];` on line 3.");
				expect(content).toContain("      One line: `const deleted = new Set();`. No abstraction.");
				// The second item's marker is untouched.
				expect(content).toContain("- [ ] **Add the DELETE branch**");
			});

			// Confirmed live: a step with its own nested sub-bullets (elaborating
			// on that one step, not separate steps) gets passed back to
			// plan_check by the model as ONE continuous string, sub-bullets
			// included verbatim. Capturing only the marker line's text (stopping
			// at ANY bullet, regardless of indentation) made the stored text a
			// strict prefix of what the model actually sent — a real failure
			// against a real generated plan.
			it("includes a step's own nested (more-indented) sub-bullets in its matchable text", () => {
				const state = testState("check-wrap-nested");
				const NESTED_PLAN =
					"# Plan\n\n## Steps\n\n" +
					"- [ ] Parse the path segment:\n" +
					"  - Require a leading slash.\n" +
					"  - Reject empty segments.\n" +
					"- [ ] Another sibling step\n";
				writePlan(state, "main", NESTED_PLAN);

				const item = "Parse the path segment:\n  - Require a leading slash.\n  - Reject empty segments.";
				const parsed = JSON.parse(execPlanCheck({ item }, state).content);
				expect(parsed.success).toBe(true);
				expect(readActivePlan(state).content).toContain("- [x] Parse the path segment:");
			});

			it("still stops at a sibling bullet at the same indentation as the marker", () => {
				const state = testState("check-wrap-sibling");
				const NESTED_PLAN =
					"# Plan\n\n## Steps\n\n" +
					"- [ ] Parse the path segment:\n" +
					"  - Require a leading slash.\n" +
					"- [ ] Another sibling step\n";
				writePlan(state, "main", NESTED_PLAN);

				const parsed = JSON.parse(execPlanCheck({ item: "Another sibling step" }, state).content);
				expect(parsed.success).toBe(true);
				expect(parsed.item).toBe("Another sibling step");
				expect(parsed.item).not.toContain("leading slash");
			});
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
	}); */

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

	describe("execQuestion", () => {
		it("persists a valid question until the UI resolves it", () => {
			const state = testState("question-1");
			const result = execQuestion(
				{
					questions: [
						{
							question: "Choose a cache backend",
							options: [
								{ value: "memory", label: "In-memory", description: "No operational dependency" },
								{ value: "redis", label: "Redis", description: "Shared cache" },
							],
							recommended: "memory",
						},
						{
							question: "Choose deployment target",
							options: [
								{ value: "cloud", label: "Cloud" },
								{ value: "self-hosted", label: "Self-hosted" },
							],
						},
					],
				},
				state,
			);

			expect(result.isError).toBeFalsy();
			expect(JSON.parse(result.content).question).toBe(true);
			expect(readPlanQuestion(state)?.questions[0]).toMatchObject({
				question: "Choose a cache backend",
				recommended: "memory",
			});
			expect(readPlanQuestion(state)?.questions).toHaveLength(2);

			resolvePlanQuestion(state);
			expect(readPlanQuestion(state)).toBeUndefined();
		});

		it("requires distinct, bounded choices", () => {
			const state = testState("question-2");
			const result = execQuestion(
				{
					questions: [
						{
							question: "Choose",
							options: [
								{ value: "same", label: "One" },
								{ value: "same", label: "Two" },
							],
						},
					],
				},
				state,
			);
			expect(result.isError).toBe(true);
		});
	});

	describe("plan transitions", () => {
		it("persists plan approval after the active plan passes validation", () => {
			const state = testState("transition-done");
			writePlan(state, "main", "# Plan\n\n## Steps\n- [ ] implement it");
			expect(execPlanDone({}, state).isError).toBeFalsy();
			expect(readPlanTransition(state)).toEqual({ kind: "done" });
		});
	});
});
