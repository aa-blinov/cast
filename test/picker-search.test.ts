import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { createSession, saveSession, searchSessionSummaries } from "../src/core/session.ts";
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

	it("subsequence with huge gaps is rejected — scattered letters aren't a real match", () => {
		const hay = `n${"x".repeat(10_000)}eedle`;
		expect(score(hay, "needle")).toBe(-1);
	});

	it("subsequence with small gaps still passes the relevance floor", () => {
		// "abc" via 'a' at 0, 'b' at 2 (gap 1), 'c' at 4 (gap 1) → gaps=2 → 98
		expect(score("axbxc", "abc")).toBeGreaterThanOrEqual(50);
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
// searchSessionSummaries() — the FTS5-backed replacement for the old
// getSearchHaystack()+score() combo. The index is now built and maintained
// by SQLite itself (messages_fts + triggers, see core/db.ts), not by
// concatenating every message into one JS string per session.
// ============================================================================

describe("searchSessionSummaries", () => {
	let realHome: string | undefined;
	let fakeHome: string;
	let projectDir: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-picker-search-test-"));
		process.env.HOME = fakeHome;
		resetDbConnectionForTests();
		projectDir = join(fakeHome, "proj");
	});

	afterEach(() => {
		resetDbConnectionForTests();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("skips the system prompt — it can't be found by content search", () => {
		const s = createSession("gpt-4o", projectDir);
		s.messages.push(
			{ role: "system", content: "BOILERPLATE_MARKER shared by every session" },
			{ role: "user", content: "find the needle here" },
		);
		saveSession(s);

		expect(searchSessionSummaries("needle").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries("BOILERPLATE_MARKER")).toEqual([]);
	});

	it("skips tool messages but finds user/assistant text from the whole thread", () => {
		const s = createSession("gpt-4o", projectDir);
		s.messages.push(
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "tool", content: "TOOL_OUTPUT_NOISE_MARKER" } as unknown as import("../src/core/llm.ts").Message,
			{ role: "user", content: "late follow-up topic" },
		);
		saveSession(s);

		expect(searchSessionSummaries("first answer").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries("late follow-up").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries("TOOL_OUTPUT_NOISE_MARKER")).toEqual([]);
	});

	it("finds a session by a multi-word query even when the words are in different messages", () => {
		// Regression: messages_fts indexes one row per message, so a single
		// combined MATCH query (all words ANDed) only ever found a session
		// where every word appeared in the SAME message — a query like "hello
		// mood" would miss a session that said "hello" in one turn and asked
		// about "mood" three turns later, even though both terms individually
		// matched that session just fine on their own.
		const s = createSession("gpt-4o", projectDir);
		s.messages.push(
			{ role: "user", content: "greetingword" },
			{ role: "assistant", content: "reply one" },
			{ role: "user", content: "moodword" },
		);
		saveSession(s);

		expect(searchSessionSummaries("greetingword").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries("moodword").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries("greetingword moodword").map((x) => x.id)).toEqual([s.id]);
		// A word that's genuinely absent must still fail the intersection.
		expect(searchSessionSummaries("greetingword nonexistentword")).toEqual([]);
	});

	it("finds text arbitrarily deep in a long thread (no cap)", () => {
		const s = createSession("gpt-4o", projectDir);
		for (let i = 0; i < 200; i++) s.messages.push({ role: "user", content: `message number ${i}` });
		s.messages.push({ role: "assistant", content: "deep unique needle" });
		saveSession(s);

		expect(searchSessionSummaries("deep unique needle").map((x) => x.id)).toEqual([s.id]);
	});

	it("also matches on session metadata (cwd/id/title), not just message content", () => {
		const s = createSession("gpt-4o", projectDir);
		s.title = "My distinctive title";
		saveSession(s);

		expect(searchSessionSummaries("distinctive title").map((x) => x.id)).toEqual([s.id]);
		expect(searchSessionSummaries(s.id).map((x) => x.id)).toEqual([s.id]);
	});

	it("ranks a metadata match above a pure content match", () => {
		const contentOnly = createSession("gpt-4o", projectDir);
		contentOnly.messages.push({ role: "user", content: "mentions apple in passing" });
		saveSession(contentOnly);

		const titleMatch = createSession("gpt-4o", projectDir);
		titleMatch.title = "apple";
		saveSession(titleMatch);

		expect(searchSessionSummaries("apple").map((x) => x.id)[0]).toBe(titleMatch.id);
	});
});
