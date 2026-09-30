/**
 * suspendAndRun hands the terminal to a callback for a moment. Its fallback
 * path exists for a hook that refuses to suspend (pi-tui throws when it is
 * already suspended) — and it used to be reached by a callback that simply
 * failed, which then ran a second time with its first error swallowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSuspendHook, suspendAndRun } from "../src/core/stdin-manager.ts";

afterEach(() => {
	setSuspendHook(null);
});

describe("suspendAndRun", () => {
	it("runs the callback once and propagates its error", async () => {
		setSuspendHook(async (callback) => {
			await callback();
		});
		const callback = vi.fn(async () => {
			throw new Error("the work failed");
		});

		await expect(suspendAndRun(callback)).rejects.toThrow("the work failed");

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("still falls back when the hook refuses to suspend", async () => {
		setSuspendHook(async () => {
			throw new Error("already suspended");
		});
		const callback = vi.fn(async () => "done");

		await expect(suspendAndRun(callback)).resolves.toBe("done");

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("runs the callback directly when no hook is registered", async () => {
		const callback = vi.fn(async () => 7);
		await expect(suspendAndRun(callback)).resolves.toBe(7);
		expect(callback).toHaveBeenCalledTimes(1);
	});
});
