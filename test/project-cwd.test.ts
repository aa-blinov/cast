import { describe, expect, it } from "vitest";
import { sessionIsInProject } from "../src/core/project-cwd.ts";

describe("sessionIsInProject", () => {
	it("is true for the project's own directory and for a worktree cast made for it", () => {
		expect(sessionIsInProject("/work/api", "/work/api")).toBe(true);
		expect(sessionIsInProject("/work/api/.cast/worktrees/feature-x", "/work/api")).toBe(true);
		expect(sessionIsInProject("/work/api/.cast/worktrees/feature-x/src", "/work/api")).toBe(true);
	});

	it("is false for anything else, including a sibling that merely starts with the name", () => {
		expect(sessionIsInProject(undefined, "/work/api")).toBe(false);
		expect(sessionIsInProject("/work/api2", "/work/api")).toBe(false);
		expect(sessionIsInProject("/work/api/src", "/work/api")).toBe(false);
		expect(sessionIsInProject("/work/api/.cast/worktrees", "/work/api")).toBe(false);
		expect(sessionIsInProject("/work/web/.cast/worktrees/x", "/work/api")).toBe(false);
	});

	it("does not treat a project as holding the project it sits in", () => {
		expect(sessionIsInProject("/work/api", "/work/api/.cast/worktrees/feature-x")).toBe(false);
	});
});
