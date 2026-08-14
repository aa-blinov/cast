import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentActorCancelledError,
	AgentActorRegistry,
	type AgentActorSpec,
	SqliteAgentActorStore,
} from "../src/core/actors.ts";
import { resetDbConnectionForTests } from "../src/core/db.ts";

const spec: AgentActorSpec = {
	parentSessionId: "parent-session",
	agent: "worker",
	mode: "subagent",
	background: false,
	lifecycle: "ephemeral",
	forkContext: {
		messages: [{ role: "user", content: "before" }],
		inheritedMessages: [{ role: "user", content: "before" }],
		prefix: [{ role: "user", content: "before" }],
		tail: [],
		boundaryIndex: 0,
		cachePrefixBoundary: 0,
	},
};

let dbDir: string;
beforeEach(() => {
	dbDir = mkdtempSync(join(tmpdir(), "cast-actors-"));
	process.env.CAST_SESSIONS_DB = join(dbDir, "sessions.db");
	resetDbConnectionForTests();
});
afterEach(() => {
	delete process.env.CAST_SESSIONS_DB;
	resetDbConnectionForTests();
	rmSync(dbDir, { recursive: true, force: true });
});

describe("AgentActorRegistry", () => {
	it("tracks parent metadata and terminal success", async () => {
		const notifications: string[] = [];
		const registry = new AgentActorRegistry({
			watchdogIntervalMs: 0,
			onNotification: (notification) => notifications.push(notification.status),
		});
		const actor = registry.spawn(spec);

		expect(actor.snapshot()).toMatchObject({
			parentSessionId: "parent-session",
			agent: "worker",
			status: "pending",
		});

		const result = await actor.run(async (signal) => {
			expect(signal.aborted).toBe(false);
			expect(actor.snapshot().status).toBe("running");
			return "done";
		});

		expect(result).toBe("done");
		expect(actor.snapshot().status).toBe("success");
		expect(await actor.wait()).toBe("success");
		expect(registry.list()).toHaveLength(1);
		expect(notifications).toEqual(["success"]);
	});

	it("settles as cancelled when the parent aborts before start", async () => {
		const registry = new AgentActorRegistry({ watchdogIntervalMs: 0 });
		const parent = new AbortController();
		const actor = registry.spawn(spec, parent.signal);
		parent.abort();

		expect(actor.snapshot().status).toBe("cancelled");
		await expect(actor.run(async () => "unreachable")).rejects.toBeInstanceOf(AgentActorCancelledError);
		expect(await actor.wait()).toBe("cancelled");
	});

	it("propagates cancellation to a running actor and keeps the terminal state", async () => {
		const registry = new AgentActorRegistry({ watchdogIntervalMs: 0 });
		const actor = registry.spawn(spec);
		const started = new Promise<void>((resolve) => {
			const runPromise = actor.run(
				(signal) =>
					new Promise<never>((_, reject) => {
						resolve();
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					}),
			);
			void runPromise.catch(() => undefined);
		});

		await started;
		actor.cancel();
		expect(actor.snapshot().status).toBe("cancelled");
		expect(await actor.wait()).toBe("cancelled");
		expect(actor.snapshot().status).toBe("cancelled");
	});

	it("persists fork context and restores unfinished actors as stalled", async () => {
		const store = new SqliteAgentActorStore();
		const first = new AgentActorRegistry({ store, watchdogIntervalMs: 0 });
		const actor = first.spawn({ ...spec, lifecycle: "persistent" });
		await actor.run(async () => "done");

		const restored = new AgentActorRegistry({ store, watchdogIntervalMs: 0 });
		expect(restored.list()).toEqual([
			expect.objectContaining({
				id: actor.id,
				lifecycle: "persistent",
				status: "success",
				forkContext: spec.forkContext,
			}),
		]);

		const running = first.spawn({ ...spec, lifecycle: "persistent" });
		// The actor has been registered but never started, which models a process
		// dying between registration and the detached work fiber.
		const restarted = new AgentActorRegistry({ store, watchdogIntervalMs: 0 });
		expect(restarted.list().find((item) => item.id === running.id)?.status).toBe("stalled");
	});

	it("marks an unresponsive actor stalled and aborts its work", async () => {
		const registry = new AgentActorRegistry({ watchdogIntervalMs: 0, heartbeatIntervalMs: 0, stallAfterMs: 1 });
		const actor = registry.spawn(spec);
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const runPromise = actor.run(
			(signal) =>
				new Promise<never>((_, reject) => {
					resolveStarted();
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);

		await started;
		const stalled = registry.scanStalled(Date.parse(actor.snapshot().updatedAt) + 10);
		expect(stalled[0]?.status).toBe("stalled");
		expect(actor.snapshot().status).toBe("stalled");
		expect(await actor.wait()).toBe("stalled");
		await expect(runPromise).rejects.toThrow("aborted");
	});
});
