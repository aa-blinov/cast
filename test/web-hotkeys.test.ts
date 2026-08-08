import { describe, expect, it } from "vitest";

import { hotkeysHtml, modKey } from "../src/server/public/hotkeys.js";

describe("web hotkeys", () => {
	it("renders the shortcut reference with the platform modifier", () => {
		expect(["Ctrl", "⌘"]).toContain(modKey);
		expect(hotkeysHtml).toContain("Toggle sidebar");
		expect(hotkeysHtml).toContain("Navigate suggestions");
	});
});
