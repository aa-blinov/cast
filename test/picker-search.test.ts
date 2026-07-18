import { describe, expect, it } from "vitest";
import { getSearchHaystack } from "../src/core/session.ts";
import { score } from "../src/pickers/match.ts";

// ============================================================================
// score() — pure matching
// ============================================================================

describe("score", () => {
	it("returns 0 for empty needle (everything matches)", () => {
		expect(score("hello world", "")).toBe(0);
	});

	it("substring at position 0 returns 1000 (highest possible)", () => {
		expect(score("hello world", "hello")).toBe(1000);
	});

	it("substring later in the haystack still scores in the 1000-band", () => {
		// "world" starts at index 6 → 1000 - 6 = 994
		expect(score("hello world", "world")).toBe(994);
	});

	it("substring always outranks any subsequence match", () => {
		const subAt0 = score("abcdef", "abc");
		const subLater = score("xxxabcdef", "abc");
		const subseq = score("axbxcx", "abc"); // 2 single-char gaps → 98
		expect(subAt0).toBeGreaterThan(subseq);
		expect(subLater).toBeGreaterThan(subseq);
	});

	it("single-character substring at position 0 returns 1000 (not 99)", () => {
		// First-char substring shouldn't be confused with a subsequence "0 gaps"
		// claim — substring always wins the 1000-band over subsequence's 100-band.
		expect(score("hello", "h")).toBe(1000);
	});

	it("subsequence match returns 100 - gaps (range < 1000)", () => {
		// "abc" found via indexOf in haystack "axbxc":
		// 'a' at 0, gap 0; 'b' at 2, gap (2-1)=1; 'c' at 4, gap (4-3)=1 → gaps=2 → 98
		expect(score("axbxc", "abc")).toBe(98);
	});

	it("returns -1 when no characters of the needle appear in order", () => {
		expect(score("hello", "xyz")).toBe(-1);
	});

	it("returns -1 when some characters are present but not all", () => {
		// 'a' present, 'b' present, but 'z' missing → fail
		expect(score("abracadabra", "abz")).toBe(-1);
	});

	it("substring deep in a huge haystack still matches and outranks subsequences", () => {
		// Regression: an uncapped session haystack put a real substring hit at
		// position ~56k → `1000 - idx` went negative and the `>= 0` filter
		// silently dropped the row. Floors keep substring ≥ 101 > subsequence ≤ 100.
		const hay = `${"x".repeat(50_000)}needle`;
		const deep = score(hay, "needle");
		expect(deep).toBe(101);
		expect(deep).toBeGreaterThan(score("nxexexdxlxe", "nedle")); // any subsequence
	});

	it("subsequence with huge gaps is weak but never dropped", () => {
		const hay = `n${"x".repeat(10_000)}eedle`;
		expect(score(hay, "needle")).toBe(1);
	});
});

// ============================================================================
// pickSessions() — reproduces ModalPicker's filter+sort without React
// ============================================================================
//
// Mirrors the logic in ModalPicker: haystack = label + "\n" + description + "\n"
// + searchText, lowercased once, then score() filters and sorts. Lives here as
// a pure function so we can test the filtering contract directly without
// mounting the picker.

interface SearchableRow {
	label: string;
	description?: string;
	searchText?: string;
}

function pickSessions(options: SearchableRow[], query: string): SearchableRow[] {
	const qLower = query.toLowerCase();
	if (qLower.length === 0) return options.slice();
	const scored: Array<{ row: SearchableRow; s: number; i: number }> = [];
	options.forEach((o, i) => {
		const hay = `${o.label}\n${o.description ?? ""}\n${o.searchText ?? ""}`.toLowerCase();
		const s = score(hay, qLower);
		if (s >= 0) scored.push({ row: o, s, i });
	});
	scored.sort((a, b) => b.s - a.s || a.i - b.i);
	return scored.map((x) => x.row);
}

describe("pickSessions (filter contract)", () => {
	// Description strings contain unique tokens per row so subsequence matches
	// don't accidentally surface the wrong row.
	const rows: SearchableRow[] = [
		{ label: "alpha-row", description: "sql migration script", searchText: "/home/user/proj-aaa id-aaa" },
		{ label: "beta-row", description: "rest api endpoint", searchText: "/home/user/proj-bbb id-bbb" },
		{ label: "gamma-row", description: "typo in readme", searchText: "/home/user/proj-ccc id-ccc" },
	];

	it("returns everything in original order on empty query", () => {
		expect(pickSessions(rows, "").map((r) => r.label)).toEqual(["alpha-row", "beta-row", "gamma-row"]);
	});

	it("filters by exact word in description (substring wins)", () => {
		expect(pickSessions(rows, "endpoint").map((r) => r.label)).toEqual(["beta-row"]);
	});

	it("filters by token that lives only in searchText (cwd / id)", () => {
		expect(pickSessions(rows, "proj-bbb").map((r) => r.label)).toEqual(["beta-row"]);
		expect(pickSessions(rows, "id-ccc").map((r) => r.label)).toEqual(["gamma-row"]);
	});

	it("filters by token in the label itself", () => {
		// "alpha" is a substring of "alpha-row" only — not a subsequence match in
		// "beta-row" or "gamma-row" because those have no 'a' followed later by 'l'.
		expect(pickSessions(rows, "alpha").map((r) => r.label)).toEqual(["alpha-row"]);
	});

	it("returns empty when nothing matches", () => {
		expect(pickSessions(rows, "xyzzy")).toEqual([]);
	});

	it("is case-insensitive", () => {
		expect(pickSessions(rows, "ENDPOINT").map((r) => r.label)).toEqual(["beta-row"]);
	});

	it("preserves original order when scores tie", () => {
		// Labels are deliberately the same length: the haystack is
		// label + "\n" + description, so "hello" lands at the same index in all
		// three rows and the substring scores genuinely tie. (With uneven label
		// lengths the positions — and therefore scores — would differ.)
		const tied: SearchableRow[] = [
			{ label: "one", description: "hello" },
			{ label: "two", description: "hello" },
			{ label: "six", description: "hello" },
		];
		expect(pickSessions(tied, "hello").map((r) => r.label)).toEqual(["one", "two", "six"]);
	});

	it("ranks earlier substring match above later one", () => {
		const r1 = { label: "hello-world", description: "" };
		const r2 = { label: "xxx", description: "hello-world" };
		// r1 has "hello" at position 0 in label (score 1000), r2 has it at
		// position 4 in description (score 996). r1 must come first.
		const result = pickSessions([r2, r1], "hello");
		expect(result[0]?.label).toBe("hello-world");
	});
});

// ============================================================================
// getSearchHaystack() — what the session filter actually searches over
// ============================================================================

describe("getSearchHaystack", () => {
	const mkSession = (messages: Array<{ role: string; content: unknown }>) =>
		({ id: "sess-id-123", cwd: "/home/user/proj", messages }) as never;

	it("skips the system prompt so it cannot exhaust the char budget", () => {
		// The system prompt is tens of thousands of shared boilerplate chars;
		// with it included, no user message ever made it under the cap.
		const hay = getSearchHaystack(
			mkSession([
				{ role: "system", content: "BOILERPLATE ".repeat(200) },
				{ role: "user", content: "find the needle here" },
			]),
		);
		expect(hay).not.toContain("BOILERPLATE");
		expect(hay).toContain("find the needle here");
	});

	it("skips tool messages but walks user/assistant text from the whole thread", () => {
		const hay = getSearchHaystack(
			mkSession([
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "first answer" },
				{ role: "tool", content: "TOOL OUTPUT NOISE" },
				{ role: "user", content: "late follow-up topic" },
			]),
		);
		expect(hay).toContain("first question");
		expect(hay).toContain("first answer");
		expect(hay).not.toContain("TOOL OUTPUT NOISE");
		expect(hay).toContain("late follow-up topic");
	});

	it("includes cwd, id, and text from arbitrarily deep in the thread (no cap)", () => {
		const filler = Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `message number ${i}` }));
		const hay = getSearchHaystack(mkSession([...filler, { role: "assistant", content: "deep unique needle" }]));
		expect(hay).toContain("/home/user/proj");
		expect(hay).toContain("sess-id-123");
		expect(hay).toContain("deep unique needle");
	});
});
