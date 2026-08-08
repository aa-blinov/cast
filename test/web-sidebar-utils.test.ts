import { describe, expect, it } from "vitest";

import {
	DATE_BUCKETS,
	dateBucketFor,
	groupSessionsByDate,
	isSandboxSessionCwd,
	SANDBOX_CWD,
	shortPath,
	sortSessionsByActivity,
} from "../src/server/public/sidebar-utils.js";

describe("web sidebar session helpers", () => {
	it("recognizes sandbox paths", () => {
		expect(isSandboxSessionCwd(SANDBOX_CWD)).toBe(true);
		expect(isSandboxSessionCwd("/tmp/.cast/sandbox/cast-123")).toBe(true);
		expect(isSandboxSessionCwd("/work/cast")).toBe(false);
	});

	it("shortens long paths for the directory toggle", () => {
		expect(shortPath("/work/cast")).toBe("/work/cast");
		expect(shortPath("/home/u/repos/cast")).toBe("…/repos/cast");
		expect(shortPath("")).toBe("");
	});

	describe("dateBucketFor", () => {
		const now = Date.parse("2026-08-05T15:00:00");

		it("classifies by recency against the pinned clock", () => {
			expect(dateBucketFor("2026-08-05T10:00:00", now)).toBe("Today");
			expect(dateBucketFor("2026-08-05T00:00:00", now)).toBe("Today");
			expect(dateBucketFor("2026-08-04T23:59:00", now)).toBe("Yesterday");
			expect(dateBucketFor("2026-08-03T12:00:00", now)).toBe("Previous 7 days");
			expect(dateBucketFor("2026-07-15T12:00:00", now)).toBe("Previous 30 days");
			expect(dateBucketFor("2026-01-15T12:00:00", now)).toBe("Older");
		});

		it("clamps future timestamps and falls back for invalid dates", () => {
			expect(dateBucketFor("2026-08-06T00:00:00", now)).toBe("Today");
			expect(dateBucketFor("not-a-date", now)).toBe("Older");
			expect(dateBucketFor("", now)).toBe("Older");
		});
	});

	describe("groupSessionsByDate", () => {
		const now = Date.parse("2026-08-05T15:00:00");

		it("groups into canonical date buckets in fixed order", () => {
			const sessions = [
				{ id: "older", updatedAt: "2026-01-01T00:00:00" },
				{ id: "yest", updatedAt: "2026-08-04T10:00:00" },
				{ id: "today", updatedAt: "2026-08-05T10:00:00" },
				{ id: "week", updatedAt: "2026-08-02T10:00:00" },
				{ id: "month", updatedAt: "2026-07-15T10:00:00" },
			];
			const groups = groupSessionsByDate(sessions, now);
			expect(groups.map(([, g]) => g.label)).toEqual([
				"Today",
				"Yesterday",
				"Previous 7 days",
				"Previous 30 days",
				"Older",
			]);
			expect(groups.find(([, g]) => g.label === "Today")[1].sessions[0].id).toBe("today");
		});

		it("drops empty buckets and preserves single-bucket lists", () => {
			const groups = groupSessionsByDate([{ id: "only", updatedAt: "2026-08-05T10:00:00" }], now);
			expect(groups.map(([, g]) => g.label)).toEqual(["Today"]);
		});

		it("matches the canonical bucket order used by the sidebar", () => {
			expect(DATE_BUCKETS).toEqual(["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"]);
		});
	});

	describe("sortSessionsByActivity", () => {
		it("promotes running over idle and newer over older", () => {
			const sorted = [
				{ id: "old", status: "idle", updatedAt: "2026-07-30" },
				{ id: "running", status: "running", updatedAt: "2026-07-01" },
				{ id: "newer-idle", status: "idle", updatedAt: "2026-07-31" },
			].sort(sortSessionsByActivity);
			expect(sorted.map((s) => s.id)).toEqual(["running", "newer-idle", "old"]);
		});
	});
});
