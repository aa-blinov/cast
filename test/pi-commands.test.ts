import { describe, expect, it } from "vitest";
import { SLASH_COMMANDS } from "../src/ui/commands.ts";

describe("SLASH_COMMANDS palette visibility", () => {
	it("hides the commands /settings reaches, and keeps the actions", () => {
		const hidden = new Set(SLASH_COMMANDS.filter((c) => c.hidden).map((c) => c.name));
		for (const name of ["/model", "/theme", "/permissions", "/statusbar", "/reasoning", "/turn-cap"]) {
			expect(hidden.has(name), name).toBe(true);
		}
		for (const name of ["/plan", "/fork", "/rewind", "/agents", "/new", "/compact", "/settings", "/help"]) {
			expect(hidden.has(name), name).toBe(false);
		}
	});

	it("still lists every one of them, so typing them in full works", () => {
		const names = new Set(SLASH_COMMANDS.map((c) => c.name));
		for (const name of ["/model", "/theme", "/permissions"]) expect(names.has(name)).toBe(true);
	});
});
