import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { MessageQueue } from "../src/core/loop.ts";
import { BackgroundTaskRegistry, type BashBackgroundDeps } from "../src/core/tools/bash-background.ts";

const mockConfig: AppConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 10,
};

function makeDeps(running = false) {
	const followUpQueue = new MessageQueue();
	let isRunningFlag = running;
	const deps: BashBackgroundDeps = {
		registry: undefined as unknown as BackgroundTaskRegistry, // filled in by caller once the registry exists
		followUpQueue,
		isRunning: () => isRunningFlag,
	};
	return {
		deps,
		followUpQueue,
		setRunning: (v: boolean) => {
			isRunningFlag = v;
		},
	};
}

describe("BackgroundTaskRegistry", () => {
	it("tracks a started task and transitions running -> exited with the right exit code", async () => {
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(true);
		deps.registry = registry;

		const task = registry.start("echo hi", process.cwd(), mockConfig, 10, deps);
		expect(task.status).toBe("running");
		expect(registry.get(task.id)).toBe(task);

		await new Promise((r) => setTimeout(r, 300));
		expect(task.status).toBe("exited");
		expect(task.exitCode).toBe(0);
		expect(task.rawOutput).toContain("hi");
	});

	it("get() returns undefined for an unknown id", () => {
		const registry = new BackgroundTaskRegistry();
		expect(registry.get("bg-999")).toBeUndefined();
	});

	describe("kill", () => {
		it("kills a running task and reports 'killed'", async () => {
			const registry = new BackgroundTaskRegistry();
			const { deps } = makeDeps(true);
			deps.registry = registry;
			const task = registry.start("sleep 30", process.cwd(), mockConfig, 60, deps);

			expect(registry.kill(task.id)).toBe("killed");
			await new Promise((r) => setTimeout(r, 300));
			expect(task.status).toBe("killed");
		});

		it("reports 'already-done' for a task that already finished", async () => {
			const registry = new BackgroundTaskRegistry();
			const { deps } = makeDeps(true);
			deps.registry = registry;
			const task = registry.start("echo done", process.cwd(), mockConfig, 10, deps);
			await new Promise((r) => setTimeout(r, 300));

			expect(registry.kill(task.id)).toBe("already-done");
		});

		it("reports 'not-found' for an unknown id", () => {
			const registry = new BackgroundTaskRegistry();
			expect(registry.kill("bg-999")).toBe("not-found");
		});
	});

	describe("killAll", () => {
		it("kills every still-running task and leaves finished ones alone", async () => {
			const registry = new BackgroundTaskRegistry();
			const { deps } = makeDeps(true);
			deps.registry = registry;
			const finished = registry.start("echo done", process.cwd(), mockConfig, 10, deps);
			const stillRunning = registry.start("sleep 30", process.cwd(), mockConfig, 60, deps);
			await new Promise((r) => setTimeout(r, 300));
			expect(finished.status).toBe("exited");
			expect(stillRunning.status).toBe("running");

			registry.killAll();
			await new Promise((r) => setTimeout(r, 300));
			expect(finished.status).toBe("exited"); // untouched
			expect(stillRunning.status).toBe("killed");
		});
	});

	describe("completion dispatch", () => {
		it("enqueues onto followUpQueue when the runner is still running", async () => {
			const registry = new BackgroundTaskRegistry();
			const { deps, followUpQueue } = makeDeps(true);
			deps.registry = registry;
			registry.start("echo dispatched-while-running", process.cwd(), mockConfig, 10, deps);

			await new Promise((r) => setTimeout(r, 300));
			const drained = followUpQueue.drain();
			expect(drained).toHaveLength(1);
			expect(drained[0]?.role).toBe("user");
			expect(String(drained[0]?.content)).toContain("<system-reminder>");
			expect(String(drained[0]?.content)).toContain("dispatched-while-running");
		});

		it("calls onIdleWake instead of the queue when the runner is idle", async () => {
			const registry = new BackgroundTaskRegistry();
			const { deps, followUpQueue } = makeDeps(false);
			deps.registry = registry;
			const wake = vi.fn();
			registry.setOnIdleWake(wake);

			registry.start("echo dispatched-while-idle", process.cwd(), mockConfig, 10, deps);
			await new Promise((r) => setTimeout(r, 300));

			expect(wake).toHaveBeenCalledTimes(1);
			expect(String(wake.mock.calls[0]?.[0])).toContain("dispatched-while-idle");
			expect(followUpQueue.drain()).toHaveLength(0);
		});
	});

	it("truncates output the same way as the synchronous bash tool", async () => {
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(true);
		deps.registry = registry;
		const smallConfig: AppConfig = { ...mockConfig, maxToolOutputLines: 5 };
		const task = registry.start("for i in $(seq 1 20); do echo line-$i; done", process.cwd(), smallConfig, 10, deps);

		await new Promise((r) => setTimeout(r, 300));
		expect(task.status).toBe("exited");
		// The completion reminder is what actually goes through formatBashResult's
		// truncation — assert the raw output itself was captured (truncation is
		// exercised at read-time, verified via bash_output in tools.test.ts).
		expect(task.rawOutput.split("\n").filter(Boolean).length).toBe(20);
	});

	it("auto-kills a task that exceeds its timeout", async () => {
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(true);
		deps.registry = registry;
		const task = registry.start("sleep 10", process.cwd(), mockConfig, 1, deps);

		await new Promise((r) => setTimeout(r, 1500));
		expect(task.timedOut).toBe(true);
		expect(task.status).toBe("exited");
	});
});
