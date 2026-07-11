import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { Message } from "../src/core/llm.ts";
import type { LoopConfig } from "../src/core/loop.ts";
import { findSubagentPrompt, loadSubagentPrompts } from "../src/core/subagents.ts";
import { execTask } from "../src/core/tools/task.ts";

const testConfig = {
	baseURL: "http://localhost",
	apiKey: "test",
	contextWindow: 128_000,
	maxResponseTokens: 8192,
	compactionThreshold: 0.75,
	maxToolOutputLines: 2000,
	maxToolOutputBytes: 64 * 1024,
	defaultBashTimeout: 120,
	reasoningLevel: "off",
	reasoningParams: { body: {} },
} as AppConfig;

/** Run execTask with a fake loop that just records the child's LoopConfig. */
async function captureChildConfig(deps: Partial<Parameters<typeof execTask>[3]>): Promise<LoopConfig> {
	let captured: LoopConfig | undefined;
	const runAgentLoop = async (messages: Message[], config: LoopConfig): Promise<Message[]> => {
		captured = config;
		config.onEvent({ type: "end", reason: "stop" });
		return [...messages, { role: "assistant", content: "child done" }];
	};
	const result = await execTask({ assignment: "explore something" }, "/tmp", testConfig, {
		model: "test-model",
		runAgentLoop,
		...deps,
	});
	expect(result.isError).toBeFalsy();
	expect(captured).toBeDefined();
	return captured!;
}

describe("execTask — plan state handoff", () => {
	it("build mode: child inherits the plan (mirror) but never the plan tools", async () => {
		const child = await captureChildConfig({
			planState: { enabled: false, plansDir: "/tmp/plans-x" },
			disabledTools: new Set(["web_search"]),
		});
		expect(child.planState).toEqual({ enabled: false, plansDir: "/tmp/plans-x" });
		expect(child.disabledTools!.has("plan_write")).toBe(true);
		expect(child.disabledTools!.has("plan_check")).toBe(true);
		expect(child.disabledTools!.has("web_search")).toBe(true);
		expect(child.disabledTools!.has("bash")).toBe(false);
	});

	it("plan mode: child runs with enabled=false (no authoring block) and bash fully blocked", async () => {
		const child = await captureChildConfig({
			planState: { enabled: true, plansDir: "/tmp/plans-y" },
			disabledTools: new Set(["write", "edit"]),
		});
		expect(child.planState!.enabled).toBe(false);
		expect(child.planState!.plansDir).toBe("/tmp/plans-y");
		expect(child.disabledTools!.has("bash")).toBe(true);
		expect(child.disabledTools!.has("write")).toBe(true);
	});

	it("no plan state: child gets none", async () => {
		const child = await captureChildConfig({});
		expect(child.planState).toBeUndefined();
		expect(child.disabledTools!.has("bash")).toBe(false);
	});
});

describe("loadSubagentPrompts", () => {
	it("loads the built-in worker subagent", () => {
		const prompts = loadSubagentPrompts();
		expect(prompts.length).toBeGreaterThanOrEqual(1);
		const worker = prompts.find((p) => p.name === "worker");
		expect(worker).toBeDefined();
		expect(worker!.label).toBe("Worker");
		expect(worker!.systemPrompt.length).toBeGreaterThan(0);
	});

	it("each prompt has name, label, description, systemPrompt", () => {
		for (const p of loadSubagentPrompts()) {
			expect(p.name).toBeTruthy();
			expect(p.label).toBeTruthy();
			expect(typeof p.description).toBe("string");
			expect(p.systemPrompt.length).toBeGreaterThan(0);
		}
	});

	it("strips frontmatter from systemPrompt", () => {
		for (const p of loadSubagentPrompts()) {
			expect(p.systemPrompt).not.toContain("---");
		}
	});
});

describe("findSubagentPrompt", () => {
	it("finds worker by name", () => {
		const all = loadSubagentPrompts();
		const worker = findSubagentPrompt("worker", all);
		expect(worker).toBeDefined();
		expect(worker!.name).toBe("worker");
	});

	it("returns undefined for unknown name", () => {
		const all = loadSubagentPrompts();
		expect(findSubagentPrompt("nonexistent", all)).toBeUndefined();
	});
});
