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
});
