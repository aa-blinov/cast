import { describe, expect, it } from "vitest";
import { formatRetries, insertRunNotices } from "../src/server/bridge/display.ts";

const retry = (eventSeq: number, afterSeq: number, attempt: number, reason = "529 overloaded") => ({
	eventSeq,
	type: "retry",
	afterSeq,
	payload: { attempt, reason },
});

describe("insertRunNotices", () => {
	const page = [
		{ role: "user", content: "go", seq: 1 },
		{ role: "assistant", content: "done", seq: 4 },
	];

	it("puts a notice right after the message it is anchored to", () => {
		const out = insertRunNotices(
			page,
			[{ eventSeq: 0, type: "error", afterSeq: 1, payload: { message: "boom" } }],
			0,
			99,
		);
		expect(out.map((m) => m.content)).toEqual(["go", "boom", "done"]);
		expect(out[1]).toMatchObject({ role: "error", notice: "error" });
	});

	it("places an anchor on a tool result (no row of its own) before the next row", () => {
		// seq 2 and 3 are tool rows folded into the assistant message at seq 4's predecessor
		const out = insertRunNotices(page, [retry(0, 3, 1)], 0, 99);
		expect(out.map((m) => m.notice ?? m.role)).toEqual(["user", "retry", "assistant"]);
	});

	it("collects consecutive retries into one row listing every attempt", () => {
		const out = insertRunNotices(page, [retry(0, 1, 1), retry(1, 1, 2)], 0, 99);
		expect(out).toHaveLength(3);
		expect(out[1]?.attempts).toEqual([
			{ attempt: 1, reason: "529 overloaded" },
			{ attempt: 2, reason: "529 overloaded" },
		]);
		expect(out[1]?.content).toBe(formatRetries(out[1]!.attempts!));
	});

	it("does not merge retries separated by another event", () => {
		const events = [
			retry(0, 1, 1),
			{ eventSeq: 1, type: "error", afterSeq: 1, payload: { message: "x" } },
			retry(2, 1, 1),
		];
		expect(insertRunNotices(page, events, 0, 99).filter((m) => m.notice === "retry")).toHaveLength(2);
	});

	it("shows a hand-stopped turn as Run aborted", () => {
		const out = insertRunNotices(
			page,
			[{ eventSeq: 0, type: "end", afterSeq: 4, payload: { reason: "aborted" } }],
			0,
			99,
		);
		expect(out[out.length - 1]).toMatchObject({ role: "warning", notice: "aborted", content: "Run aborted" });
	});

	it("only takes notices anchored inside the page", () => {
		const events = [retry(0, 0, 1), retry(5, 1, 1), retry(9, 7, 1)];
		expect(insertRunNotices(page, events, 1, 4).filter((m) => m.notice)).toHaveLength(1);
	});

	it("returns the same array when there is nothing to add", () => {
		expect(insertRunNotices(page, [], 0, 99)).toBe(page);
	});
});
