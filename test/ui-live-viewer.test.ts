import { describe, expect, it } from "vitest";
import { windowLines } from "../src/ui/live-viewer.tsx";
import { createModalBridge } from "../src/ui/pickerBridge.ts";

const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);

describe("windowLines", () => {
	it("follows the newest lines at 0, and slides back by the offset", () => {
		expect(windowLines(lines, 3, 0)).toEqual(["l7", "l8", "l9"]);
		expect(windowLines(lines, 3, 4)).toEqual(["l3", "l4", "l5"]);
	});

	it("never scrolls past the top, and shows everything when it fits", () => {
		expect(windowLines(lines, 3, 99)).toEqual(["l0", "l1", "l2"]);
		expect(windowLines(["a", "b"], 5, 0)).toEqual(["a", "b"]);
	});
});

describe("modal bridge: live view", () => {
	it("stays open until dismissed, then resolves and clears the request", async () => {
		const bridge = createModalBridge(() => {});
		const view = { title: "worker · job", read: () => ({ text: "x", running: true }) };
		const done = bridge.pickers.viewLive?.(view);
		const request = bridge.getRequest();
		if (request?.kind !== "view") throw new Error("expected a view request");
		expect(request.view).toBe(view);
		request.resolve();
		await expect(done).resolves.toBeUndefined();
		expect(bridge.getRequest()).toBeNull();
	});
});
