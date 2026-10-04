import { describe, expect, it } from "vitest";
import { pinnedFirst } from "../src/server/session-list.ts";

describe("pinnedFirst", () => {
	it("puts pinned sessions first and keeps the order within each part", () => {
		const list = [{ id: "a" }, { id: "b", pinned: true }, { id: "c" }, { id: "d", pinned: true }];
		expect(pinnedFirst(list).map((s) => s.id)).toEqual(["b", "d", "a", "c"]);
	});

	it("returns the same list when nothing is pinned", () => {
		const list = [{ id: "a" }, { id: "b", pinned: false }];
		expect(pinnedFirst(list)).toBe(list);
	});
});
