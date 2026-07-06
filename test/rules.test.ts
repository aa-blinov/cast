import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	discoverProjectRuleDirs,
	fileMatchesGlob,
	formatActiveRulesPrompt,
	formatAlwaysApplyRules,
	formatLazyRulesForPrompt,
	formatRuleInvocation,
	formatRulesForTurn,
	hasProjectRulesDir,
	loadDirectoryRules,
	matchAutoRules,
	matchesRuleGlobs,
	parseAtMentions,
	type Rule,
	readRuleBody,
	ruleScopeActive,
	selectMentionedRules,
	unionStickyRules,
} from "../src/core/rules.ts";

describe("rules", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let projectDir: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-rules-test-"));
		process.env.HOME = fakeHome;
		projectDir = join(fakeHome, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	describe("hasProjectRulesDir", () => {
		it("returns false when .cast/rules/ does not exist", () => {
			expect(hasProjectRulesDir(projectDir)).toBe(false);
		});

		it("returns false when .cast/rules/ is empty", () => {
			mkdirSync(join(projectDir, ".cast", "rules"), { recursive: true });
			expect(hasProjectRulesDir(projectDir)).toBe(false);
		});

		it("returns true when .cast/rules/ contains .md files", () => {
			const dir = join(projectDir, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "test.md"), "---\nalwaysApply: true\n---\nBody");
			expect(hasProjectRulesDir(projectDir)).toBe(true);
		});
	});

	describe("loadDirectoryRules", () => {
		it("returns empty array when directories don't exist", () => {
			expect(loadDirectoryRules({})).toEqual([]);
		});

		it("loads rules from global dir", () => {
			const globalDir = join(fakeHome, ".cast", "rules");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "global-rule.md"),
				'---\nalwaysApply: true\ndescription: "Global rule"\n---\nGlobal body',
			);
			const rules = loadDirectoryRules({ globalDir });
			expect(rules).toHaveLength(1);
			expect(rules[0]!.name).toBe("global-rule");
			expect(rules[0]!.source).toBe("global");
			expect(rules[0]!.alwaysApply).toBe(true);
			expect(rules[0]!.description).toBe("Global rule");
		});

		it("loads rules from project dir", () => {
			const projDir = join(projectDir, ".cast", "rules");
			mkdirSync(projDir, { recursive: true });
			writeFileSync(join(projDir, "proj-rule.md"), '---\ndescription: "Project rule"\n---\nProject body');
			const rules = loadDirectoryRules({ projectDir: projDir });
			expect(rules).toHaveLength(1);
			expect(rules[0]!.name).toBe("proj-rule");
			expect(rules[0]!.source).toBe("project");
			expect(rules[0]!.alwaysApply).toBe(false);
		});

		it("project rules take priority over global rules with same name", () => {
			const globalDir = join(fakeHome, ".cast", "rules");
			const projDir = join(projectDir, ".cast", "rules");
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projDir, { recursive: true });
			writeFileSync(join(globalDir, "dup.md"), "---\ndescription: global\n---\nglobal");
			writeFileSync(join(projDir, "dup.md"), "---\ndescription: project\n---\nproject");
			const rules = loadDirectoryRules({ globalDir, projectDir: projDir });
			const dup = rules.find((r) => r.name === "dup");
			expect(dup!.source).toBe("project");
		});

		it("derives name from filename when frontmatter has no name", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "my-rule.md"), "---\nalwaysApply: true\n---\nBody");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules[0]!.name).toBe("my-rule");
		});

		it("uses frontmatter name when provided", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "file.md"), "---\nname: custom-name\nalwaysApply: true\n---\nBody");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules[0]!.name).toBe("custom-name");
		});

		it("loads manual-only rules (no alwaysApply, no description)", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "manual.md"), "---\n---\nManual body");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules).toHaveLength(1);
			expect(rules[0]!.alwaysApply).toBe(false);
			expect(rules[0]!.description).toBe("");
		});

		it("sorts rules alphabetically by filename", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "zebra.md"), "---\nalwaysApply: true\n---\nZ");
			writeFileSync(join(dir, "alpha.md"), "---\nalwaysApply: true\n---\nA");
			writeFileSync(join(dir, "middle.md"), "---\nalwaysApply: true\n---\nM");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules.map((r) => r.name)).toEqual(["alpha", "middle", "zebra"]);
		});

		it("ignores non-.md files", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "rule.md"), "---\nalwaysApply: true\n---\nBody");
			writeFileSync(join(dir, "notes.txt"), "not a rule");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules).toHaveLength(1);
		});
	});

	describe("formatAlwaysApplyRules", () => {
		it("returns empty string when no always-apply rules", () => {
			const rules: Rule[] = [
				{
					name: "lazy",
					id: "lazy",
					scope: "",
					description: "desc",
					filePath: "/fake/lazy.md",
					baseDir: "/fake",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "lazy",
				},
			];
			expect(formatAlwaysApplyRules(rules)).toBe("");
		});

		it("wraps always-apply rule bodies in <rules> tags", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "always.md"), "---\nalwaysApply: true\n---\nAlways do this.");
			const rules = loadDirectoryRules({ globalDir: dir });
			const formatted = formatAlwaysApplyRules(rules);
			expect(formatted).toContain("<rules>");
			expect(formatted).toContain("Always do this.");
			expect(formatted).toContain("</rules>");
		});

		it("separates multiple always-apply rules with blank lines", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "a.md"), "---\nalwaysApply: true\n---\nRule A.");
			writeFileSync(join(dir, "b.md"), "---\nalwaysApply: true\n---\nRule B.");
			const rules = loadDirectoryRules({ globalDir: dir });
			const formatted = formatAlwaysApplyRules(rules);
			expect(formatted).toContain("Rule A.");
			expect(formatted).toContain("Rule B.");
		});
	});

	describe("formatLazyRulesForPrompt", () => {
		it("returns empty string when no lazy rules", () => {
			const rules: Rule[] = [
				{
					name: "always",
					id: "always",
					scope: "",
					description: "",
					filePath: "/fake/always.md",
					baseDir: "/fake",
					source: "global",
					alwaysApply: true,
					globs: [],
					applyMode: "always",
				},
			];
			expect(formatLazyRulesForPrompt(rules)).toBe("");
		});

		it("returns empty string for manual-only rules (no description)", () => {
			const rules: Rule[] = [
				{
					name: "manual",
					id: "manual",
					scope: "",
					description: "",
					filePath: "/fake/manual.md",
					baseDir: "/fake",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "manual",
				},
			];
			expect(formatLazyRulesForPrompt(rules)).toBe("");
		});

		it("formats lazy rules as XML with instructions", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "style.md"), '---\ndescription: "Code style rules"\n---\nFull content here.');
			const rules = loadDirectoryRules({ globalDir: dir });
			const formatted = formatLazyRulesForPrompt(rules);
			expect(formatted).toContain("<available_rules>");
			expect(formatted).toContain("<name>style</name>");
			expect(formatted).toContain("<description>Code style rules</description>");
			expect(formatted).toContain("</available_rules>");
		});

		it("escapes XML special characters in name and description", () => {
			const rules: Rule[] = [
				{
					name: "a&b",
					id: "a&b",
					scope: "",
					description: 'c<d "e"',
					filePath: "/fake/rule.md",
					baseDir: "/fake",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "lazy",
				},
			];
			const formatted = formatLazyRulesForPrompt(rules);
			expect(formatted).toContain("a&amp;b");
			expect(formatted).toContain("c&lt;d &quot;e&quot;");
		});
	});

	describe("formatRuleInvocation", () => {
		it("wraps rule content in <rule> tags with name and location", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "test.md"), '---\ndescription: "Test"\n---\nRule body content.');
			const rules = loadDirectoryRules({ globalDir: dir });
			const invocation = formatRuleInvocation(rules[0]!);
			expect(invocation).toContain('<rule name="test"');
			expect(invocation).toContain("Rule body content.");
			expect(invocation).toContain(`References are relative to ${dir}`);
		});
	});

	describe("readRuleBody", () => {
		it("returns body with frontmatter stripped", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "test.md"), "---\nalwaysApply: true\n---\nJust the body.");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(readRuleBody(rules[0]!)).toBe("Just the body.");
		});
	});

	describe("globs parsing", () => {
		it("parses globs from inline YAML array", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "go.md"), '---\nalwaysApply: true\nglobs: ["**/*.go", "**/go.mod"]\n---\nGo rules');
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules[0]!.globs).toEqual(["**/*.go", "**/go.mod"]);
			expect(rules[0]!.applyMode).toBe("always");
		});

		it("parses single globs string", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "tsx.md"), "---\nalwaysApply: true\nglobs: src/components/**/*.tsx\n---\nTSX rules");
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules[0]!.globs).toEqual(["src/components/**/*.tsx"]);
		});

		it("supports paths as alias for globs", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "py.md"), '---\nalwaysApply: true\npaths: ["**/*.py"]\n---\nPython rules');
			const rules = loadDirectoryRules({ globalDir: dir });
			expect(rules[0]!.globs).toEqual(["**/*.py"]);
		});

		it("classifies apply mode correctly", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "auto.md"), "---\nalwaysApply: true\n---\nAuto");
			writeFileSync(join(dir, "lazy.md"), '---\ndescription: "desc"\n---\nLazy');
			writeFileSync(join(dir, "manual.md"), "---\n---\nManual");
			const rules = loadDirectoryRules({ globalDir: dir });
			const byName = new Map(rules.map((r) => [r.name, r]));
			expect(byName.get("auto")!.applyMode).toBe("always");
			expect(byName.get("lazy")!.applyMode).toBe("lazy");
			expect(byName.get("manual")!.applyMode).toBe("manual");
		});
	});

	describe("fileMatchesGlob", () => {
		it("matches **/*.go pattern", () => {
			expect(fileMatchesGlob("**/*.go", "main.go")).toBe(true);
			expect(fileMatchesGlob("**/*.go", "internal/agent/react.go")).toBe(true);
			expect(fileMatchesGlob("**/*.go", "main.ts")).toBe(false);
		});

		it("matches **/*.tsx pattern", () => {
			expect(fileMatchesGlob("**/*.tsx", "src/components/App.tsx")).toBe(true);
			expect(fileMatchesGlob("**/*.tsx", "main.ts")).toBe(false);
		});

		it("matches simple filename pattern", () => {
			expect(fileMatchesGlob("*.md", "README.md")).toBe(true);
			expect(fileMatchesGlob("*.md", "README.ts")).toBe(false);
		});
	});

	describe("matchesRuleGlobs", () => {
		it("returns false for rule with no globs", () => {
			const rule: Rule = {
				name: "test",
				id: "test",
				scope: "",
				description: "",
				filePath: "/fake/test.md",
				baseDir: "/fake",
				source: "global",
				alwaysApply: true,
				globs: [],
				applyMode: "always",
			};
			expect(matchesRuleGlobs(rule, ["main.go"])).toBe(false);
		});

		it("returns true when context file matches globs", () => {
			const rule: Rule = {
				name: "go",
				id: "go",
				scope: "",
				description: "",
				filePath: "/fake/go.md",
				baseDir: "/fake",
				source: "global",
				alwaysApply: true,
				globs: ["**/*.go"],
				applyMode: "always",
			};
			expect(matchesRuleGlobs(rule, ["main.go"])).toBe(true);
			expect(matchesRuleGlobs(rule, ["README.md"])).toBe(false);
		});
	});

	describe("matchAutoRules", () => {
		it("returns always-apply rules without globs unconditionally", () => {
			const catalog: Rule[] = [
				{
					name: "always",
					id: "always",
					scope: "",
					description: "",
					filePath: "/f.md",
					baseDir: "/",
					source: "global",
					alwaysApply: true,
					globs: [],
					applyMode: "always",
				},
			];
			expect(matchAutoRules(catalog, [])).toHaveLength(1);
			expect(matchAutoRules(catalog, ["any/file.ts"])).toHaveLength(1);
		});

		it("returns always rules unconditionally (globs ignored per Cursor)", () => {
			const catalog: Rule[] = [
				{
					name: "go",
					id: "go",
					scope: "",
					description: "",
					filePath: "/f.md",
					baseDir: "/",
					source: "global",
					alwaysApply: true,
					globs: ["**/*.go"],
					applyMode: "always",
				},
			];
			// Cursor: alwaysApply=true ignores globs, always included
			expect(matchAutoRules(catalog, [])).toHaveLength(1);
			expect(matchAutoRules(catalog, ["README.md"])).toHaveLength(1);
			expect(matchAutoRules(catalog, ["main.go"])).toHaveLength(1);
		});

		it("returns auto-attach rules only when context files match globs", () => {
			const catalog: Rule[] = [
				{
					name: "go",
					id: "go",
					scope: "",
					description: "",
					filePath: "/f.md",
					baseDir: "/",
					source: "global",
					alwaysApply: false,
					globs: ["**/*.go"],
					applyMode: "auto",
				},
			];
			// Cursor: alwaysApply=false + globs → only when matching files in context
			expect(matchAutoRules(catalog, [])).toHaveLength(0);
			expect(matchAutoRules(catalog, ["README.md"])).toHaveLength(0);
			expect(matchAutoRules(catalog, ["main.go"])).toHaveLength(1);
		});

		it("does not return lazy or manual rules", () => {
			const catalog: Rule[] = [
				{
					name: "lazy",
					id: "lazy",
					scope: "",
					description: "desc",
					filePath: "/f.md",
					baseDir: "/",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "lazy",
				},
				{
					name: "manual",
					id: "manual",
					scope: "",
					description: "",
					filePath: "/f.md",
					baseDir: "/",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "manual",
				},
			];
			expect(matchAutoRules(catalog, [])).toHaveLength(0);
		});
	});

	describe("unionStickyRules", () => {
		it("merges new rules into sticky set", () => {
			const a: Rule = {
				name: "a",
				id: "a",
				scope: "",
				description: "",
				filePath: "/a.md",
				baseDir: "/",
				source: "global",
				alwaysApply: true,
				globs: [],
				applyMode: "always",
			};
			const b: Rule = {
				name: "b",
				id: "b",
				scope: "",
				description: "",
				filePath: "/b.md",
				baseDir: "/",
				source: "global",
				alwaysApply: true,
				globs: [],
				applyMode: "always",
			};
			const sticky = unionStickyRules([], [a]);
			expect(sticky).toHaveLength(1);
			const sticky2 = unionStickyRules(sticky, [a, b]);
			expect(sticky2).toHaveLength(2);
		});

		it("does not duplicate rules", () => {
			const a: Rule = {
				name: "a",
				id: "a",
				scope: "",
				description: "",
				filePath: "/a.md",
				baseDir: "/",
				source: "global",
				alwaysApply: true,
				globs: [],
				applyMode: "always",
			};
			const sticky = unionStickyRules([a], [a]);
			expect(sticky).toHaveLength(1);
		});

		it("sticky rules persist even when no longer matching", () => {
			const globRule: Rule = {
				name: "go",
				id: "go",
				scope: "",
				description: "",
				filePath: "/go.md",
				baseDir: "/",
				source: "global",
				alwaysApply: false,
				globs: ["**/*.go"],
				applyMode: "auto",
			};
			// First match — glob triggers
			const sticky = unionStickyRules([], matchAutoRules([globRule], ["main.go"]));
			expect(sticky).toHaveLength(1);
			// No match — still sticky
			const sticky2 = unionStickyRules(sticky, matchAutoRules([globRule], ["README.md"]));
			expect(sticky2).toHaveLength(1);
		});
	});

	describe("parseAtMentions", () => {
		it("extracts @ruleName from text", () => {
			expect(parseAtMentions("see @my-rule please")).toEqual(["my-rule"]);
		});

		it("extracts multiple mentions", () => {
			expect(parseAtMentions("@a and @b")).toEqual(["a", "b"]);
		});

		it("ignores mentions inside code fences", () => {
			expect(parseAtMentions("```\n@ignored\n```\n@kept")).toEqual(["kept"]);
		});

		it("returns empty for no mentions", () => {
			expect(parseAtMentions("no mentions here")).toEqual([]);
		});
	});

	describe("selectMentionedRules", () => {
		it("selects manual/lazy rules by @-mention", () => {
			const catalog: Rule[] = [
				{
					name: "style",
					id: "style",
					scope: "",
					description: "Code style",
					filePath: "/s.md",
					baseDir: "/",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "lazy",
				},
				{
					name: "always",
					id: "always",
					scope: "",
					description: "",
					filePath: "/a.md",
					baseDir: "/",
					source: "global",
					alwaysApply: true,
					globs: [],
					applyMode: "always",
				},
			];
			const mentioned = selectMentionedRules(catalog, "use @style please");
			expect(mentioned).toHaveLength(1);
			expect(mentioned[0]!.name).toBe("style");
		});

		it("does not select auto rules via mention", () => {
			const catalog: Rule[] = [
				{
					name: "always",
					id: "always",
					scope: "",
					description: "",
					filePath: "/a.md",
					baseDir: "/",
					source: "global",
					alwaysApply: true,
					globs: [],
					applyMode: "always",
				},
			];
			expect(selectMentionedRules(catalog, "@always")).toHaveLength(0);
		});

		it("is case-insensitive", () => {
			const catalog: Rule[] = [
				{
					name: "MyRule",
					id: "MyRule",
					scope: "",
					description: "desc",
					filePath: "/m.md",
					baseDir: "/",
					source: "global",
					alwaysApply: false,
					globs: [],
					applyMode: "lazy",
				},
			];
			const mentioned = selectMentionedRules(catalog, "@myrule");
			expect(mentioned).toHaveLength(1);
		});
	});

	describe("formatActiveRulesPrompt", () => {
		it("returns empty string when no active rules", () => {
			expect(formatActiveRulesPrompt([], [])).toBe("");
		});

		it("formats sticky rules as <rules> block", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "sticky.md"), '---\nalwaysApply: false\nglobs: ["**/*.ts"]\n---\nSticky content.');
			const rules = loadDirectoryRules({ globalDir: dir });
			const formatted = formatActiveRulesPrompt(rules, []);
			expect(formatted).toContain("<rules>");
			expect(formatted).toContain("Sticky content.");
		});

		it("deduplicates sticky and mentioned rules", () => {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "dup.md"), '---\nalwaysApply: false\nglobs: ["**/*.ts"]\n---\nDup body.');
			const rules = loadDirectoryRules({ globalDir: dir });
			const formatted = formatActiveRulesPrompt(rules, rules);
			expect(formatted.split("Dup body.")).toHaveLength(2); // appears exactly once
		});
	});

	describe("formatRulesForTurn", () => {
		function catalog(): Rule[] {
			const dir = join(fakeHome, ".cast", "rules");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "a-always.md"), "---\nalwaysApply: true\n---\nALWAYS body.");
			writeFileSync(join(dir, "b-auto.md"), '---\nalwaysApply: false\nglobs: ["**/*.ts"]\n---\nAUTO body.');
			writeFileSync(join(dir, "c-manual.md"), "---\n---\nMANUAL body.");
			return loadDirectoryRules({ globalDir: dir });
		}

		it("returns empty string when nothing applies", () => {
			expect(formatRulesForTurn([], [], [])).toBe("");
		});

		it("always-apply rules stay in the prompt once an auto rule latches (regression)", () => {
			const rules = catalog();
			const auto = rules.filter((r) => r.applyMode === "auto");
			// Sticky now holds the auto rule — the always rule must NOT drop out.
			const formatted = formatRulesForTurn(rules, auto, []);
			expect(formatted).toContain("ALWAYS body.");
			expect(formatted).toContain("AUTO body.");
			// Single combined block, not two separate <rules> wrappers.
			expect(formatted.match(/<rules>/g)).toHaveLength(1);
		});

		it("includes always-apply rules even with no sticky or mentioned rules", () => {
			const rules = catalog();
			expect(formatRulesForTurn(rules, [], [])).toContain("ALWAYS body.");
		});

		it("injects a manually @-mentioned rule alongside always rules", () => {
			const rules = catalog();
			const manual = rules.filter((r) => r.applyMode === "manual");
			const formatted = formatRulesForTurn(rules, [], manual);
			expect(formatted).toContain("ALWAYS body.");
			expect(formatted).toContain("MANUAL body.");
		});

		it("orders always first, then sticky, then mentioned, deduped", () => {
			const rules = catalog();
			const auto = rules.filter((r) => r.applyMode === "auto");
			const manual = rules.filter((r) => r.applyMode === "manual");
			const formatted = formatRulesForTurn(rules, [...auto, ...manual], manual);
			expect(formatted.indexOf("ALWAYS body.")).toBeLessThan(formatted.indexOf("AUTO body."));
			expect(formatted.indexOf("AUTO body.")).toBeLessThan(formatted.indexOf("MANUAL body."));
			expect(formatted.split("MANUAL body.")).toHaveLength(2); // once despite being in both lists
		});
	});

	describe("ruleScopeActive", () => {
		it("unscoped rules are always active", () => {
			expect(ruleScopeActive("", [])).toBe(true);
			expect(ruleScopeActive("", ["anything.ts"])).toBe(true);
		});

		it("scoped rule activates only when a subtree file is in context", () => {
			expect(ruleScopeActive("apps/web", [])).toBe(false);
			expect(ruleScopeActive("apps/web", ["services/api/main.go"])).toBe(false);
			expect(ruleScopeActive("apps/web", ["apps/web/src/App.tsx"])).toBe(true);
			expect(ruleScopeActive("apps/web", ["apps/web"])).toBe(true);
		});

		it("does not treat a sibling prefix as in-scope", () => {
			// "apps/web-admin" must NOT satisfy scope "apps/web"
			expect(ruleScopeActive("apps/web", ["apps/web-admin/x.tsx"])).toBe(false);
		});
	});

	describe("nested rules (discoverProjectRuleDirs + scoping)", () => {
		function scaffold(): string {
			const root = join(projectDir, "mono");
			mkdirSync(join(root, ".cast", "rules"), { recursive: true });
			writeFileSync(join(root, ".cast", "rules", "global-style.md"), "---\nalwaysApply: true\n---\nROOT always.");
			mkdirSync(join(root, "apps", "web", ".cast", "rules"), { recursive: true });
			writeFileSync(
				join(root, "apps", "web", ".cast", "rules", "web.md"),
				'---\nalwaysApply: false\nglobs: ["**/*.tsx"]\n---\nWEB auto.',
			);
			mkdirSync(join(root, "services", "api", ".cast", "rules"), { recursive: true });
			writeFileSync(
				join(root, "services", "api", ".cast", "rules", "web.md"),
				"---\nalwaysApply: true\n---\nAPI always.",
			);
			mkdirSync(join(root, "node_modules", "pkg", ".cast", "rules"), { recursive: true });
			writeFileSync(join(root, "node_modules", "pkg", ".cast", "rules", "junk.md"), "---\n---\nSHOULD NOT LOAD.");
			return root;
		}

		it("discovers root and nested dirs, skipping node_modules", () => {
			const root = scaffold();
			const found = discoverProjectRuleDirs(root);
			const scopes = found.map((f) => f.scope).sort();
			expect(scopes).toEqual(["", "apps/web", "services/api"]);
		});

		it("scope-qualifies ids so same-named rules in different subtrees coexist", () => {
			const root = scaffold();
			const rules = loadDirectoryRules({ projectCwd: root });
			const ids = rules.map((r) => r.id).sort();
			// Two files both named web.md, but distinct scope-qualified ids.
			expect(ids).toContain("apps/web/web");
			expect(ids).toContain("services/api/web");
			expect(rules.filter((r) => r.name === "web")).toHaveLength(2);
		});

		it("nested rule stays dormant until a file from its subtree enters context", () => {
			const root = scaffold();
			const rules = loadDirectoryRules({ projectCwd: root });

			// Only a backend file in context: root-always + api-always fire, web stays off.
			const backend = matchAutoRules(rules, ["services/api/main.go"]);
			const backendIds = backend.map((r) => r.id).sort();
			expect(backendIds).toEqual(["global-style", "services/api/web"]);

			// A web .tsx enters context: the web auto rule now attaches too.
			const web = matchAutoRules(rules, ["apps/web/src/App.tsx"]);
			const webIds = web.map((r) => r.id).sort();
			expect(webIds).toContain("apps/web/web");
			expect(webIds).toContain("global-style");
			expect(webIds).not.toContain("services/api/web"); // no api file in context
		});

		it("respects maxDepth", () => {
			const root = join(projectDir, "deep");
			const deep = join(root, "a", "b", "c");
			mkdirSync(join(deep, ".cast", "rules"), { recursive: true });
			writeFileSync(join(deep, ".cast", "rules", "x.md"), "---\n---\nbody");
			expect(discoverProjectRuleDirs(root, 2).map((f) => f.scope)).not.toContain("a/b/c");
			expect(discoverProjectRuleDirs(root, 5).map((f) => f.scope)).toContain("a/b/c");
		});
	});
});
