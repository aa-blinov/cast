import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ keybindings: undefined as unknown }));
vi.mock("../src/core/settings.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/settings.ts")>()),
	loadSettings: () => ({ keybindings: settings.keybindings }),
}));

const { applyUserKeybindings } = await import("../src/ui-pi/keys.ts");

afterEach(() => {
	settings.keybindings = undefined;
});

describe("applyUserKeybindings", () => {
	it("hands the editing bindings from settings.json to pi-tui's editor", () => {
		settings.keybindings = { "input.submit": "ctrl+j", "editor.deleteToLineStart": ["ctrl+u", "ctrl+y"] };
		applyUserKeybindings();
		expect(getKeybindings().getKeys("tui.input.submit")).toEqual(["ctrl+j"]);
		expect(getKeybindings().getKeys("tui.editor.deleteToLineStart")).toEqual(["ctrl+u", "ctrl+y"]);
	});

	it("leaves the defaults alone when nothing maps, and ignores ids that are cast's own", () => {
		const before = getKeybindings().getKeys("tui.input.tab");
		settings.keybindings = { "input.abort": "ctrl+q", nonsense: "x" };
		applyUserKeybindings();
		expect(getKeybindings().getKeys("tui.input.tab")).toEqual(before);
	});
});
