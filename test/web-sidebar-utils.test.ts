import { describe, expect, it } from "vitest";

import {
	DATE_BUCKETS,
	dateBucketFor,
	groupSessionsByDate,
	groupSessionsByProject,
	isSandboxSessionCwd,
	listProjects,
	projectLabels,
	projectOf,
	relativeAge,
	SANDBOX_CWD,
	sessionLabel,
	sessionMeta,
	shortPath,
	sortSessionsByActivity,
	splitPinned,
	visibleSessions,
	worktreeOf,
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

describe("session label and meta", () => {
	const now = Date.parse("2026-10-02T12:00:00Z");

	it("calls an unused untitled session new, and a used one by its persona", () => {
		expect(sessionLabel({ persona: "senior", messageCount: 0 })).toBe("New session");
		expect(sessionLabel({ persona: "senior", messageCount: 3 })).toBe("senior");
		expect(sessionLabel({ title: "Fix login", persona: "senior", messageCount: 0 })).toBe("Fix login");
	});

	it("shows the folder and how long ago", () => {
		expect(sessionMeta({ cwd: "/home/u/proj", updatedAt: "2026-10-02T11:30:00Z" }, now)).toBe("proj · 30m");
		expect(sessionMeta({ cwd: "/home/u/.cast/sandbox/x", updatedAt: "2026-09-30T12:00:00Z" }, now)).toBe(
			"sandbox · 2d",
		);
		expect(sessionMeta({ cwd: "/home/u/proj", status: "running", updatedAt: "2026-10-02T11:30:00Z" }, now)).toBe(
			"running · proj · 30m",
		);
		expect(sessionMeta({ cwd: "/home/u/proj", status: "idle", updatedAt: "2026-10-02T11:30:00Z" }, now)).toBe(
			"proj · 30m",
		);
		expect(relativeAge("2026-10-02T11:59:50Z", now)).toBe("now");
		expect(relativeAge("garbage", now)).toBe("");
	});
});

it("hides unused sessions except the open, pinned and running ones", () => {
	const list = [
		{ id: "a", messageCount: 0 },
		{ id: "b", messageCount: 0 },
		{ id: "c", messageCount: 0, pinned: true },
		{ id: "d", messageCount: 0, status: "running" },
		{ id: "e", messageCount: 2 },
	];
	expect(visibleSessions(list, "b").map((s) => s.id)).toEqual(["b", "c", "d", "e"]);
});

describe("grouping by project and pinned", () => {
	const s = (id: string, cwd: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
		id,
		cwd,
		updatedAt,
		...extra,
	});
	const sessions = [
		s("a1", "/work/api", "2026-10-01T10:00:00Z"),
		s("w1", "/work/web", "2026-10-03T10:00:00Z"),
		s("a2", "/work/api", "2026-10-02T10:00:00Z", { status: "running" }),
		s("x1", "/tmp/.cast/sandbox/cast-1", "2026-09-01T10:00:00Z"),
		s("x2", "/tmp/.cast/sandbox/cast-2", "2026-09-02T10:00:00Z"),
	];

	it("treats every throwaway sandbox folder as one project", () => {
		expect(projectOf(sessions[3])).toBe(SANDBOX_CWD);
		expect(projectOf(sessions[4])).toBe(SANDBOX_CWD);
		expect(projectOf(sessions[0])).toBe("/work/api");
		expect(projectOf({ id: "n", updatedAt: "2026-10-01T00:00:00Z" })).toBe("");
	});

	it("lists projects with a count, the most recently used first", () => {
		expect(listProjects(sessions)).toEqual([
			{ key: "/work/web", count: 1, updatedAt: "2026-10-03T10:00:00Z" },
			{ key: "/work/api", count: 2, updatedAt: "2026-10-02T10:00:00Z" },
			{ key: SANDBOX_CWD, count: 2, updatedAt: "2026-09-02T10:00:00Z" },
		]);
	});

	it("groups by project, newest project first, running then newest inside", () => {
		const groups = groupSessionsByProject(sessions);
		expect(groups.map((g) => g.key)).toEqual(["/work/web", "/work/api", SANDBOX_CWD]);
		expect(groups[1].sessions.map((x) => x.id)).toEqual(["a2", "a1"]);
	});

	it("names a project by its folder, and by the parent too when two share a name", () => {
		const labels = projectLabels(["/work/api", "/home/me/web", "/srv/web", SANDBOX_CWD, ""]);
		expect(labels.get("/work/api")).toBe("api");
		expect(labels.get("/home/me/web")).toBe("me/web");
		expect(labels.get("/srv/web")).toBe("srv/web");
		expect(labels.get(SANDBOX_CWD)).toBe("Sandbox");
		expect(labels.get("")).toBe("No folder");
	});

	it("takes pinned sessions out of the list, newest first, wherever their date is", () => {
		const list = [
			s("old", "/work/api", "2026-01-01T00:00:00Z", { pinned: true }),
			s("new", "/work/web", "2026-10-03T00:00:00Z"),
			s("mid", "/work/web", "2026-06-01T00:00:00Z", { pinned: true }),
		];
		const { pinned, rest } = splitPinned(list);
		expect(pinned.map((x) => x.id)).toEqual(["mid", "old"]);
		expect(rest.map((x) => x.id)).toEqual(["new"]);
	});

	it("leaves the folder out of the meta line when the group already names it", () => {
		const now = Date.parse("2026-10-02T12:00:00Z");
		const session = { cwd: "/work/api", updatedAt: "2026-10-02T11:30:00Z" };
		expect(sessionMeta(session, now)).toBe("api · 30m");
		expect(sessionMeta(session, now, { hideFolder: true })).toBe("30m");
		expect(sessionMeta({ ...session, status: "running" }, now, { hideFolder: true })).toBe("running · 30m");
	});
});

describe("sessions in a worktree", () => {
	const root = "/work/api";
	const inWorktree = { cwd: `${root}/.cast/worktrees/feature-x`, updatedAt: "2026-10-02T11:30:00Z" };
	const now = Date.parse("2026-10-02T12:00:00Z");

	it("names the worktree a folder is in, and nothing for any other folder", () => {
		expect(worktreeOf(inWorktree.cwd)).toBe("feature-x");
		expect(worktreeOf(`${root}/.cast/worktrees/feature-x/src/deep`)).toBe("feature-x");
		expect(worktreeOf(`${root}/.cast/worktrees/a+b`)).toBe("a/b");
		expect(worktreeOf(root)).toBe("");
		expect(worktreeOf(`${root}/.cast/skills`)).toBe("");
		expect(worktreeOf(undefined)).toBe("");
	});

	it("is the project's session: grouped with it and filtered by it", () => {
		expect(projectOf(inWorktree)).toBe(root);
		expect(projectOf({ cwd: `${root}/.cast/worktrees/other/pkg`, updatedAt: "x" })).toBe(root);
		const projects = listProjects([inWorktree, { cwd: root, updatedAt: "2026-10-01T00:00:00Z" }]);
		expect(projects).toEqual([{ key: root, count: 2, updatedAt: "2026-10-02T11:30:00Z" }]);
	});

	it("shows the project and the worktree in the meta line, and only the worktree under its project", () => {
		expect(sessionMeta(inWorktree, now)).toBe("api · wt:feature-x · 30m");
		expect(sessionMeta(inWorktree, now, { hideFolder: true })).toBe("wt:feature-x · 30m");
	});
});
