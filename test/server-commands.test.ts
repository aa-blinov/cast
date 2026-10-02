import { describe, expect, it } from "vitest";
import {
	GOAL_MAX_OUTER_ITERATIONS,
	goalIterationBudget,
	isCommandBlocking,
	SLASH_COMMANDS,
} from "../src/server/commands.ts";

describe("web slash commands", () => {
	it("advertises /undo and blocks it while a turn is running", () => {
		expect(SLASH_COMMANDS).toContainEqual({
			name: "/undo",
			description: "Undo the last turn and restore its files",
			blocking: true,
		});
		expect(isCommandBlocking("/undo")).toBe(true);
	});

	it("advertises memory maintenance commands and blocks them during a turn", () => {
		for (const command of ["/dream", "/distill"]) {
			expect(SLASH_COMMANDS).toContainEqual(expect.objectContaining({ name: command, blocking: true }));
			expect(isCommandBlocking(command), command).toBe(true);
		}
	});

	it("blocks starting a goal or a review mid-run, but not reading, rewording or clearing a goal", () => {
		// Both were declared blocking and missing from the set the server gates on, so a second /goal replaced the
		// durable goal under a live run and then silently failed to start.
		for (const command of ["/goal", "/goal ship it", "/goal 10 ship it", "/goal statusline fix", "/review"]) {
			expect(isCommandBlocking(command), command).toBe(true);
		}
		for (const command of ["/goal status", "/goal clear", "/goal edit new text", "/goal edit"]) {
			expect(isCommandBlocking(command), command).toBe(false);
		}
	});

	it("allows read-only resource inspection during a turn", () => {
		for (const command of [
			"/mcp",
			"/mcp list",
			"/mcp help",
			"/skills",
			"/skills list",
			"/skills help",
			"/ssh",
			"/ssh list",
		]) {
			expect(isCommandBlocking(command), command).toBe(false);
		}
	});

	it("allows automatic memory run inspection and cancellation during a turn", () => {
		for (const command of ["/memory runs", "/memory cancel 01234567-89ab-cdef-0123-456789abcdef"]) {
			expect(isCommandBlocking(command), command).toBe(false);
		}
	});

	it("lets the skill sources be listed during a turn", () => {
		expect(isCommandBlocking("/skills sources")).toBe(false);
	});

	it("blocks resource mutations during a turn", () => {
		for (const command of [
			"/mcp enable server",
			"/mcp disable server",
			"/mcp reconnect server",
			"/mcp uninstall server",
			"/skills enable skill",
			"/skills disable skill",
			"/skills uninstall skill",
			"/skills sources claude off",
			"/ssh add host example.com",
			"/ssh remove host",
		]) {
			expect(isCommandBlocking(command), command).toBe(true);
		}
	});
});

describe("goalIterationBudget", () => {
	it("maps a submit's goal to the turn's iteration budget, the same in the daemon and the TUI", () => {
		expect(goalIterationBudget(undefined)).toBeUndefined();
		expect(goalIterationBudget(false)).toBeUndefined();
		expect(goalIterationBudget(true)).toBe(GOAL_MAX_OUTER_ITERATIONS);
		expect(goalIterationBudget(10)).toBe(10);
	});
});
