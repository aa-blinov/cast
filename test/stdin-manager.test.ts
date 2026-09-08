/**
 * suspendAndRun hands the terminal to a callback for a moment. Its fallback
 * path exists for a hook that refuses to suspend (Ink throws when it is
 * already suspended) — and it used to be reached by a callback that simply
 * failed, which then ran a second time with its first error swallowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isTerminalSuspended,
	registerStdinOwner,
	setSuspendHook,
	suspendAndRun,
	unregisterStdinOwner,
} from "../src/core/stdin-manager.ts";

afterEach(() => {
	setSuspendHook(null as unknown as Parameters<typeof setSuspendHook>[0]);
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
		expect(isTerminalSuspended()).toBe(false);
	});

	it("still falls back when the hook refuses to suspend", async () => {
		setSuspendHook(async () => {
			throw new Error("already suspended");
		});
		const callback = vi.fn(async () => "done");

		await expect(suspendAndRun(callback)).resolves.toBe("done");

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("pauses and resumes the stdin owner exactly once around the callback", async () => {
		setSuspendHook(async (callback) => {
			await callback();
		});
		const owner = { id: "composer", onPause: vi.fn(), onResume: vi.fn() };
		registerStdinOwner(owner);

		await suspendAndRun(async () => {
			expect(isTerminalSuspended()).toBe(true);
			expect(owner.onPause).toHaveBeenCalledTimes(1);
			expect(owner.onResume).not.toHaveBeenCalled();
		});

		expect(owner.onResume).toHaveBeenCalledTimes(1);
		unregisterStdinOwner(owner);
	});

	it("resumes the owner even when the callback throws", async () => {
		setSuspendHook(async (callback) => {
			await callback();
		});
		const owner = { id: "composer", onPause: vi.fn(), onResume: vi.fn() };
		registerStdinOwner(owner);

		await expect(
			suspendAndRun(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(owner.onResume).toHaveBeenCalledTimes(1);
		unregisterStdinOwner(owner);
	});

	it("runs the callback directly when no hook is registered", async () => {
		const callback = vi.fn(async () => 7);
		await expect(suspendAndRun(callback)).resolves.toBe(7);
		expect(callback).toHaveBeenCalledTimes(1);
	});
});
