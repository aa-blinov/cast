import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { MessageQueue } from "../src/core/loop.ts";
import {
	BackgroundTaskRegistry,
	type BashBackgroundDeps,
	isPtySpawnFailure,
} from "../src/core/tools/bash-background.ts";

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
		expect(task.pty).toBeDefined();
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
			await vi.waitFor(() => expect(task.status).toBe("exited"));

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

		// Poll on the actual output line count, not `task.status` — a PTY's
		// "exit" event fires from the child process's wait() status, which is
		// not synchronized with its "data" events draining the kernel tty
		// buffer. `status` can flip to "exited" while output is still
		// arriving, so gating on it (as this test previously did) is racy by
		// construction, not just slow-CI flakiness: no fixed deadline makes
		// that ordering guaranteed. Poll the actual condition instead.
		const deadline = Date.now() + 5000;
		let lineCount = task.rawOutput.split("\n").filter(Boolean).length;
		while (lineCount < 20 && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 25));
			lineCount = task.rawOutput.split("\n").filter(Boolean).length;
		}
		// The completion reminder is what actually goes through formatBashResult's
		// truncation — assert the raw output itself was captured (truncation is
		// exercised at read-time, verified via bash_output in tools.test.ts).
		expect(lineCount).toBe(20);
		expect(task.status).toBe("exited");
	});

	it("does not apply the foreground default timeout when background timeout is omitted", async () => {
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(true);
		deps.registry = registry;
		const task = registry.start(
			"sleep 1",
			process.cwd(),
			{ ...mockConfig, defaultBashTimeout: 0.1 },
			undefined,
			deps,
		);

		await new Promise((r) => setTimeout(r, 300));
		expect(task.status).toBe("running");
		expect(task.timedOut).toBe(false);
		registry.kill(task.id);
		await new Promise((r) => setTimeout(r, 100));
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

describe("BackgroundTaskRegistry retention", () => {
	it("stops holding every finished task's captured output forever", async () => {
		// Nothing ever removed a task, and on an interactive surface every
		// foreground bash call goes through this registry — so a session
		// accumulated captured output for its whole life: 200 finished commands
		// held 3.77MB, and a long session ran into hundreds of megabytes.
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(false);
		deps.registry = registry;

		for (let i = 0; i < 130; i++) {
			await registry.start(`echo line-${i}`, process.cwd(), mockConfig, 10, deps, {
				notifyOnCompletion: false,
			}).exitPromise;
		}

		const held = (registry as unknown as { tasks: Map<string, unknown> }).tasks;
		expect(held.size).toBeLessThanOrEqual(100);
		// The most recent tasks are the ones a caller can still ask about.
		expect(registry.get("bg-130")).toBeDefined();
		expect(registry.get("bg-1")).toBeUndefined();
	});

	it("never drops a running task to make room", async () => {
		const registry = new BackgroundTaskRegistry();
		const { deps } = makeDeps(false);
		deps.registry = registry;

		const longRunning = registry.start("sleep 30", process.cwd(), mockConfig, undefined, deps, {
			notifyOnCompletion: false,
		});
		for (let i = 0; i < 120; i++) {
			await registry.start(`echo f-${i}`, process.cwd(), mockConfig, 10, deps, {
				notifyOnCompletion: false,
			}).exitPromise;
		}

		expect(registry.get(longRunning.id)).toBeDefined();
		expect(registry.hasRunning()).toBe(true);
		registry.killAll();
	});
});

describe("spawn-failure detection", () => {
	// "no such file or directory" is what any command says about a path it
	// cannot find, so a failing `ls` was reported as `Failed to start bash
	// ("bash"): ls: cannot access …` — false about the shell, and it buried the
	// real output behind the wrong explanation.
	it("does not read a command's missing-path error as the shell failing to start", () => {
		expect(isPtySpawnFailure("ls: cannot access '/nope/': No such file or directory\n", "/usr/bin/bash")).toBe(false);
		expect(isPtySpawnFailure("cat: bash.log: No such file or directory\n", "/usr/bin/bash")).toBe(false);
	});

	it("still recognises a real spawn failure", () => {
		expect(isPtySpawnFailure("execvp(3) failed.: No such file or directory", "/usr/bin/bash")).toBe(true);
		expect(isPtySpawnFailure("bash: /nope: No such file or directory\n", "/usr/bin/bash")).toBe(true);
		expect(isPtySpawnFailure("/usr/bin/bash: no such file or directory", "/usr/bin/bash")).toBe(true);
	});
});
