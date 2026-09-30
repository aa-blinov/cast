import { describe, expect, it } from "vitest";
import { createModalBridge } from "../src/ui/pickerBridge.ts";

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
