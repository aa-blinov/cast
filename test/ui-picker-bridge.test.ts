import { describe, expect, it } from "vitest";
import { createModalBridge } from "../src/ui/pickerBridge.ts";

describe("modal picker bridge", () => {
	it("an aborted signal closes the open picker as cancelled", async () => {
		const bridge = createModalBridge(() => {});
		const controller = new AbortController();
		const picked = bridge.pickers.pickOption([{ value: "once", label: "Allow once" }], { signal: controller.signal });
		expect(bridge.getRequest()?.kind).toBe("option");
		controller.abort();
		await expect(picked).resolves.toBeNull();
		expect(bridge.getRequest()).toBeNull();
	});

	it("an abort after the answer changes nothing, and a pre-aborted one never opens", async () => {
		const bridge = createModalBridge(() => {});
		const controller = new AbortController();
		const picked = bridge.pickers.pickOption([{ value: "once", label: "Allow once" }], { signal: controller.signal });
		const request = bridge.getRequest();
		if (request?.kind !== "option") throw new Error("expected an option picker");
		request.resolve("once");
		controller.abort();
		await expect(picked).resolves.toBe("once");

		const done = new AbortController();
		done.abort();
		await expect(bridge.pickers.pickOption([{ value: 1, label: "x" }], { signal: done.signal })).resolves.toBeNull();
		expect(bridge.getRequest()).toBeNull();
	});
});
