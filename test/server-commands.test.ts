import { describe, expect, it } from "vitest";
import { isCommandBlocking, SLASH_COMMANDS } from "../src/server/commands.ts";

describe("web slash commands", () => {
	it("advertises /undo and blocks it while a turn is running", () => {
		expect(SLASH_COMMANDS).toContainEqual({
			name: "/undo",
			description: "Undo the last turn and restore its files",
			blocking: true,
		});
		expect(isCommandBlocking("/undo")).toBe(true);
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

	it("blocks resource mutations during a turn", () => {
		for (const command of [
			"/mcp enable server",
			"/mcp disable server",
			"/mcp reconnect server",
			"/mcp uninstall server",
			"/skills enable skill",
			"/skills disable skill",
			"/skills uninstall skill",
			"/ssh add host example.com",
			"/ssh remove host",
		]) {
			expect(isCommandBlocking(command), command).toBe(true);
		}
	});
});
