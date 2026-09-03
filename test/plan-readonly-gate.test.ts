/**
 * plan mode's read-only bash gate. Everything here is an escape that the gate
 * used to let through: a command it classified as read-only, which then ran
 * arbitrary code.
 */
import { describe, expect, it } from "vitest";
import { checkReadOnlyCommand } from "../src/core/plan.ts";

describe("checkReadOnlyCommand — environment prefixes", () => {
	// The parser reports `VAR=value cmd` as a variable_assignment node, and
	// those were dropped from the argument list before any check ran. One
	// prefix therefore turned any allowlisted command into arbitrary code.
	it.each([
		["LD_PRELOAD=/tmp/evil.so cat file", "LD_PRELOAD"],
		["GIT_EXTERNAL_DIFF=/tmp/evil git diff", "GIT_EXTERNAL_DIFF"],
		["GIT_PAGER='sh -c \"rm x\"' git log", "GIT_PAGER"],
		["PAGER='sh -c \"rm x\"' git log", "PAGER"],
		["IFS=x cat f", "IFS"],
	])("refuses %s", async (command, name) => {
		const result = await checkReadOnlyCommand(command);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(name);
	});

	it("still allows locale and timezone prefixes, which read-only commands do use", async () => {
		expect((await checkReadOnlyCommand("LC_ALL=C sort f")).ok).toBe(true);
		expect((await checkReadOnlyCommand("LANG=en_US.UTF-8 grep x f")).ok).toBe(true);
		expect((await checkReadOnlyCommand("TZ=UTC date")).ok).toBe(true);
	});
});

describe("checkReadOnlyCommand — git options that run a command", () => {
	// A read-only subcommand is not enough on its own: --ext-diff and
	// --textconv run the driver named by diff.<name>.command / .textconv, which
	// a repository's own .git/config or .gitattributes can define — so cloning
	// a repository was enough to get code execution inside plan mode. -O runs
	// its argument directly, and --exec-path redirects where git finds its own
	// subcommand binaries.
	it.each([
		"git log -p --ext-diff",
		"git diff --ext-diff",
		"git blame --textconv f",
		"git show --textconv HEAD",
		"git grep -O'sh -c \"rm x\"' pattern",
		"git --exec-path=/tmp log",
	])("refuses %s", async (command) => {
		expect((await checkReadOnlyCommand(command)).ok).toBe(false);
	});

	it("leaves ordinary read-only git alone, including the safe --no- forms", async () => {
		expect((await checkReadOnlyCommand("git log --oneline")).ok).toBe(true);
		expect((await checkReadOnlyCommand("git diff HEAD~1")).ok).toBe(true);
		expect((await checkReadOnlyCommand("git diff --no-ext-diff")).ok).toBe(true);
		expect((await checkReadOnlyCommand("git grep pattern")).ok).toBe(true);
	});
});

describe("checkReadOnlyCommand — the guarantees that already held", () => {
	it("allows plain reads", async () => {
		for (const command of ["cat f", "ls -la", "rg pattern src", "head -20 f", "wc -l f", "ls > /dev/null"]) {
			expect((await checkReadOnlyCommand(command)).ok, command).toBe(true);
		}
	});

	it("refuses writes, execution and substitution", async () => {
		for (const command of [
			"rm -rf /",
			"sed -i s/a/b/ f",
			"tee out.txt",
			"cat f > out",
			"find . -exec rm {} ;",
			"sort -o out f",
			"bash -c 'rm x'",
			"cat $(echo f)",
			"git commit -m x",
			"ls && rm -rf x",
		]) {
			expect((await checkReadOnlyCommand(command)).ok, command).toBe(false);
		}
	});
});
