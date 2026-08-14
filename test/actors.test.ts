import { describe, expect, it } from "vitest";
import { AgentActorCancelledError, AgentActorRegistry, type AgentActorSpec } from "../src/core/actors.ts";

const spec: AgentActorSpec = {
	parentSessionId: "parent-session",
	agent: "worker",
	mode: "subagent",
	background: false,
	lifecycle: "ephemeral",
};

describe("AgentActorRegistry", () => {
	it("tracks parent metadata and terminal success", async () => {
		const registry = new AgentActorRegistry();
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
	});

	it("settles as cancelled when the parent aborts before start", async () => {
		const registry = new AgentActorRegistry();
		const parent = new AbortController();
		const actor = registry.spawn(spec, parent.signal);
		parent.abort();

		expect(actor.snapshot().status).toBe("cancelled");
		await expect(actor.run(async () => "unreachable")).rejects.toBeInstanceOf(AgentActorCancelledError);
		expect(await actor.wait()).toBe("cancelled");
	});

	it("propagates cancellation to a running actor and keeps the terminal state", async () => {
		const registry = new AgentActorRegistry();
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
		expect(actor.snapshot().status).toBe("running");
		expect(await actor.wait()).toBe("cancelled");
		expect(actor.snapshot().status).toBe("cancelled");
	});
});
