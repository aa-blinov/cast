import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../src/core/runner.ts";

describe("createAgentRunner", () => {
	it("starts idle with empty queues", () => {
		const r = createAgentRunner();
		expect(r.isRunning).toBe(false);
		expect(r.steeringQueue.hasItems()).toBe(false);
		expect(r.followUpQueue.hasItems()).toBe(false);
	});

	it("tracks running state across startRun / endRun", () => {
		const r = createAgentRunner();
		const lease = r.startRun(new AbortController());
		expect(r.isRunning).toBe(true);
		r.endRun(lease);
		expect(r.isRunning).toBe(false);
	});

	it("abort() aborts the active run's signal", () => {
		const r = createAgentRunner();
		const ac = new AbortController();
		r.startRun(ac);
		r.abort();
		expect(ac.signal.aborted).toBe(true);
	});

	it("abort() clears both queues so a pre-abort /steer or /queue doesn't leak into the next run", () => {
		const r = createAgentRunner();
		r.startRun(new AbortController());
		r.steeringQueue.enqueue({ role: "user", content: "steer" });
		r.followUpQueue.enqueue({ role: "user", content: "queue" });
		r.abort();
		expect(r.steeringQueue.hasItems()).toBe(false);
		expect(r.followUpQueue.hasItems()).toBe(false);
	});

	it("waitForIdle resolves immediately when not running", async () => {
		const r = createAgentRunner();
		await expect(r.waitForIdle()).resolves.toBeUndefined();
	});

	it("waitForIdle stays pending while running and resolves once endRun fires", async () => {
		const r = createAgentRunner();
		const lease = r.startRun(new AbortController());
		let resolved = false;
		const p = r.waitForIdle().then(() => {
			resolved = true;
		});
		await Promise.resolve(); // let any premature resolution flush
		expect(resolved).toBe(false);
		r.endRun(lease);
		await p;
		expect(resolved).toBe(true);
	});

	it("resolves every waiter when the run becomes idle", async () => {
		const r = createAgentRunner();
		const lease = r.startRun(new AbortController());
		let first = false;
		let second = false;
		const firstWaiter = r.waitForIdle().then(() => {
			first = true;
		});
		const secondWaiter = r.waitForIdle().then(() => {
			second = true;
		});

		r.endRun(lease);
		await Promise.all([firstWaiter, secondWaiter]);
		expect(first).toBe(true);
		expect(second).toBe(true);
	});

	it("ignores a stale run completion after a newer run has started", () => {
		const r = createAgentRunner();
		const first = r.startRun(new AbortController());
		r.endRun(first);
		const second = r.startRun(new AbortController());

		r.endRun(first);

		expect(r.isRunning).toBe(true);
		r.endRun(second);
		expect(r.isRunning).toBe(false);
	});
});
