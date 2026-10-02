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

	const answer = (bridge: ReturnType<typeof createModalBridge>, value: unknown) => {
		const request = bridge.getRequest();
		if (!request || request.kind === "status") throw new Error("no question is open");
		(request.resolve as (v: unknown) => void)(value);
	};
	const title = (bridge: ReturnType<typeof createModalBridge>) => {
		const request = bridge.getRequest();
		return request?.kind === "option" ? request.opts?.title : request?.kind;
	};

	it("a second question is shown at once and the first comes back after it; neither is lost", async () => {
		const bridge = createModalBridge(() => {});
		const first = bridge.pickers.pickOption([{ value: "a", label: "A" }], { title: "first" });
		const second = bridge.pickers.pickOption([{ value: "b", label: "B" }], { title: "second" });
		expect(title(bridge)).toBe("second");
		answer(bridge, "b");
		await expect(second).resolves.toBe("b");
		expect(title(bridge)).toBe("first");
		answer(bridge, "a");
		await expect(first).resolves.toBe("a");
		expect(bridge.getRequest()).toBeNull();
	});

	it("answering the same question twice does not close the next one", async () => {
		const bridge = createModalBridge(() => {});
		const text = bridge.pickers.promptText("Name");
		const request = bridge.getRequest();
		if (request?.kind !== "text") throw new Error("expected a text prompt");
		request.resolve("one");
		await expect(text).resolves.toBe("one");
		const next = bridge.pickers.pickOption([{ value: 1, label: "x" }], { title: "next" });
		request.resolve("again"); // a key repeat, a double tap
		expect(title(bridge)).toBe("next");
		answer(bridge, 1);
		await expect(next).resolves.toBe(1);
	});

	it("a question that is aborted while another is on top is dropped without disturbing it", async () => {
		const bridge = createModalBridge(() => {});
		const controller = new AbortController();
		const below = bridge.pickers.pickOption([{ value: "a", label: "A" }], {
			title: "below",
			signal: controller.signal,
		});
		const top = bridge.pickers.pickOption([{ value: "b", label: "B" }], { title: "top" });
		controller.abort();
		await expect(below).resolves.toBeNull();
		expect(title(bridge)).toBe("top");
		answer(bridge, "b");
		await expect(top).resolves.toBe("b");
		expect(bridge.getRequest()).toBeNull();
	});

	it("the progress box shows only while no question does, and is taken down only by its own owner", () => {
		const bridge = createModalBridge(() => {});
		const stop = bridge.pickers.status?.("Checking") ?? (() => {});
		expect(bridge.getRequest()?.kind).toBe("status");
		void bridge.pickers.promptText("Key");
		expect(bridge.getRequest()?.kind).toBe("text");
		const stopLater = bridge.pickers.status?.("Fetching") ?? (() => {});
		stop();
		answer(bridge, null);
		expect(bridge.getRequest()?.kind).toBe("status");
		stopLater();
		expect(bridge.getRequest()).toBeNull();
	});
});
