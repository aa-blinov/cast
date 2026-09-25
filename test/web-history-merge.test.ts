import { describe, expect, it } from "vitest";
import { mergeHistoryPage } from "../src/server/public/history-merge.js";

describe("mergeHistoryPage", () => {
	it("keeps the client's own rows after a refetch, in place", () => {
		const previous = [
			{ role: "user", content: "fix the tests", seq: 1 },
			{ role: "warning", content: "[Retrying (attempt 2): 529]", local: true },
			{ role: "assistant", content: "partial" },
			{ role: "error", content: "Provider overloaded", local: true },
		];
		const incoming = [
			{ role: "user", content: "fix the tests", seq: 1 },
			{ role: "assistant", content: "partial", seq: 2 },
		];
		expect(mergeHistoryPage(previous, incoming).map((m) => m.content)).toEqual([
			"fix the tests",
			"[Retrying (attempt 2): 529]",
			"partial",
			"Provider overloaded",
		]);
	});

	it("does not duplicate server rows that carry no seq", () => {
		// The server renders <system-reminder> blocks as warning rows without a
		// seq; only rows the client marked local are carried over.
		const serverWarning = { role: "warning", content: "[system] Context restored" };
		const previous = [{ role: "user", content: "hi", seq: 1 }, serverWarning];
		const incoming = [{ role: "user", content: "hi", seq: 1 }, { ...serverWarning }];
		expect(mergeHistoryPage(previous, incoming)).toHaveLength(2);
	});

	it("reuses mounted objects by seq and keeps unacknowledged sends last", () => {
		const mounted = { role: "user", content: "a", seq: 1 };
		const pending = { role: "user", content: "b", pending: true, clientMessageId: "c1" };
		const merged = mergeHistoryPage([mounted, pending], [{ role: "user", content: "a", seq: 1 }]);
		expect(merged[0]).toBe(mounted);
		expect(merged[merged.length - 1]).toBe(pending);
	});

	it("keeps a local row anchored past the end of a short page", () => {
		const previous = [
			{ role: "user", content: "a", seq: 1 },
			{ role: "assistant", content: "b" },
			{ role: "error", content: "boom", local: true },
		];
		const merged = mergeHistoryPage(previous, [{ role: "user", content: "a", seq: 1 }]);
		expect(merged.map((m) => m.content)).toEqual(["a", "boom"]);
	});
});
