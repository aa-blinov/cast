import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildReviewScope,
	collectReviewFiles,
	formatFindingVerdicts,
	formatReviewBrief,
	groupReviewFiles,
	MAX_FILES_PER_GROUP,
	parseFindings,
	parseReviewArgs,
	type ReviewFile,
	readReviewState,
	rulesForFiles,
	startReviewState,
	verifyFindings,
} from "../src/core/review.ts";

const file = (path: string, changedLines = 10, status: ReviewFile["status"] = "modified"): ReviewFile => ({
	path,
	status,
	changedLines,
});

let repo: string;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

beforeEach(() => {
	repo = mkdtempSync(join(tmpdir(), "cast-review-test-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("review scope from git", () => {
	it("collects staged, unstaged and untracked changes together", async () => {
		writeFileSync(join(repo, "seed.txt"), "seed\nchanged\n");
		writeFileSync(join(repo, "staged.ts"), "export const a = 1;\n");
		git("add", "staged.ts");
		writeFileSync(join(repo, "untracked.ts"), "export const b = 2;\n");

		const { files } = await collectReviewFiles(repo);
		const paths = files.map((f) => f.path);
		expect(paths).toContain("seed.txt");
		expect(paths).toContain("staged.ts");
		expect(paths).toContain("untracked.ts");
	});

	// The filter is the point of doing selection in code: whether a lockfile is
	// worth reviewing is not a judgement call worth a model's attention.
	it("filters installed, generated and binary paths and says why", async () => {
		mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "package-lock.json"), "{}\n");
		writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
		writeFileSync(join(repo, "logo.png"), "not really a png");
		writeFileSync(join(repo, "src", "real.ts"), "export const real = 1;\n");

		const { files, skipped } = await collectReviewFiles(repo);
		expect(files.map((f) => f.path)).toEqual(["src/real.ts"]);
		const reasons = new Map(skipped.map((f) => [f.path, f.skipped]));
		expect(reasons.get("package-lock.json")).toBe("lockfile");
		expect(reasons.get("node_modules/dep/index.js")).toBe("installed or generated directory");
		expect(reasons.get("logo.png")).toBe("binary or asset");
	});

	// numstat says nothing about untracked files, so a new file used to report
	// zero changed lines — and a 900-line one never earned its own review unit.
	it("counts the lines of an untracked file", async () => {
		writeFileSync(join(repo, "big.ts"), `${"export const x = 1;\n".repeat(500)}`);
		const { files } = await collectReviewFiles(repo);
		const big = files.find((f) => f.path === "big.ts");
		expect(big?.changedLines).toBeGreaterThan(400);
		const groups = groupReviewFiles(files);
		const unit = groups.find((g) => g.files.some((f) => f.path === "big.ts"));
		expect(unit?.label).toContain("large change");
	});

	it("reads a git range instead of the working tree when given one", async () => {
		writeFileSync(join(repo, "one.ts"), "export const one = 1;\n");
		git("add", "-A");
		git("commit", "-qm", "one");
		writeFileSync(join(repo, "two.ts"), "export const two = 2;\n");
		git("add", "-A");
		git("commit", "-qm", "two");

		const { files } = await collectReviewFiles(repo, "HEAD~1..HEAD");
		expect(files.map((f) => f.path)).toEqual(["two.ts"]);
	});

	it("reports an empty scope rather than inventing one", async () => {
		const scope = await buildReviewScope(repo);
		expect(scope.files).toEqual([]);
		expect(formatReviewBrief(scope)).toContain("No reviewable changes");
	});
});

describe("arguments", () => {
	it("splits a range from the paths that narrow it", () => {
		expect(parseReviewArgs("")).toEqual({ paths: [] });
		expect(parseReviewArgs("HEAD~2..HEAD")).toEqual({ range: "HEAD~2..HEAD", paths: [] });
		expect(parseReviewArgs("-- src/ test/")).toEqual({ range: undefined, paths: ["src/", "test/"] });
		expect(parseReviewArgs("main..feature -- src/core")).toEqual({
			range: "main..feature",
			paths: ["src/core"],
		});
	});

	// The case this exists for: a change too large to review in one turn, where
	// the useful axis is a subtree rather than a different git range.
	it("narrows the scope to the given paths", async () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		mkdirSync(join(repo, "docs"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "docs", "b.md"), "# b\n");

		const all = await buildReviewScope(repo);
		expect(all.files.map((f) => f.path).sort()).toEqual(["docs/b.md", "src/a.ts"]);

		const narrowed = await buildReviewScope(repo, undefined, ["src"]);
		expect(narrowed.files.map((f) => f.path)).toEqual(["src/a.ts"]);
		// A path the user excluded is out of scope, not "filtered as generated".
		expect(narrowed.skipped).toHaveLength(0);
		expect(narrowed.range).toContain("limited to src");
	});
});

describe("grouping", () => {
	// A test and its implementation are the pair a directory bucket misses —
	// they routinely live in src/ and test/ — and a change to one without the
	// other is what the reviewer needs both halves to see.
	it("keeps a test with its implementation across directories", () => {
		const groups = groupReviewFiles([file("src/handler.ts"), file("src/handler.test.ts"), file("src/other.ts")]);
		const unitFor = (path: string) => groups.find((g) => g.files.some((f) => f.path === path));
		expect(unitFor("src/handler.ts")).toBe(unitFor("src/handler.test.ts"));
	});

	// Locale suffixes used to be in the sibling key. Translations of one bundle
	// share a directory, so they were already one unit without a special rule.
	it("groups translations by their directory without a locale rule", () => {
		const groups = groupReviewFiles([file("i18n/message_en.properties"), file("i18n/message_zh.properties")]);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.files).toHaveLength(2);
	});

	it("gives a large change a unit of its own", () => {
		const groups = groupReviewFiles([file("src/huge.ts", 900), file("src/small.ts", 5)]);
		const huge = groups.find((g) => g.files.some((f) => f.path === "src/huge.ts"));
		expect(huge?.files).toHaveLength(1);
		expect(huge?.label).toContain("large change");
	});

	it("splits a directory that exceeds the per-unit cap", () => {
		const many = Array.from({ length: MAX_FILES_PER_GROUP * 2 + 1 }, (_, i) => file(`src/f${i}.py`));
		const groups = groupReviewFiles(many);
		expect(groups.length).toBeGreaterThan(1);
		for (const group of groups) expect(group.files.length).toBeLessThanOrEqual(MAX_FILES_PER_GROUP);
		// Every file lands in exactly one unit — the selection promise is that
		// nothing is silently dropped.
		const seen = groups.flatMap((g) => g.files.map((f) => f.path));
		expect(new Set(seen).size).toBe(many.length);
	});
});

describe("rules", () => {
	it("loads only the languages present, plus the shared default", () => {
		const names = rulesForFiles([file("src/a.ts"), file("scripts/b.sh")]).map((r) => r.name);
		expect(names).toContain("default");
		expect(names).toContain("typescript");
		expect(names).toContain("shell");
		expect(names).not.toContain("python");
		expect(names).not.toContain("go");
	});

	it("carries the precision-over-recall rule and the no-duplicating-the-linter rule", () => {
		const bodies = rulesForFiles([file("src/a.go")])
			.map((r) => r.body)
			.join("\n");
		expect(bodies).toMatch(/precision over recall/i);
		expect(bodies).toMatch(/linter|go vet|staticcheck/i);
	});
});

describe("finding positions", () => {
	it("passes a finding whose quote is on the line it claims", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "const a = 1;\nconst b = 2;\n");
		const verdicts = verifyFindings(
			repo,
			[{ path: "src/a.ts", line: 2, quote: "const b = 2;", issue: "b is unused" }],
			{ files: [file("src/a.ts")] },
		);
		expect(verdicts[0]!.status).toBe("ok");
	});

	// Position drift is the failure this check exists for: the observation can
	// be right while the line is six off, and a reader who looks at the wrong
	// line stops trusting the rest.
	it("moves a finding to where the quoted code actually is", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "// head\n// head\n// head\nconst target = 1;\n");
		const verdicts = verifyFindings(
			repo,
			[{ path: "src/a.ts", line: 1, quote: "const target = 1;", issue: "wrong" }],
			{ files: [file("src/a.ts")] },
		);
		const verdict = verdicts[0]!;
		expect(verdict.status).toBe("relocated");
		expect(verdict.finding.line).toBe(4);
		if (verdict.status === "relocated") expect(verdict.from).toBe(1);
	});

	it("drops a finding whose quoted code is nowhere in the file", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "const a = 1;\n");
		const verdicts = verifyFindings(
			repo,
			[{ path: "src/a.ts", line: 1, quote: "doSomethingThatDoesNotExist()", issue: "invented" }],
			{ files: [file("src/a.ts")] },
		);
		expect(verdicts[0]!.status).toBe("dropped");
		expect(verdicts[0]!.note).toContain("not in src/a.ts at all");
	});

	it("drops a finding about a file outside the review scope", () => {
		const verdicts = verifyFindings(repo, [{ path: "other/x.ts", line: 1, issue: "off-scope" }], {
			files: [file("src/a.ts")],
		});
		expect(verdicts[0]!.status).toBe("dropped");
		expect(verdicts[0]!.note).toContain("not in the review scope");
	});

	// Not a drop: a change that breaks an untouched caller is worth reporting,
	// and the reader needs to know the line is context rather than diff.
	it("flags a finding on an unchanged line instead of dropping it", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "const caller = target();\nconst target = 1;\n");
		const verdicts = verifyFindings(
			repo,
			[{ path: "src/a.ts", line: 1, quote: "const caller = target();", issue: "breaks the caller" }],
			{ files: [file("src/a.ts")] },
			new Map([["src/a.ts", [{ start: 2, end: 2 }]]]),
		);
		expect(verdicts[0]!.status).toBe("unchanged-line");
	});

	it("range-checks a finding that quotes nothing", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "const a = 1;\n");
		const ok = verifyFindings(repo, [{ path: "src/a.ts", line: 1, issue: "no quote" }], {
			files: [file("src/a.ts")],
		});
		expect(ok[0]!.status).toBe("ok");
		const off = verifyFindings(repo, [{ path: "src/a.ts", line: 99, issue: "no quote" }], {
			files: [file("src/a.ts")],
		});
		expect(off[0]!.status).toBe("dropped");
	});

	it("keeps only well-formed findings from the tool argument", () => {
		const findings = parseFindings([
			{ path: "a.ts", line: 3, issue: "real", quote: "x" },
			{ path: "a.ts", issue: "no line" },
			{ line: 2, issue: "no path" },
			"nonsense",
		]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toEqual({ path: "a.ts", line: 3, issue: "real", quote: "x" });
	});

	it("tells the reporter what stands and what went", () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "const a = 1;\n");
		const text = formatFindingVerdicts(
			verifyFindings(
				repo,
				[
					{ path: "src/a.ts", line: 1, quote: "const a = 1;", issue: "kept" },
					{ path: "src/a.ts", line: 1, quote: "nope()", issue: "gone" },
				],
				{ files: [file("src/a.ts")] },
			),
		);
		expect(text).toContain("1 stand, 1 dropped");
		expect(text).toContain("Do not restate a dropped finding");
	});
});

describe("review state", () => {
	// Every ordinary ending clears the state; a crash between opening a review
	// and finishing it is the one that doesn't, and a stale scope would offer
	// the tool in unrelated later turns.
	it("treats an abandoned review as closed after a day", async () => {
		const home = mkdtempSync(join(tmpdir(), "cast-review-state-"));
		const realHome = process.env.HOME;
		process.env.HOME = home;
		try {
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
			const scope = await buildReviewScope(repo);
			await startReviewState("stale-session", repo, scope);
			expect(readReviewState("stale-session")).toBeDefined();

			const path = join(home, ".cast", "reviews", "stale-session.json");
			const state = JSON.parse(readFileSync(path, "utf-8"));
			state.startedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
			writeFileSync(path, JSON.stringify(state), "utf-8");
			expect(readReviewState("stale-session")).toBeUndefined();
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("brief", () => {
	it("states the scope as fact and names every group", async () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "package-lock.json"), "{}\n");
		const scope = await buildReviewScope(repo);
		const brief = formatReviewBrief(scope);

		expect(brief).toContain("computed, not guessed");
		expect(brief).toContain("src/a.ts");
		// The brief routes findings through the checked tool, not through prose.
		expect(brief).toContain("review_report");
		expect(brief).toContain("quote");
		// The filtered file is named as out of scope, so the reviewer doesn't
		// go looking for it or wonder whether it was missed.
		expect(brief).toContain("do not review these: package-lock.json");
		expect(brief).toMatch(/precision over recall/i);
	});

	it("asks for one task per group only when the persona can delegate", async () => {
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
		const scope = await buildReviewScope(repo);
		expect(formatReviewBrief(scope, { delegate: true })).toContain("One `task` per group");
		expect(formatReviewBrief(scope, { delegate: false })).not.toContain("One `task` per group");
	});

	// chalk keeps its fix in source/vendor/supports-color/. Filtering that away
	// left one measured review with an empty scope and missed the defect in
	// another: vendored code is checked in and edited by hand, unlike node_modules.
	it("reviews vendored code, which is hand-edited, unlike an installed package", async () => {
		mkdirSync(join(repo, "source", "vendor", "dep"), { recursive: true });
		mkdirSync(join(repo, "third_party"), { recursive: true });
		writeFileSync(join(repo, "source", "vendor", "dep", "index.js"), "export const a = 1;\n");
		writeFileSync(join(repo, "third_party", "lib.js"), "export const b = 2;\n");

		const { files, skipped } = await collectReviewFiles(repo);
		expect(files.map((f) => f.path).sort()).toEqual(["source/vendor/dep/index.js", "third_party/lib.js"]);
		expect(skipped).toHaveLength(0);
	});
});
