import { afterEach, describe, expect, it, vi } from "vitest";
import { runDetached } from "../src/server/bridge/detached.ts";

afterEach(() => vi.restoreAllMocks());

describe("runDetached", () => {
	it("logs a rejection instead of leaving it unhandled", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			runDetached(Promise.reject(new Error("Session not found")), "waking a session");
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toEqual([]);
		expect(logged).toHaveBeenCalledWith("[cast server] waking a session failed: Session not found");
	});

	it("says nothing when the promise resolves", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		runDetached(Promise.resolve("done"), "anything");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(logged).not.toHaveBeenCalled();
	});

	it("copes with a rejection that is not an Error", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		runDetached(Promise.reject("plain string"), "thing");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(logged).toHaveBeenCalledWith("[cast server] thing failed: plain string");
	});
});
