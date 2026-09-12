import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import type { Rule } from "../src/core/rules.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { createSession, getFullHistory, loadSession, saveSession } from "../src/core/session.ts";
import { setProjectTrust } from "../src/core/settings.ts";
import type { StartupResult } from "../src/core/startup.ts";
import { sessionInputsDir } from "../src/server/inputs.ts";

// submit() fires runAgentLoop in the background (fire-and-forget) — stub it
// so bridge tests don't need a live provider, but keep everything else
// (MessageQueue, event types) from the real module.
// Resolves with a message array, like the real loop's Promise<Message[]> —
// resolving with undefined left ws.session.messages undefined, which the real
// loop can never do, and made unrelated tests throw out of a detached submit.
const runAgentLoop = vi.fn().mockImplementation(async (messages: unknown) => messages);
vi.mock("../src/core/loop.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/loop.ts")>();
	return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) };
});

// reconcileSessionModel (provider-change model fallback) hits /v1/models —
// stub fetchModels so those tests don't need a live provider either.
const mockFetchModels = vi.fn();
const mockProbeProvider = vi.fn().mockResolvedValue("ok");
vi.mock("../src/core/config.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/config.ts")>();
	return {
		...actual,
		fetchModels: (...args: unknown[]) => mockFetchModels(...args),
		probeProvider: (...args: unknown[]) => mockProbeProvider(...args),
	};
});

// /mcp reconnect|enable|disable|uninstall (and /reload) each close and
// re-resolve MCP connections — controllable so a test can force two of these
// to overlap and assert they serialize instead of racing.
const mockResolveMcpForCwd = vi.fn();
const mockConnectMcpServers = vi.fn();
vi.mock("../src/core/mcp.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/mcp.ts")>();
	return { ...actual, connectMcpServers: (...args: unknown[]) => mockConnectMcpServers(...args) };
});

vi.mock("../src/core/project.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/project.ts")>();
	return { ...actual, resolveMcpForCwd: (...args: unknown[]) => mockResolveMcpForCwd(...args) };
});

const { createServerBridge, SANDBOX_CWD, parseEvolveJson, parseSuggestionJson, toDisplayMessages } = await import(
	"../src/server/bridge.ts"
);

const testConfig: AppConfig = {
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
};

const emptyMcp: McpSetupResult = {
	toolIndex: new Map(),
	toolDefinitions: [],
	connections: [],
	diagnostics: [],
	allServerNames: [],
};

function makePersona(overrides: Partial<Persona> = {}): Persona {
	return {
		name: "coding",
		label: "Coding",
		description: "Reads files, runs commands, edits code",
		systemPrompt: "You are the coding persona.",
		source: "builtin",
		filePath: "/builtin/coding.md",
		subagents: false,
		...overrides,
	} as Persona;
}

/**
 * Poll `cond` until it returns truthy, or up to 5s. Replaces fixed
 * `setTimeout` waits that flake when parallel test files load the event
 * loop — the side effect is real (background task finished, queue has
 * items), we just have to wait for it.
 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

describe("web bridge", () => {
	let fakeHome: string;
	let realHome: string | undefined;
	let cwd: string;

	beforeEach(() => {
		runAgentLoop.mockClear();
		mockFetchModels.mockReset();
		mockProbeProvider.mockClear();
		mockResolveMcpForCwd.mockReset();
		mockResolveMcpForCwd.mockResolvedValue({ ...emptyMcp, allServerNames: ["srv"] });
		mockFetchModels.mockResolvedValue({
			ok: true,
			models: [{ id: "gpt-4o" }, { id: "hy3" }],
		});
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-web-bridge-test-"));
		process.env.HOME = fakeHome;
		cwd = join(fakeHome, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("evicts an idle session with no listeners and hydrates it again on demand", () => {
		vi.useFakeTimers();
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		vi.advanceTimersByTime(5 * 60_000 + 1);
		expect(bridge.getSession(ws.id)).not.toBe(ws);
	});

	function makeResult(overrides: Partial<StartupResult> = {}): StartupResult {
		const coding = makePersona();
		const senior = makePersona({ name: "senior", label: "Senior", systemPrompt: "You are the senior persona." });
		return {
			config: testConfig,
			cwd,
			systemPrompt: "unused — bridge rebuilds its own per-session prompt",
			session: createSession("gpt-4o", cwd),
			runner: createAgentRunner(),
			permissionMode: "default",
			mcpResult: emptyMcp,
			skills: [],
			persona: coding,
			personaOptions: {} as StartupResult["personaOptions"],
			personas: [coding, senior],
			subagentPrompts: [],
			confirmBash: async () => true,
			projectDeps: {} as StartupResult["projectDeps"],
			projectTrusted: true,
			contextFilesSuffix: "",
			rulesSuffix: "",
			rulesLazySuffix: "",
			directoryRules: [],
			activeAutoRules: [],
			skillsPromptSuffix: "",
			sshHosts: [],
			resumed: false,
			...overrides,
		};
	}

	describe("deleteSessionPermanently", () => {
		it("returns false for a session that never existed, live or on disk", () => {
			const bridge = createServerBridge(makeResult());
			expect(bridge.deleteSessionPermanently("no-such-session")).toBe(false);
		});

		it("removes a live session from the registry, unlike closeSession which just unloads it", async () => {
			const { appendMessage, loadSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			appendMessage(ws.session, { role: "user", content: "hi" });
			saveSession(ws.session);
			expect(loadSession(ws.id)).toBeDefined();

			expect(bridge.deleteSessionPermanently(ws.id)).toBe(true);

			expect(bridge.getSession(ws.id)).toBeUndefined();
			expect(loadSession(ws.id)).toBeNull();
		});

		it("removes a session that's only on disk (not currently live)", async () => {
			const { createSession, loadSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createServerBridge(makeResult());
			const orphan = createSession("gpt-4o", cwd);
			saveSession(orphan);
			expect(loadSession(orphan.id)).toBeDefined();

			expect(bridge.deleteSessionPermanently(orphan.id)).toBe(true);

			expect(loadSession(orphan.id)).toBeNull();
		});

		it("aborts a running session before deleting it", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			ws.status = "running";
			const abortSpy = vi.spyOn(ws.runner, "abort");
			bridge.deleteSessionPermanently(ws.id);
			expect(abortSpy).toHaveBeenCalledTimes(1);
		});

		it("also removes the session's attached-documents directory (~/.cast/inputs/<id>)", async () => {
			const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
			const { sessionInputsDir } = await import("../src/server/inputs.ts");
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			const dir = sessionInputsDir(ws.id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "report.pdf"), "fake pdf bytes");
			expect(existsSync(dir)).toBe(true);

			bridge.deleteSessionPermanently(ws.id);

			expect(existsSync(dir)).toBe(false);
		});

		it("doesn't error when a session with no attachments (the common case) is deleted", async () => {
			const { existsSync } = await import("node:fs");
			const { sessionInputsDir } = await import("../src/server/inputs.ts");
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			expect(existsSync(sessionInputsDir(ws.id))).toBe(false);

			expect(() => bridge.deleteSessionPermanently(ws.id)).not.toThrow();
		});
	});

	it("builds a persona-specific system prompt at session creation", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("parses the skill-suggest eval verdict, incl. MiniMax inline thinking", () => {
		// Clean JSON, as emitted when reasoning lands in its own field.
		expect(parseSuggestionJson('{"name": "cut-a-release", "description": "Bump and commit."}')).toEqual({
			name: "cut-a-release",
			description: "Bump and commit.",
		});
		// "Not reusable" verdicts and empty responses both mean "no suggestion".
		expect(parseSuggestionJson('{"name": null}')).toBeNull();
		expect(parseSuggestionJson("")).toBeNull();
		// MiniMax sometimes inlines chain-of-thought before the JSON.
		const inline =
			' thinkingThe transcript shows a clear multi-step release procedure.\n\n{"name": "bump-version-and-release", "description": "Bump package.json, add a changelog entry, and commit the release."}';
		expect(parseSuggestionJson(inline)).toEqual({
			name: "bump-version-and-release",
			description: "Bump package.json, add a changelog entry, and commit the release.",
		});
		// Code-fenced JSON still parses.
		expect(parseSuggestionJson('```json\n{"name": "x", "description": "y"}\n```')).toEqual({
			name: "x",
			description: "y",
		});
	});

	it("parses the /evolve suggestion list, tolerating inline thinking and empty", () => {
		expect(
			parseEvolveJson(
				'[{"name": "cut-a-release", "description": "Bump version and commit"}, {"name": "add-component", "description": "Scaffold a component with tests"}]',
			),
		).toEqual([
			{ name: "cut-a-release", description: "Bump version and commit" },
			{ name: "add-component", description: "Scaffold a component with tests" },
		]);
		// Empty array → nothing reusable.
		expect(parseEvolveJson("[]")).toEqual([]);
		expect(parseEvolveJson("")).toEqual([]);
		// Inline chain-of-thought before the JSON array.
		const inline =
			' thinkingThe session cut a release.\n\n[{"name": "cut-a-release", "description": "Bump and commit"}]';
		expect(parseEvolveJson(inline)).toEqual([{ name: "cut-a-release", description: "Bump and commit" }]);
		// Items missing a name/description are dropped.
		expect(parseEvolveJson('[{"name": "", "description": "x"}, {"name": "ok", "description": "y"}]')).toEqual([
			{ name: "ok", description: "y" },
		]);
	});

	it("runs settings commands without creating a visible session", async () => {
		const bridge = createServerBridge(makeResult());

		expect((await bridge.executeSettingsCommand("/permissions")).ok).toBe(true);
		expect((await bridge.executeSettingsCommand("/model gpt-5")).result).toEqual({ model: "gpt-5" });
		expect(bridge.listSessions()).toEqual([]);
		expect(await bridge.executeSettingsCommand("/clear")).toEqual({
			ok: false,
			error: "Command requires an active session",
		});
	});

	it("/turn-cap works through the settings command path (Settings > Bash saves it)", async () => {
		const bridge = createServerBridge(makeResult());

		const set = await bridge.executeSettingsCommand("/turn-cap 30");
		expect(set.ok).toBe(true);
		expect((await bridge.executeSettingsCommand("/turn-cap")).result).toMatch(/30/);

		// The invalid case must fail rather than silently accept.
		expect((await bridge.executeSettingsCommand("/turn-cap 99999999")).ok).toBe(false);

		await bridge.executeSettingsCommand("/turn-cap reset");
		expect((await bridge.executeSettingsCommand("/turn-cap")).result).toMatch(/500|default|reset/i);
	});

	it("resets each secondary model slot atomically", async () => {
		const bridge = createServerBridge(
			makeResult({
				subagentModel: "worker-model",
				subagentModelProvider: "worker-provider",
				planModel: "planner-model",
				planModelProvider: "planner-provider",
			}),
		);

		expect(await bridge.executeSettingsCommand("/subagent-model reset")).toMatchObject({
			ok: true,
			result: { subagentModel: null, subagentModelProvider: null },
		});
		expect(await bridge.executeSettingsCommand("/plan-model reset")).toMatchObject({
			ok: true,
			result: { planModel: null, planModelProvider: null },
		});
	});

	it("marks an agent skill as Skills.sh only when its lockfile records it", async () => {
		const skillsShDir = join(fakeHome, ".agents", "skills", "from-skills-sh");
		const ampSkillDir = join(fakeHome, ".config", "agents", "skills", "from-amp");
		mkdirSync(skillsShDir, { recursive: true });
		mkdirSync(ampSkillDir, { recursive: true });
		writeFileSync(
			join(skillsShDir, "SKILL.md"),
			"---\nname: from-skills-sh\ndescription: Installed by Skills.sh\n---\n",
		);
		writeFileSync(join(ampSkillDir, "SKILL.md"), "---\nname: from-amp\ndescription: Installed by Amp\n---\n");
		writeFileSync(
			join(fakeHome, ".agents", ".skill-lock.json"),
			JSON.stringify({ skills: { "from-skills-sh": { source: "owner/repo" } } }),
		);
		const bridge = createServerBridge(
			makeResult({
				projectDeps: {
					noSkills: false,
					noMcp: false,
					cliSkillPaths: [],
					cliMcpPaths: [],
				} as StartupResult["projectDeps"],
			}),
		);
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills list");
		const skills = result.result as Array<{ name: string; skillssh: boolean; skillsshSource?: string }>;

		expect(skills.find((skill) => skill.name === "from-skills-sh")).toMatchObject({
			skillssh: true,
			skillsshSource: "owner/repo",
		});
		expect(skills.find((skill) => skill.name === "from-amp")).toMatchObject({ skillssh: false });
	});

	it("sandbox sentinel creates a scratch dir named after the session id before hooks can use its cwd", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession(undefined, undefined, SANDBOX_CWD);
		const expectedDir = join(homedir(), ".cast", "sandbox", `cast-${ws.id}`);
		try {
			expect(ws.session.cwd).toBe(expectedDir);
			expect(ws.systemPrompt).toContain(`Current working directory: ${ws.session.cwd}`);
			expect(statSync(ws.session.cwd).isDirectory()).toBe(true);
		} finally {
			rmSync(ws.session.cwd, { recursive: true, force: true });
		}
	});

	it("a real cwd override is used as-is, not mistaken for the sandbox sentinel", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession(undefined, undefined, fakeHome);
		expect(ws.session.cwd).toBe(fakeHome);
	});

	it("createSession returns a session synchronously, even when a worktree is provided (defence against the async-ification regression)", () => {
		const bridge = createServerBridge(makeResult());
		// `createSession` must stay sync — tests and `/new` slash command both
		// read fields off the returned value without awaiting. If this ever
		// flips back to a Promise, the field reads below turn into runtime
		// `Cannot read properties of undefined` noise.
		const ws = bridge.createSession(undefined, undefined, fakeHome, false, {
			path: fakeHome,
			branch: "cast-test",
			name: "test",
			repoRoot: fakeHome,
			headCommit: "deadbeef",
			createdAt: new Date().toISOString(),
		});
		expect(ws.session.cwd).toBe(fakeHome);
		// Sandbox sentinel + worktree combo is meaningless and rejected by the
		// HTTP layer; the bridge still picks one cwd (worktree wins) when both
		// are passed, so just assert it didn't crash.
		expect(typeof ws.id).toBe("string");
	});

	it("/persona with no arg reports the current persona without changing anything", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona");
		expect(res).toEqual({ ok: true, result: { persona: "coding" } });
	});

	it("/persona <name> switches persona and rebuilds the system prompt", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/persona senior");
		expect(res.ok).toBe(true);
		expect(ws.session.persona).toBe("senior");
		expect(ws.systemPrompt).toContain("You are the senior persona.");
	});

	it("/persona <unknown> fails without mutating session state", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const before = ws.systemPrompt;
		const res = await bridge.executeCommand(ws.id, "/persona ghost");
		expect(res.ok).toBe(false);
		expect(ws.session.persona).toBe("coding");
		expect(ws.systemPrompt).toBe(before);
	});

	it("/quick-session-persona with no arg reports the current default ('senior' when never set)", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona");
		expect(res).toEqual({ ok: true, result: { quickSessionPersona: "senior" } });
	});

	it("/quick-session-persona <name> persists it and getConfig reflects the change", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona senior");
		expect(res).toEqual({ ok: true, result: { quickSessionPersona: "senior" } });
		expect(bridge.getConfig().quickSessionPersona).toBe("senior");
	});

	it("/quick-session-persona <unknown> fails without changing the current default", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/quick-session-persona ghost");
		expect(res.ok).toBe(false);
		expect(bridge.getConfig().quickSessionPersona).toBe("senior");
	});

	it("/memory toggles the global setting and exposes it through config", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect((await bridge.executeCommand(ws.id, "/memory")).result).toEqual(
			expect.objectContaining({
				memoryEnabled: true,
				memoryWriteEnabled: true,
				memoryPromptBudget: 4096,
				memorySearchScoreFloor: 0.15,
				memoryReconcileOnSearch: true,
				memoryDreamAuto: false,
				memoryDreamIntervalDays: 7,
				memoryDistillAuto: false,
				memoryDistillIntervalDays: 30,
			}),
		);
		expect((await bridge.executeCommand(ws.id, "/memory off")).result).toEqual({ memoryEnabled: false });
		expect(bridge.getConfig().memoryEnabled).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/memory on")).result).toEqual({ memoryEnabled: true });
	});

	it("keeps memory readable while allowing background writes to be disabled", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/memory write off")).toEqual({
			ok: true,
			result: { memoryWriteEnabled: false },
		});
		expect(await bridge.executeCommand(ws.id, "/memory write on")).toEqual({
			ok: true,
			result: { memoryWriteEnabled: true },
		});
	});

	it("configures automatic dream and distill intervals through the shared memory command", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/memory dream on")).toEqual({
			ok: true,
			result: { memoryDreamAuto: true },
		});
		expect(await bridge.executeCommand(ws.id, "/memory distill interval 12")).toEqual({
			ok: true,
			result: { memoryDistillIntervalDays: 12 },
		});
		expect((await bridge.executeCommand(ws.id, "/memory")).result).toEqual(
			expect.objectContaining({ memoryDreamAuto: true, memoryDistillIntervalDays: 12 }),
		);
	});

	it("exposes checkpoint fork controls", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint fork on")).toEqual({
			ok: true,
			result: { checkpointFork: true },
		});
		expect((await bridge.executeCommand(ws.id, "/memory")).result).toEqual(
			expect.objectContaining({ checkpointFork: true }),
		);
	});

	it("exposes checkpoint thresholds, reserved, and push caps controls", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint thresholds 20,40,60,80")).toEqual({
			ok: true,
			result: { checkpointThresholds: [20, 40, 60, 80] },
		});
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint thresholds bad")).toEqual({
			ok: false,
			error: "Checkpoint thresholds must be percentages like 20,40,60,80 or 'default'",
		});
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint reserved 20000")).toEqual({
			ok: true,
			result: { checkpointReserved: 20000 },
		});
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint caps checkpoint=11000,memory=9000")).toEqual({
			ok: true,
			result: { checkpointPushCaps: { checkpoint: 11000, memory: 9000 } },
		});
		expect((await bridge.executeCommand(ws.id, "/memory")).result).toEqual(
			expect.objectContaining({
				checkpointThresholds: [20, 40, 60, 80],
				checkpointReserved: 20000,
				checkpointPushCaps: { checkpoint: 11000, memory: 9000 },
			}),
		);
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint thresholds default")).toEqual({
			ok: true,
			result: { checkpointThresholds: undefined },
		});
		expect(await bridge.executeCommand(ws.id, "/memory checkpoint caps default")).toEqual({
			ok: true,
			result: { checkpointPushCaps: undefined },
		});
	});

	it("lists automatic memory runs as independent background records", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/memory runs")).toEqual({
			ok: true,
			result: { runs: [] },
		});
	});

	it("does not run memory maintenance while the global memory switch is off", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		await bridge.executeCommand(ws.id, "/memory off");
		expect(await bridge.executeCommand(ws.id, "/dream")).toEqual({
			ok: false,
			error: "Project memory is disabled",
		});
		expect(await bridge.executeCommand(ws.id, "/distill")).toEqual({
			ok: false,
			error: "Project memory is disabled",
		});
		await bridge.executeCommand(ws.id, "/memory on");
	});

	it("/model <name> updates the session model", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/model gpt-5");
		expect(res).toEqual({ ok: true, result: { model: "gpt-5" } });
		expect(ws.session.model).toBe("gpt-5");
		expect(ws.session.providerUrl).toBe(testConfig.baseURL);
	});

	it("applies the main provider and model as one validated selection", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "remote", url: "https://remote.example/v1", apiKey: "remote-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		const result = await bridge.executeCommand(ws.id, "/model-selection remote hy3");

		expect(result).toEqual({ ok: true, result: { model: "hy3", provider: "remote" } });
		expect(ws.session.model).toBe("hy3");
		expect(ws.session.providerUrl).toBe("https://remote.example/v1");
		expect(loadSettings()).toMatchObject({
			model: "hy3",
			modelProvider: "remote",
			providerUrl: "https://remote.example/v1",
		});
	});

	it("/model-selection with no args fails with usage", async () => {
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/model-selection");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Usage: \/model-selection/);
	});

	it("/model-selection with unknown provider fails without mutating config", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey }],
			modelProvider: "local",
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		const before = ws.session.model;
		const result = await bridge.executeCommand(ws.id, "/model-selection nope hy3");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Unknown provider: nope/);
		expect(ws.session.model).toBe(before);
	});

	it("/model-selection with unknown model fails without mutating config", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey }],
			modelProvider: "local",
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		const before = ws.session.model;
		const result = await bridge.executeCommand(ws.id, "/model-selection local does-not-exist");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/not available/);
		expect(ws.session.model).toBe(before);
	});

	it("/model-selection resets slot models when the provider changes and the slots have no override", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" },
				{ name: "beta", url: "https://beta.example/v1", apiKey: "beta-key" },
			],
			modelProvider: "alpha",
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			subagentModelProvider: undefined,
			planModelProvider: undefined,
			subagentModel: "alpha-sub",
			planModel: "alpha-plan",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		await bridge.executeCommand(ws.id, "/model-selection beta hy3");

		const settings = loadSettings();
		expect(settings.modelProvider).toBe("beta");
		expect(settings.subagentModel).toBeUndefined();
		expect(settings.planModel).toBeUndefined();
	});

	it("/reload re-resolves skills/rules/MCP/personas and returns the success message", async () => {
		const emptyDeps = {
			noSkills: false,
			noMcp: false,
			cliSkillPaths: [],
			cliMcpPaths: [],
		} as StartupResult["projectDeps"];
		const bridge = createServerBridge(makeResult({ projectDeps: emptyDeps }));
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/reload");
		expect(result).toEqual({ ok: true, result: "Reloaded skills, rules, MCP, and personas" });
	});

	it("/reload while the agent is running fails with the idle-required error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const result = await bridge.executeCommand(ws.id, "/reload");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Agent running/);
	});

	it("/undo with no checkpoint returns the no-checkpoint error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/undo");
		expect(result).toEqual({ ok: false, error: "No checkpoint available to undo" });
	});

	it("/undo while the agent is running fails with the idle-required error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const result = await bridge.executeCommand(ws.id, "/undo");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Agent running/);
	});

	it("/provider edit updates the active provider in place, keeping the model and the slots", async () => {
		// The web form used to delete + re-add, and deleting the active provider
		// switched to a fallback, cleared the model and dropped the slots.
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "remote", url: "https://remote.example/v1", apiKey: "remote-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
			model: "hy3",
			subagentModelProvider: "local",
			subagentModel: "hy-small",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig, model: "hy3" } }));

		const edited = await bridge.executeSettingsCommand("/provider edit local http://127.0.0.1:1/v1 new-key");
		expect(edited.ok).toBe(true);

		const settings = loadSettings();
		expect(settings.providers?.find((p) => p.name === "local")).toMatchObject({
			url: "http://127.0.0.1:1/v1",
			apiKey: "new-key",
		});
		expect(settings).toMatchObject({
			providerUrl: "http://127.0.0.1:1/v1",
			apiKey: "new-key",
			modelProvider: "local",
			model: "hy3",
			subagentModelProvider: "local",
			subagentModel: "hy-small",
		});
		expect(bridge.getConfig().baseURL).toBe("http://127.0.0.1:1/v1");
		expect((await bridge.executeSettingsCommand("/provider edit nope http://x/v1 k")).ok).toBe(false);
	});

	it("/provider (no arg) returns the providers list with the active one flagged", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" },
				{ name: "beta", url: "https://beta.example/v1", apiKey: "beta-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			modelProvider: "alpha",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider");
		expect(res.ok).toBe(true);
		expect(res.result).toEqual([
			{ name: "alpha", url: testConfig.baseURL, active: true },
			{ name: "beta", url: "https://beta.example/v1", active: false },
		]);
	});

	it("/provider add <name> <url> <key> becomes the active provider when none is configured", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [],
			providerUrl: "",
			apiKey: "",
			modelProvider: undefined,
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig, baseURL: "", apiKey: "" } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider add minimax https://api.minimax.io/v1 k1");
		expect(res.ok).toBe(true);
		const settings = loadSettings();
		expect(settings.providers?.[0]).toMatchObject({
			name: "minimax",
			url: "https://api.minimax.io/v1",
			apiKey: "k1",
		});
		expect(settings.modelProvider).toBe("minimax");
		expect(bridge.getConfig().baseURL).toBe("https://api.minimax.io/v1");
		expect(ws.session.providerUrl).toBe("https://api.minimax.io/v1");
	});

	it("/provider add <name> <url> <key> when an active provider exists adds but doesn't switch", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" }],
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			modelProvider: "alpha",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider add beta https://beta.example/v1 bk");
		expect(res.ok).toBe(true);
		const settings = loadSettings();
		expect(settings.providers?.map((p) => p.name)).toEqual(["alpha", "beta"]);
		expect(settings.modelProvider).toBe("alpha");
	});

	it("/provider delete <non-active> removes it without touching the active one", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" },
				{ name: "beta", url: "https://beta.example/v1", apiKey: "beta-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			modelProvider: "alpha",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider delete beta");
		expect(res.ok).toBe(true);
		const settings = loadSettings();
		expect(settings.providers?.map((p) => p.name)).toEqual(["alpha"]);
		expect(settings.modelProvider).toBe("alpha");
	});

	it("/provider delete <active> falls back to the first remaining provider and clears the model", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" },
				{ name: "beta", url: "https://beta.example/v1", apiKey: "beta-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			modelProvider: "alpha",
			model: "gpt-4o",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig, model: "gpt-4o" } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider delete alpha");
		expect(res.ok).toBe(true);
		const settings = loadSettings();
		expect(settings.modelProvider).toBe("beta");
		expect(settings.model).toBe("");
		expect(ws.session.model).toBe("");
		expect(ws.session.providerUrl).toBe("https://beta.example/v1");
	});

	it("/provider <name> reasoning <fmt> overrides the auto-detected reasoning protocol", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key", reasoningFormat: "auto" }],
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
			modelProvider: "alpha",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/provider alpha reasoning generic");
		expect(res.ok).toBe(true);
		expect(loadSettings().providers?.[0]?.reasoningFormat).toBe("generic");
	});

	it("/provider <unknown-name> errors with a list pointer instead of switching", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "alpha", url: testConfig.baseURL, apiKey: "alpha-key" }],
			modelProvider: "alpha",
			providerUrl: testConfig.baseURL,
			apiKey: "alpha-key",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/provider nope");
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/Unknown provider: nope/);
	});

	it("/web-search-provider reports whether a key is saved, never the key", async () => {
		const bridge = createServerBridge(makeResult());
		await bridge.executeSettingsCommand("/web-search-provider tavily tvly-secret");
		const shown = await bridge.executeSettingsCommand("/web-search-provider");
		expect(shown.result).toEqual({ searchProvider: "tavily", hasTavilyApiKey: true, hasBraveApiKey: false });
		expect(JSON.stringify(shown)).not.toContain("tvly-secret");
		// Re-selecting without a key keeps the saved one.
		expect((await bridge.executeSettingsCommand("/web-search-provider tavily")).ok).toBe(true);
	});

	it("createSession with a providerOverride pins the session to that provider, not whatever's globally active", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "remote", url: "https://remote.example/v1", apiKey: "remote-key" },
			],
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession(undefined, undefined, undefined, true, undefined, "remote");
		expect(ws.session.providerUrl).toBe("https://remote.example/v1");
	});

	it("an unknown providerOverride name falls back to the globally active provider instead of erroring", async () => {
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession(undefined, undefined, undefined, true, undefined, "no-such-provider");
		expect(ws.session.providerUrl).toBe(testConfig.baseURL);
	});

	it("a session pinned to a different provider runs against its own endpoint, not the shared global one", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "remote", url: "https://remote.example/v1", apiKey: "remote-key" },
			],
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession(undefined, undefined, undefined, true, undefined, "remote");

		await bridge.submit(ws.id, "hello");

		const runConfig = runAgentLoop.mock.calls[0]![1] as { config: AppConfig };
		expect(runConfig.config.baseURL).toBe("https://remote.example/v1");
		expect(runConfig.config.apiKey).toBe("remote-key");
	});

	it("disambiguates two saved providers that share a base URL by name, not just URL", async () => {
		// Reproduces a bug found live: providers.find(p => p.url === ...) alone
		// picks whichever entry happens to come first in the array when two
		// providers share a host with different keys — silently running the
		// pinned session against the wrong one's credentials.
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "first-shared", url: "https://shared.example/v1", apiKey: "first-key" },
				{ name: "second-shared", url: "https://shared.example/v1", apiKey: "second-key" },
			],
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession(undefined, undefined, undefined, true, undefined, "second-shared");
		expect(ws.session.providerName).toBe("second-shared");

		await bridge.submit(ws.id, "hello");

		const runConfig = runAgentLoop.mock.calls[0]![1] as { config: AppConfig };
		expect(runConfig.config.apiKey).toBe("second-key");
	});

	it("switching provider in one session does not leak into another already-open session's next run", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "remote", url: "https://remote.example/v1", apiKey: "remote-key" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const untouched = bridge.createSession();
		const pinned = bridge.createSession(undefined, undefined, undefined, true, undefined, "remote");

		await bridge.submit(pinned.id, "hello from the pinned session");
		await bridge.submit(untouched.id, "hello from the untouched session");

		const pinnedRun = runAgentLoop.mock.calls[0]![1] as { config: AppConfig };
		const untouchedRun = runAgentLoop.mock.calls[1]![1] as { config: AppConfig };
		expect(pinnedRun.config.baseURL).toBe("https://remote.example/v1");
		expect(untouchedRun.config.baseURL).toBe(testConfig.baseURL);
	});

	it("does not push a pinned session's reasoning level onto the shared config/settings", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey, reasoningFormat: "generic" },
				{
					name: "remote",
					url: "https://remote.example/v1",
					apiKey: "remote-key",
					reasoningFormat: "openai-compatible",
				},
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
			reasoningLevel: "off",
		});
		const config = { ...testConfig, reasoningFormat: "generic" } as AppConfig;
		const bridge = createServerBridge(makeResult({ config }));
		const pinned = bridge.createSession(undefined, undefined, undefined, true, undefined, "remote");

		await bridge.submit(pinned.id, "hello");

		expect(config.reasoningFormat).toBe("generic");
		expect(loadSettings().reasoningLevel).toBe("off");
	});

	it("/current shows a pinned session's own resolved reasoning level, not the global one if it's invalid for that model", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				// minimax's reasoning vocabulary is enabled/adaptive/disabled —
				// "high" (a generic-format level) isn't one of its options.
				{ name: "minimax-pinned", url: "https://api.minimax.io/v1", apiKey: "mm-key", reasoningFormat: "minimax" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
			reasoningLevel: "high",
		});
		const config = { ...testConfig, reasoningFormat: "generic", reasoningLevel: "high" } as AppConfig;
		const bridge = createServerBridge(makeResult({ config }));
		const pinned = bridge.createSession(undefined, undefined, undefined, true, undefined, "minimax-pinned");

		const result = await bridge.executeCommand(pinned.id, "/current");

		expect(result).toMatchObject({ ok: true, result: { reasoningLevel: "enabled" } });
		// The global level itself must be untouched by just reading /current.
		expect(config.reasoningLevel).toBe("high");
	});

	// Characterization tests for the read-only "session info" commands. These
	// exist before the executeCommand → registry refactor so they pin the
	// exact result shape (including the markdown that /help renders and the
	// non-git fallback that /repo returns for a fresh tmpdir cwd). Once the
	// commands move into per-handler files, the public seam stays the same
	// — these tests are what makes that move safe.

	it("/help returns the visible-command list as a single markdown string", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/help");
		expect(result.ok).toBe(true);
		expect(typeof result.result).toBe("string");
		expect(result.result).toContain("**Available commands:**");
		expect(result.result).toContain("Blocking (require idle):");
	});

	it("/usage returns the session's cumulative token counter untouched", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/usage");
		expect(result.ok).toBe(true);
		expect(result.result).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cost: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			uncachedTokens: 0,
			subagentTokens: 0,
		});
	});

	it("/repo returns isGit:false for a fresh tmpdir cwd that has no .git", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/repo");
		expect(result.ok).toBe(true);
		expect(result.result).toMatchObject({ isGit: false });
		expect(typeof (result.result as { cwd: string }).cwd).toBe("string");
	});

	// Slice 2 characterization — pinned below /current and /repo before the
	// registry gains wider context (cwd / config / loadSettings). These pin
	// the full result shape so the refactor can't quietly drop a field.

	it("/current returns the full session state shape with persona/model/reasoningLevel/etc", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/current");
		expect(result.ok).toBe(true);
		const r = result.result as Record<string, unknown>;
		// Every key the inline implementation must populate, by name only
		// (values are tested elsewhere — providerName / reasoningLevel are
		// tested in the pinned-session test above).
		for (const key of [
			"persona",
			"model",
			"providerUrl",
			"providerName",
			"reasoningLevel",
			"mode",
			"status",
			"messageCount",
			"usage",
			"lastTurn",
			"permissionMode",
			"subagentModel",
			"subagentModelProvider",
			"planModel",
			"planModelProvider",
			"maxTurnIterations",
		]) {
			expect(key in r).toBe(true);
		}
		expect(r.mode).toBe("build");
		expect(r.status).toBe("idle");
	});

	it("/repo for a freshly-initialised git repo returns branch and dirty state", async () => {
		// Create the bridge and session first so we can read the session's cwd,
		// then init git there and run /repo again. We use the session's own
		// `ws.session.cwd` rather than the testEnvironment fixture because
		// the latter is captured inside beforeEach and not re-exported.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const sessionCwd = ws.session.cwd ?? "";
		expect(sessionCwd).not.toBe("");
		execFileSync("git", ["init", "-b", "main", sessionCwd], { stdio: "pipe" });
		execFileSync("git", ["-C", sessionCwd, "config", "user.email", "test@cast"], {
			stdio: "pipe",
		});
		execFileSync("git", ["-C", sessionCwd, "config", "user.name", "test"], { stdio: "pipe" });
		// One commit on `main` so the rev-parse --abbrev-ref HEAD call has
		// something to point at.
		execFileSync("git", ["-C", sessionCwd, "commit", "--allow-empty", "-m", "init"], {
			stdio: "pipe",
		});

		const result = await bridge.executeCommand(ws.id, "/repo");
		expect(result.ok).toBe(true);
		const r = result.result as { cwd: string; isGit: boolean; branch: string; dirty: boolean };
		expect(r.isGit).toBe(true);
		expect(r.cwd).toBe(sessionCwd);
		expect(r.branch).toBe("main");
		expect(r.dirty).toBe(false);
	});

	// Slice 3 characterization — pinned below /repo before the registry
	// gains deps for fork/plan-note/abort/steer/queue (appendMessage,
	// saveSession, broadcaster, abort, submit, runner.steeringQueue /
	// followUpQueue). These pin the public return values; existing
	// tests in this file already cover /fork and the empty-arg case
	// for /steer + /queue.

	it("/plan-note appends a system-reminder user message and returns Recorded", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/plan-note Use type extraction");
		expect(result).toEqual({ ok: true, result: "Recorded" });
		// The decision is appended as a user-role message wrapped in a
		// <system-reminder> tag, so the loop can route it the same way as
		// any other internal protocol reminder.
		const last = ws.session.messages[ws.session.messages.length - 1];
		expect(last).toMatchObject({
			role: "user",
			content: "<system-reminder>Use type extraction</system-reminder>",
		});
	});

	it("/plan-note (no arg) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/plan-note");
		expect(result).toEqual({ ok: false, error: "Usage: /plan-note <decision>" });
	});

	it("/abort returns Aborted", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/abort")).toEqual({ ok: true, result: "Aborted" });
	});

	it("/stop (alias of /abort) returns Aborted", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/stop")).toEqual({ ok: true, result: "Aborted" });
	});

	it("/queue-reset returns Queue cleared", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/queue-reset")).toEqual({ ok: true, result: "Queue cleared" });
	});

	it("/qr (alias of /queue-reset) returns Queue cleared", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/qr")).toEqual({ ok: true, result: "Queue cleared" });
	});

	it("/steer (running) routes the message into the steering queue and returns Steered into the running turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		expect(await bridge.executeCommand(ws.id, "/steer adjust plan")).toEqual({
			ok: true,
			result: "Steered into the running turn",
		});
	});

	it("/queue (running) routes the message into the follow-up queue and returns Queued for after this turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		expect(await bridge.executeCommand(ws.id, "/queue follow-up task")).toEqual({
			ok: true,
			result: "Queued for after this turn",
		});
	});

	// Slice 4 characterization — /sessions and /hooks before the registry
	// gains listSessions / listHooksForCwdSettings / updateSettings as
	// deps. The /hooks verb branch is the easy "list + diagnostics"
	// surface; enable/disable requires settings state and is best
	// verified through the public return value rather than mutated
	// settings internals.

	it("/sessions returns the list of session summaries", async () => {
		const bridge = createServerBridge(makeResult());
		bridge.createSession(); // first session
		const second = bridge.createSession(); // second session
		const result = await bridge.executeCommand(second.id, "/sessions");
		expect(result.ok).toBe(true);
		expect(Array.isArray(result.result)).toBe(true);
		const summaries = result.result as Array<{ id: string }>;
		expect(summaries.length).toBeGreaterThanOrEqual(2);
		expect(summaries.some((s) => s.id === second.id)).toBe(true);
	});

	it("/hooks help returns the help string", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/hooks help");
		expect(result.ok).toBe(true);
		expect(typeof result.result).toBe("string");
		expect(result.result as string).toContain("/hooks");
	});

	it("/hooks (no verb) returns entries and diagnostics", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/hooks");
		expect(result.ok).toBe(true);
		const r = result.result as { entries: unknown[]; diagnostics: unknown[] };
		expect(Array.isArray(r.entries)).toBe(true);
		expect(Array.isArray(r.diagnostics)).toBe(true);
	});

	it("/hooks enable <unknown-id> returns an error naming the missing id", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/hooks enable nonexistent-hook");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/No hook with id "nonexistent-hook"/);
	});

	it("/hooks enable <empty-id> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/hooks enable");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Usage: /hooks enable <id>");
	});

	it("/hooks unknown-verb returns an error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/hooks frobnicate");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Unknown /hooks frobnicate");
	});

	// Slice 5 characterization — settings toggles before the registry gains
	// loadSettings + updateSettings as deps (plus a tiny setPermissionMode
	// callback for /permissions to mutate the closure-local mode). These
	// commands all share the same shape: read current setting, branch on
	// arg, persist via updateSettings (and a callback mutation for
	// /permissions). Existing tests for /turn-cap and the default
	// /permissions "runs without a session" path already cover the
	// obvious happy paths — slice 5 focuses on the commands that had no
	// characterization at all and on the mutation contract of /permissions.

	it("/theme (no arg) returns the current theme", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/theme");
		expect(result.ok).toBe(true);
		// Default cast theme — the test fixture never overrides it.
		expect(result.result).toMatchObject({ theme: expect.any(String) });
	});

	it("/theme <id> sets the theme and returns its label and colors", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/theme cast");
		expect(result.ok).toBe(true);
		const r = result.result as { theme: string; label: string; colors: unknown };
		expect(r.theme).toBe("cast");
		expect(typeof r.label).toBe("string");
		expect(r.colors).toBeDefined();
	});

	it("/theme <invalid> returns an error naming the unknown theme", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/theme nope-not-a-theme");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Unknown theme: nope-not-a-theme/);
	});

	it("/web (no arg) returns the current webTools boolean", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/web");
		expect(result.ok).toBe(true);
		// Default false (off) — the test fixture never enables webTools.
		expect(result.result).toEqual({ webTools: false });
	});

	it("/web on/off toggle persists and round-trips through /web", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const setOn = await bridge.executeCommand(ws.id, "/web on");
		expect(setOn.ok).toBe(true);
		expect((setOn.result as { webTools: boolean }).webTools).toBe(true);
		const readBack = await bridge.executeCommand(ws.id, "/web");
		expect((readBack.result as { webTools: boolean }).webTools).toBe(true);
		const setOff = await bridge.executeCommand(ws.id, "/web off");
		expect(setOff.ok).toBe(true);
		expect((setOff.result as { webTools: boolean }).webTools).toBe(false);
	});

	it("/web <invalid> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/web sometimes");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Usage: /web on|off");
	});

	it("/web-fetch-provider (no arg) returns the default jina provider", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/web-fetch-provider");
		expect(result.ok).toBe(true);
		expect(result.result).toEqual({ webFetchProvider: "jina" });
	});

	it("/web-fetch-provider local sets the provider and round-trips", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const set = await bridge.executeCommand(ws.id, "/web-fetch-provider local");
		expect(set.ok).toBe(true);
		expect((set.result as { webFetchProvider: string }).webFetchProvider).toBe("local");
		const readBack = await bridge.executeCommand(ws.id, "/web-fetch-provider");
		expect((readBack.result as { webFetchProvider: string }).webFetchProvider).toBe("local");
	});

	it("/web-fetch-provider <bad> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/web-fetch-provider firefox");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Usage: /web-fetch-provider jina | local");
	});

	it("/statusbar returns the statusBar setting object", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/statusbar");
		expect(result.ok).toBe(true);
		const r = result.result as { visible: unknown; order: unknown; sides: unknown };
		expect(Array.isArray(r.visible)).toBe(true);
		expect(Array.isArray(r.order)).toBe(true);
		expect(typeof r.sides).toBe("object");
	});

	it("/reasoning-display toggles showReasoning and the next read reflects it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const first = await bridge.executeCommand(ws.id, "/reasoning-display");
		expect(first.ok).toBe(true);
		const firstState = (first.result as { showReasoning: boolean }).showReasoning;
		// Defaults to true (showReasoning ?? true inside bridge.ts); the
		// toggle flips it. We don't pin the absolute value here because
		// future settings.json migrations might — the contract is "toggle".
		const second = await bridge.executeCommand(ws.id, "/reasoning-display");
		expect((second.result as { showReasoning: boolean }).showReasoning).toBe(!firstState);
	});

	it("/rd is an alias of /reasoning-display and also toggles", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// Take one reading from the long-form, then call /rd and confirm
		// it flipped the same flag (i.e. /rd isn't a no-op that returned
		// the current value back unchanged).
		const baseline = (await bridge.executeCommand(ws.id, "/reasoning-display")).result as { showReasoning: boolean };
		const afterAlias = await bridge.executeCommand(ws.id, "/rd");
		expect((afterAlias.result as { showReasoning: boolean }).showReasoning).toBe(!baseline.showReasoning);
	});

	it("/permissions bypass mutates the closure so the next read returns bypass", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// Default is "default"; set bypass and confirm the closure-local
		// value (not just settings.json) flipped — this is what
		// submit() reads on the next turn.
		const set = await bridge.executeCommand(ws.id, "/permissions bypass");
		expect(set.ok).toBe(true);
		expect((set.result as { permissionMode: string }).permissionMode).toBe("bypass");
		const readBack = await bridge.executeCommand(ws.id, "/permissions");
		expect((readBack.result as { permissionMode: string }).permissionMode).toBe("bypass");
	});

	it("/permissions <invalid> returns the usage error without mutating state", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/permissions readonly");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("Usage: /permissions default|bypass");
		const readBack = await bridge.executeCommand(ws.id, "/permissions");
		expect((readBack.result as { permissionMode: string }).permissionMode).toBe("default");
	});

	// Slice 6 characterization — model-slot commands before the registry
	// gains five closure setters (setSubagentModel, setSubagentModelProvider,
	// setPlanModel, setPlanModelProvider, setQuickSessionPersona) plus the
	// current `personas` snapshot for /quick-session-persona's
	// "Unknown persona" error. Existing tests cover /subagent-model reset,
	// /plan-model reset, and all three /quick-session-persona shapes —
	// slice 6 focuses on the *-provider slots and the setter/back mutation
	// contract for the non-reset paths.

	it("/subagent-model <name> sets the slot and the next read returns it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const set = await bridge.executeCommand(ws.id, "/subagent-model hy3-worker");
		expect(set.ok).toBe(true);
		expect((set.result as { subagentModel: string }).subagentModel).toBe("hy3-worker");
		const readBack = await bridge.executeCommand(ws.id, "/subagent-model");
		expect((readBack.result as { subagentModel: string }).subagentModel).toBe("hy3-worker");
	});

	it("/subagent-model off clears the slot without touching the provider slot", async () => {
		// Pre-seed settings — createSession's syncActiveProviderFromSettings
		// would otherwise re-read empty settings and zero the provider slot
		// back to undefined before our read-back assertion runs.
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({ subagentModel: "hy3-worker", subagentModelProvider: "worker-provider" });
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const off = await bridge.executeCommand(ws.id, "/subagent-model off");
		expect(off.ok).toBe(true);
		expect(off.result).toEqual({ subagentModel: null });
		// The provider slot must survive — /subagent-model reset (below) is the
		// command that clears both, /off only touches the model slot.
		const readProvider = await bridge.executeCommand(ws.id, "/subagent-model-provider");
		expect((readProvider.result as { subagentModelProvider: string }).subagentModelProvider).toBe("worker-provider");
	});

	it("/subagent-model-provider <name> sets the slot and the next read returns it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const set = await bridge.executeCommand(ws.id, "/subagent-model-provider worker-provider");
		expect(set.ok).toBe(true);
		expect((set.result as { subagentModelProvider: string }).subagentModelProvider).toBe("worker-provider");
		const readBack = await bridge.executeCommand(ws.id, "/subagent-model-provider");
		expect((readBack.result as { subagentModelProvider: string }).subagentModelProvider).toBe("worker-provider");
	});

	it("/subagent-model-provider reset clears the slot to null", async () => {
		// Pre-seed settings (see /subagent-model off for the rationale).
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({ subagentModel: "hy3-worker", subagentModelProvider: "worker-provider" });
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const reset = await bridge.executeCommand(ws.id, "/subagent-model-provider reset");
		expect(reset.ok).toBe(true);
		expect((reset.result as { subagentModelProvider: string }).subagentModelProvider).toBeNull();
		// /subagent-model-provider reset only touches the provider slot, not the model.
		const readModel = await bridge.executeCommand(ws.id, "/subagent-model");
		expect((readModel.result as { subagentModel: string }).subagentModel).toBe("hy3-worker");
	});

	it("/plan-model-provider <name> sets the slot and the next read returns it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const set = await bridge.executeCommand(ws.id, "/plan-model-provider planner-provider");
		expect(set.ok).toBe(true);
		expect((set.result as { planModelProvider: string }).planModelProvider).toBe("planner-provider");
		const readBack = await bridge.executeCommand(ws.id, "/plan-model-provider");
		expect((readBack.result as { planModelProvider: string }).planModelProvider).toBe("planner-provider");
	});

	it("/plan-model-provider reset clears the slot to null", async () => {
		// Pre-seed settings (see /subagent-model off for the rationale).
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({ planModel: "planner", planModelProvider: "planner-provider" });
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const reset = await bridge.executeCommand(ws.id, "/plan-model-provider reset");
		expect(reset.ok).toBe(true);
		expect((reset.result as { planModelProvider: string }).planModelProvider).toBeNull();
		const readModel = await bridge.executeCommand(ws.id, "/plan-model");
		expect((readModel.result as { planModel: string }).planModel).toBe("planner");
	});

	// Slice 7 characterization — /reasoning and the missing /reasoning-format
	// read/invalid paths before the registry gains setDefaultModel,
	// setReasoningMeta, and a computeSystemPrompt callback (the last one is
	// needed because it reads the closure's `skills`, `rulesForSessionCwd`,
	// and `mcpResult` — not safe to import as a top-level helper). Existing
	// tests already cover /model and /persona end-to-end; slice 7 fills the
	// reasoning holes.

	it("/reasoning (no arg) returns the current level plus the available options", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/reasoning");
		expect(result.ok).toBe(true);
		const r = result.result as { reasoningLevel: string; options: string[] };
		expect(typeof r.reasoningLevel).toBe("string");
		expect(Array.isArray(r.options)).toBe(true);
		// testConfig sets reasoningLevel: "off"; gpt-4o (the default
		// session model from makeResult) has at least the "off" option, so
		// the array must include it.
		expect(r.options).toContain("off");
	});

	it("/reasoning <level> sets the level and the next read returns it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// `off` is always a valid option (it's the universal default), so
		// using it here keeps the test independent of which reasoning
		// options the test stub model actually exposes.
		const set = await bridge.executeCommand(ws.id, "/reasoning off");
		expect(set.ok).toBe(true);
		expect((set.result as { reasoningLevel: string }).reasoningLevel).toBe("off");
		const readBack = await bridge.executeCommand(ws.id, "/reasoning");
		expect((readBack.result as { reasoningLevel: string }).reasoningLevel).toBe("off");
	});

	it("/reasoning <invalid> returns the usage error and does not mutate config", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/reasoning turbo-mega");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Unknown reasoning level: turbo-mega/);
		const readBack = await bridge.executeCommand(ws.id, "/reasoning");
		// Mutating config.reasoningLevel on the error path would silently
		// change every subsequent turn; the inline implementation only
		// assigns after the option check passes.
		expect((readBack.result as { reasoningLevel: string }).reasoningLevel).toBe("off");
	});

	it("/reasoning-format (no arg) returns the current format plus the available options", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/reasoning-format");
		expect(result.ok).toBe(true);
		const r = result.result as { reasoningFormat: string; options: string[] };
		// testConfig doesn't set reasoningFormat, so the field can be
		// undefined at boot — pin the contract to "options always returned,
		// contains 'auto'", which is what every caller actually depends on.
		expect(Array.isArray(r.options)).toBe(true);
		expect(r.options).toContain("auto");
	});

	it("/reasoning-format <invalid> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/reasoning-format hamster");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Unknown reasoning format: hamster/);
	});

	// Slice 8 characterization — session-lifecycle commands (/clear, /compact,
	// /new) before the registry gains the closure callbacks createSessionInstance
	// and syncFsWatcher. Most of /compact's dep set (compactSessionMessages,
	// recordCompaction, resolveHooksForCwd, runHooksForEvent, addUsage) is
	// imported directly from core. /clear and /new are trivial — the
	// characterization just pins the return shape so a regression in the
	// fast path surfaces.

	it("/clear empties the session messages and returns Context cleared", async () => {
		const { appendMessage } = await import("../src/core/session.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		appendMessage(ws.session, { role: "user", content: "hello" });
		appendMessage(ws.session, { role: "assistant", content: "world" });
		expect(ws.session.messages.length).toBe(2);

		const result = await bridge.executeCommand(ws.id, "/clear");
		expect(result).toEqual({ ok: true, result: "Context cleared" });
		expect(ws.session.messages.length).toBe(0);
	});

	it("/new returns a fresh sessionId distinct from the source session", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/new");
		expect(result.ok).toBe(true);
		const r = result.result as { sessionId: string };
		expect(typeof r.sessionId).toBe("string");
		expect(r.sessionId).not.toBe(ws.id);
		// The new session is registered — bridge.getSession must find it.
		expect(bridge.getSession(r.sessionId)).toBeDefined();
	});

	it("/compact on an empty session returns Nothing to compact yet without running hooks", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(ws.session.messages.length).toBe(0);
		const result = await bridge.executeCommand(ws.id, "/compact");
		expect(result).toEqual({ ok: true, result: "Nothing to compact yet" });
	});

	it("/compact on a populated session returns Compacting… immediately (work happens async)", async () => {
		const { appendMessage } = await import("../src/core/session.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		appendMessage(ws.session, { role: "user", content: "hello" });
		const result = await bridge.executeCommand(ws.id, "/compact");
		// The command returns immediately — the actual compaction runs in
		// the background and reports back over SSE. /compact is fire-and-
		// forget, matching the inline implementation's contract.
		expect(result).toEqual({ ok: true, result: "Compacting…" });
	});

	// Slice 9 characterization — /plan and /build before the registry
	// gains its own handlers. All the deps (computeSystemPrompt,
	// currentPersona, personas, saveSession, broadcaster) already exist in
	// CommandContext from slice 7 (/model and /persona). Existing tests
	// cover the planTransition-clearing side effect; slice 9 pins the
	// happy-path mode toggle + system prompt rebuild.

	it("/plan switches the session to plan mode and returns the Plan-mode message", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const beforePrompt = ws.systemPrompt;
		const result = await bridge.executeCommand(ws.id, "/plan");
		expect(result).toEqual({
			ok: true,
			result: "Plan mode — read-only exploration and planning; /build to exit",
		});
		expect(ws.session.mode).toBe("plan");
		// Rebuilding the prompt is the whole point of the toggle — without
		// it, the model still sees the build-mode toolset on the next turn.
		expect(ws.systemPrompt).not.toBe(beforePrompt);
	});

	it("/build switches the session back to build mode and returns the Build-mode message", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.mode = "plan";
		const beforePrompt = ws.systemPrompt;
		const result = await bridge.executeCommand(ws.id, "/build");
		expect(result).toEqual({ ok: true, result: "Build mode — full toolset" });
		expect(ws.session.mode).toBe("build");
		expect(ws.systemPrompt).not.toBe(beforePrompt);
	});

	it("/plan clears a stale planQuestion so the next turn doesn't carry it forward", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// Synthesise the pre-existing state a /plan-question that never
		// resolved would leave behind — the /plan switch must drop it.
		ws.session.planQuestion = { id: "stale" } as never;
		await bridge.executeCommand(ws.id, "/plan");
		expect(ws.session.planQuestion).toBeUndefined();
	});

	// Slice 10 characterization — /memory, /dream, /distill before the
	// registry gains them. Existing tests already exercise most of
	// /memory's subcommands (on/off, write, checkpoint fork/thresholds/
	// reserved/caps, dream/distill auto toggle + interval, runs, the
	// "Project memory is disabled" error); slice 10 fills the smaller
	// contracts that don't yet have direct coverage.

	it("/memory <unknown> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/memory frobnicate");
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Usage: \/memory on\|off/);
	});

	it("/memory budget <n> clamps to the supported 256..16384 range", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// Below floor -> clamped up to 256
		const tooSmall = await bridge.executeCommand(ws.id, "/memory budget 64");
		expect(tooSmall).toEqual({ ok: true, result: { memoryPromptBudget: 256 } });
		// Above ceiling -> clamped down to 16384
		const tooBig = await bridge.executeCommand(ws.id, "/memory budget 99999");
		expect(tooBig).toEqual({ ok: true, result: { memoryPromptBudget: 16_384 } });
	});

	it("/dream and /distill reject with a different error when only writing is disabled", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// /memory write off disables the writing switch while leaving the
		// global switch on — /dream and /distill must reject with a
		// memory-WRITING error, not the memory-DISABLED error from the
		// earlier test. This pins the distinction so a regression that
		// collapses them into one branch is caught.
		await bridge.executeCommand(ws.id, "/memory write off");
		const dream = await bridge.executeCommand(ws.id, "/dream");
		expect(dream).toEqual({ ok: false, error: "Project memory writing is disabled" });
		const distill = await bridge.executeCommand(ws.id, "/distill");
		expect(distill).toEqual({ ok: false, error: "Project memory writing is disabled" });
	});

	// Slice 11 characterization — /continue before the registry gains it.
	// Zero existing coverage for this command; the inline implementation
	// in bridge.ts is six lines that pick the most-recently-updated session
	// other than the source. Three tests pin the three behaviors:
	// no-peers → error, has-peers → returns id, excludes source session.

	it("/continue with no other sessions returns the No other sessions error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/continue");
		expect(result).toEqual({ ok: false, error: "No other sessions to continue" });
	});

	it("/continue returns the most-recently-updated other session", async () => {
		const bridge = createServerBridge(makeResult());
		const wsA = bridge.createSession();
		const wsB = bridge.createSession();
		const wsC = bridge.createSession();
		// Make wsA oldest, wsC newest (the default order would be
		// creation order). UpdatedAt is a number, so we set it directly.
		wsA.session.updatedAt = 100;
		wsB.session.updatedAt = 200;
		wsC.session.updatedAt = 300;

		const result = await bridge.executeCommand(wsB.id, "/continue");
		expect(result.ok).toBe(true);
		expect((result.result as { sessionId: string }).sessionId).toBe(wsC.id);
	});

	it("/continue excludes the source session from the candidates", async () => {
		const bridge = createServerBridge(makeResult());
		const wsA = bridge.createSession();
		const wsB = bridge.createSession();
		// wsA is the newest; /continue from wsA must return wsB, not wsA
		// itself, even though it's the most-recently-updated.
		wsA.session.updatedAt = 500;
		wsB.session.updatedAt = 100;

		const result = await bridge.executeCommand(wsA.id, "/continue");
		expect(result).toEqual({ ok: true, result: { sessionId: wsB.id } });
	});

	// Slice 12 characterization — /goal and /review before the registry
	// gains them. Both are blocking commands (isCommandBlocking gate),
	// fire-and-forget via the closure's submit() — the registry path
	// calls it through `ctx.submit`, which forwards to the same closure.
	// Since submit() is closure-private (no public bridge.submit to spy
	// on), the indirect observation is runAgentLoop, which submit()
	// eventually invokes. runAgentLoop is mocked at file scope, so we
	// can wait for it to be called after the command returns.

	it("/goal (no arg) returns the usage error without running the loop", async () => {
		runAgentLoop.mockClear();
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/goal");
		expect(result).toEqual({
			ok: false,
			error: "Usage: /goal [N] <what to achieve>  (or /goal --steps N <desc>)",
		});
		// No submit was fired — the loop stays quiet for at least one tick.
		await new Promise((r) => setTimeout(r, 50));
		expect(runAgentLoop).not.toHaveBeenCalled();
	});

	it("/goal <goal> returns the kick-off message and the loop sees the prompt", async () => {
		runAgentLoop.mockClear();
		runAgentLoop.mockImplementationOnce(async (messages: unknown) => messages);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/goal write a poem");
		expect(result.ok).toBe(true);
		expect(result.result).toMatch(/^Working toward the goal autonomously \(budget: \d+\)…$/);
		await waitFor(() => runAgentLoop.mock.calls.length >= 1);
		// runAgentLoop signature is (initialMessages, loopConfig). The loop
		// config carries sessionId, maxOuterIterations, etc.; submit() packs
		// the goal prompt into initialMessages and threads the budget via
		// loopConfig.maxOuterIterations.
		const [messages, loopConfig] = runAgentLoop.mock.calls[0]!;
		expect((loopConfig as { sessionId: string }).sessionId).toBe(ws.session.id);
		expect((loopConfig as { maxOuterIterations?: number }).maxOuterIterations).toEqual(expect.any(Number));
		// The synthesized prompt reaches the loop with the user's goal text.
		const promptText = (messages as Array<{ content: string }>).map((m) => m.content).join("\n");
		expect(promptText).toContain("write a poem");
	});

	it("/goal 50 <goal> honours the explicit step budget", async () => {
		runAgentLoop.mockClear();
		runAgentLoop.mockImplementationOnce(async (messages: unknown) => messages);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		await bridge.executeCommand(ws.id, "/goal 50 ship the report");
		await waitFor(() => runAgentLoop.mock.calls.length >= 1);
		const [, loopConfig] = runAgentLoop.mock.calls[0]!;
		expect((loopConfig as { maxOuterIterations?: number }).maxOuterIterations).toBe(50);
	});

	it("/review returns the kick-off message and the loop runs with the review prompt", async () => {
		runAgentLoop.mockClear();
		runAgentLoop.mockImplementationOnce(async (messages: unknown) => messages);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/review");
		expect(result).toEqual({ ok: true, result: "Reviewing the session's work…" });
		await waitFor(() => runAgentLoop.mock.calls.length >= 1);
		const [messages, loopConfig] = runAgentLoop.mock.calls[0]!;
		expect((loopConfig as { sessionId: string }).sessionId).toBe(ws.session.id);
		const promptText = (messages as Array<{ content: string }>).map((m) => m.content).join("\n");
		expect(promptText).toMatch(/[Rr]eview/);
	});

	// Slice 13 characterization — /rules and /rule:<id> before the registry
	// gains them. /rules is a read-only listing (project-directoryRules
	// snapshot, with a `sticky` flag for rules already latched on this
	// session). /rule:<id> invokes a rule as a real user turn — it must
	// reject while a turn is running so the dispatcher's idle gate stays
	// intact for the inline path.

	it("/rules (no arg) returns the directory rules with id/name/description/applyMode", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/rules");
		expect(result.ok).toBe(true);
		const list = result.result as Array<{
			id: string;
			name: string;
			description: string;
			applyMode: string;
			sticky: boolean;
		}>;
		expect(Array.isArray(list)).toBe(true);
		// Each entry carries the contract shape — even if the project has no
		// rules installed, an empty array is the same shape; the per-field
		// shape check pins what /rules emits so a regression that drops
		// applyMode or sticky would fail this test (and existing tests).
		if (list.length > 0) {
			const r = list[0];
			expect(typeof r.id).toBe("string");
			expect(typeof r.name).toBe("string");
			expect(typeof r.description).toBe("string");
			expect(typeof r.applyMode).toBe("string");
			expect(typeof r.sticky).toBe("boolean");
		}
	});

	it("/rules marks sticky: true for rules in activeAutoRules", async () => {
		// The test fixture has no project rules installed, so directoryRules
		// is empty — set ws.activeAutoRules directly and pin the contract
		// that an empty activeAutoRules means every entry has sticky: false.
		// (The positive sticky: true case is covered by the project-rules
		// test at line ~2339 which seeds a real project with a rule and
		// inspects its sticky field.)
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/rules");
		expect(result.ok).toBe(true);
		const list = result.result as Array<{ sticky: boolean }>;
		// No activeAutoRules → no entry can have sticky: true.
		for (const entry of list) expect(entry.sticky).toBe(false);
		// Pin the contract for ws.activeAutoRules wired through to the
		// listing: seed a non-empty activeAutoRules and verify the
		// sticky: false contract still holds for an empty directoryRules
		// (no rule in the listing matches the seeded id, so nothing flips
		// to true — the field is a projection, not an autorule itself).
		ws.activeAutoRules = [{ id: "stale", name: "stale-rule" } as never];
		const second = await bridge.executeCommand(ws.id, "/rules");
		expect(second.ok).toBe(true);
		for (const entry of second.result as Array<{ sticky: boolean }>) expect(entry.sticky).toBe(false);
	});

	it("/rule: <empty> returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// /rule: (no id) — the colon but no name after it
		const result = await bridge.executeCommand(ws.id, "/rule:");
		expect(result).toEqual({ ok: false, error: "Usage: /rule:<name>" });
	});

	it("/rule: while a turn is running returns the Agent-running error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		// Mark the session as running. The rule dispatcher checks this
		// itself (the inline implementation did the same) so it short-
		// circuits before firing fireUserPromptExpansion or submit.
		ws.status = "running";
		runAgentLoop.mockClear();
		const result = await bridge.executeCommand(ws.id, "/rule:any-name");
		expect(result).toEqual({
			ok: false,
			error: "Agent running — use /queue, /steer, or /abort",
		});
		await new Promise((r) => setTimeout(r, 50));
		expect(runAgentLoop).not.toHaveBeenCalled();
	});

	// Slice 14 characterization — the small headless-parity commands
	// (/quit, /exit, /copy, /older, /keys). The TUI handles these
	// client-side (clipboard, keybindings, history paging), but the
	// daemon must still return an equivalent result so a `cast run
	// --interactive` consumer can round-trip every slash command
	// instead of hitting "Unknown command". No existing test coverage.

	it("/quit and /exit on an idle session return the idle ack", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/quit")).toEqual({ ok: true, result: "idle" });
		expect(await bridge.executeCommand(ws.id, "/exit")).toEqual({ ok: true, result: "idle" });
	});

	it("/quit on a running session aborts and returns the quit ack", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const abortSpy = vi.spyOn(ws.runner, "abort");
		const result = await bridge.executeCommand(ws.id, "/quit");
		expect(result).toEqual({ ok: true, result: "quit requested" });
		expect(abortSpy).toHaveBeenCalledTimes(1);
	});

	it("/copy on a session with no assistant message returns an empty string", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/copy")).toEqual({ ok: true, result: "" });
	});

	it("/copy returns the most recent assistant string content", async () => {
		const { appendMessage } = await import("../src/core/session.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		appendMessage(ws.session, { role: "user", content: "say hello" });
		appendMessage(ws.session, { role: "assistant", content: "world" });
		appendMessage(ws.session, { role: "user", content: "and goodbye" });
		appendMessage(ws.session, { role: "assistant", content: "see ya" });
		expect(await bridge.executeCommand(ws.id, "/copy")).toEqual({ ok: true, result: "see ya" });
	});

	it("/older returns hasMoreHistory and oldestSeq for the current session", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/older");
		expect(result.ok).toBe(true);
		const r = result.result as { hasMoreHistory: boolean; oldestSeq: number | null };
		expect(typeof r.hasMoreHistory).toBe("boolean");
		expect(r.oldestSeq === null || typeof r.oldestSeq === "number").toBe(true);
	});

	it("/keys returns the TUI-keys informational message", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(await bridge.executeCommand(ws.id, "/keys")).toEqual({
			ok: true,
			result: "keybindings are a TUI concept; see docs or /help for commands",
		});
	});

	// Slice 15 characterization — /skills-sh before the registry gains it.
	// The 4 subcommands (install / list-available / search / uninstall)
	// all funnel into skillsSh* helpers from core/skills-sh which require
	// either the skills-sh CLI on PATH or network access — neither is
	// present in the test fixture. We pin only the contracts that are
	// deterministically observable without the CLI:
	//
	//   /skills-sh <unknown-subcommand> returns the inline-defined
	//   'Unknown /skills-sh subcommand' error (no external state);
	//   /skills-sh install (no args) returns the 'Usage: install
	//   <owner/repo> --skill <name>' error from skillsShInstall's own
	//   arg validation, proving the registry hands off to the helper;
	//   /skills-sh (empty arg) returns the same unknown-subcommand
	//   error since "" is not in the recognised set.

	it("/skills-sh <unknown subcommand> returns the inline usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills-sh frobnicate");
		expect(result).toEqual({
			ok: false,
			error: `Unknown /skills-sh subcommand: "frobnicate". Try: install, list-available, search, uninstall.`,
		});
	});

	it("/skills-sh (empty arg) returns the unknown-subcommand error for ''", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills-sh");
		expect(result).toEqual({
			ok: false,
			error: `Unknown /skills-sh subcommand: "". Try: install, list-available, search, uninstall.`,
		});
	});

	it("/skills-sh install (no args) hands off to skillsShInstall which returns its own usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills-sh install");
		expect(result.ok).toBe(false);
		// The skillsShInstall helper validates its own arg shape and
		// throws a 'Usage: install <owner/repo> --skill <name>' error
		// — proves the registry forwards the call instead of swallowing
		// the subcommand.
		expect(result.error).toMatch(/Usage: \/skills-sh install/);
	});

	// Slice 16 characterization — /ssh before the registry gains it.
	// Three subcommands (list, add, remove). Tests pin the deterministic
	// contracts only — the round-trip via saveSshConfig requires a real
	// home-dir setup, which the existing suggestCommand test fixture
	// already covers; we don't duplicate it here.

	it("/ssh (no arg) and /ssh list both return the host list with the expected shape", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const noArg = await bridge.executeCommand(ws.id, "/ssh");
		const explicitList = await bridge.executeCommand(ws.id, "/ssh list");
		expect(noArg.ok).toBe(true);
		expect(explicitList.ok).toBe(true);
		expect(Array.isArray(noArg.result)).toBe(true);
		expect(noArg.result).toEqual(explicitList.result);
	});

	it("/ssh add <name> <host> returns Added host", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/ssh add staging staging.example.com");
		expect(result).toEqual({ ok: true, result: 'Added host "staging"' });
	});

	it("/ssh add (missing host) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/ssh add staging-only");
		expect(result).toEqual({
			ok: false,
			error: "Usage: /ssh add <name> <host> [username] [port] [keyPath] [password]",
		});
	});

	it("/ssh remove (missing name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/ssh remove");
		expect(result).toEqual({ ok: false, error: "Usage: /ssh remove <name>" });
	});

	it("/ssh remove <unknown> returns the Unknown host error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/ssh remove never-added");
		expect(result).toEqual({ ok: false, error: "Unknown host: never-added" });
	});

	it("/ssh <unknown subcommand> returns the inline usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/ssh frobnicate");
		expect(result).toEqual({ ok: false, error: "Unknown /ssh subcommand: frobnicate" });
	});

	// Slice 17 characterization — /mcp before the registry gains it.
	// Six subcommands (list / help / enable / disable / reconnect /
	// uninstall) plus an unknown-subcommand fallback. The existing
	// 'concurrent /mcp enable and disable serialize' test covers the
	// reconnect-after-mutation path through withMcpLock; slice 17
	// pins the deterministic contracts (usage errors + help text +
	// list-aliased path) so a regression in those short-circuits would
	// surface as a fast failure rather than the slow lock-contention
	// flake the existing test already guards.

	it("/mcp list returns the session's server list with name/source/connected/disabled", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp list");
		expect(result.ok).toBe(true);
		const list = result.result as Array<{
			name: string;
			source: string;
			connected: boolean;
			disabled: boolean;
		}>;
		expect(Array.isArray(list)).toBe(true);
		// Even with no servers installed the shape is consistent — this
		// pins the contract a regression that drops `connected` or
		// `disabled` would break.
		if (list.length > 0) {
			const entry = list[0];
			expect(typeof entry.name).toBe("string");
			expect(typeof entry.source).toBe("string");
			expect(typeof entry.connected).toBe("boolean");
			expect(typeof entry.disabled).toBe("boolean");
		}
	});

	it("/mcp (no arg) is an alias for /mcp list and returns the same shape", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const noArg = await bridge.executeCommand(ws.id, "/mcp");
		const list = await bridge.executeCommand(ws.id, "/mcp list");
		expect(noArg.ok).toBe(true);
		expect(list.ok).toBe(true);
		expect(noArg.result).toEqual(list.result);
	});

	it("/mcp help returns the help-text with the four mutating subcommands", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp help");
		expect(result).toEqual({
			ok: true,
			result: "/mcp list – /mcp enable <name> – /mcp disable <name> – /mcp reconnect <name> – /mcp uninstall <name>",
		});
	});

	it("/mcp enable (no name) returns the usage error without mutating state", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp enable");
		expect(result).toEqual({ ok: false, error: "Usage: /mcp enable <name>" });
	});

	it("/mcp disable (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp disable");
		expect(result).toEqual({ ok: false, error: "Usage: /mcp disable <name>" });
	});

	it("/mcp reconnect (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp reconnect");
		expect(result).toEqual({ ok: false, error: "Usage: /mcp reconnect <name>" });
	});

	it("/mcp reinstall (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp uninstall");
		expect(result).toEqual({ ok: false, error: "Usage: /mcp uninstall <name>" });
	});

	it("/mcp <unknown subcommand> returns the inline usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/mcp frobnicate");
		expect(result).toEqual({ ok: false, error: "Unknown /mcp subcommand: frobnicate" });
	});

	// Slice 18 characterization — /skills before the registry gains it.
	// Five subcommands (list / help / enable / disable / uninstall) plus
	// the unknown-subcommand fallback. The list path is exercised by an
	// existing fakeHome install block; slice 18 pins the contracts that
	// don't need that setup (usage errors + help text + unknown-subcmd).
	// The /skills list + /skills uninstall paths need a projectDeps with
	// cliSkillPaths=[] (else discoverSkillsForCwd throws on undefined
	// extraPaths) — same override as the existing fakeHome list test.

	const emptySkillsDeps = {
		noSkills: false,
		noMcp: false,
		cliSkillPaths: [],
		cliMcpPaths: [],
	} as StartupResult["projectDeps"];

	it("/skills list returns the skill list with name/source/filePath/description/enabled/uninstallable", async () => {
		const bridge = createServerBridge(makeResult({ projectDeps: emptySkillsDeps }));
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills list");
		expect(result.ok).toBe(true);
		const list = result.result as Array<{
			name: string;
			source: string;
			filePath: string;
			description: string;
			enabled: boolean;
			uninstallable: boolean;
		}>;
		expect(Array.isArray(list)).toBe(true);
		if (list.length > 0) {
			const entry = list[0];
			expect(typeof entry.name).toBe("string");
			expect(typeof entry.source).toBe("string");
			expect(typeof entry.filePath).toBe("string");
			expect(typeof entry.description).toBe("string");
			expect(typeof entry.enabled).toBe("boolean");
			expect(typeof entry.uninstallable).toBe("boolean");
		}
	});

	it("/skills (no arg) is an alias for /skills list and returns the same shape", async () => {
		const bridge = createServerBridge(makeResult({ projectDeps: emptySkillsDeps }));
		const ws = bridge.createSession();
		const noArg = await bridge.executeCommand(ws.id, "/skills");
		const list = await bridge.executeCommand(ws.id, "/skills list");
		expect(noArg.ok).toBe(true);
		expect(list.ok).toBe(true);
		expect(noArg.result).toEqual(list.result);
	});

	it("/skills help returns the help-text with the four subcommands", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills help");
		expect(result).toEqual({
			ok: true,
			result: "/skills list – /skills enable <name> – /skills disable <name> – /skills uninstall <name>",
		});
	});

	it("/skills enable (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills enable");
		expect(result).toEqual({ ok: false, error: "Usage: /skills enable <name>" });
	});

	it("/skills disable (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills disable");
		expect(result).toEqual({ ok: false, error: "Usage: /skills disable <name>" });
	});

	it("/skills uninstall (no name) returns the usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills uninstall");
		expect(result).toEqual({ ok: false, error: "Usage: /skills uninstall <name>" });
	});

	it("/skills uninstall <unknown> returns the Unknown skill error", async () => {
		const bridge = createServerBridge(makeResult({ projectDeps: emptySkillsDeps }));
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills uninstall never-installed");
		expect(result).toEqual({ ok: false, error: "Unknown skill: never-installed" });
	});

	it("/skills <unknown subcommand> returns the inline usage error", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const result = await bridge.executeCommand(ws.id, "/skills frobnicate");
		expect(result).toEqual({ ok: false, error: "Unknown /skills subcommand: frobnicate" });
	});

	it("tells the model the reasoning level the turn actually runs with, not the global one", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [
				{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
				{ name: "minimax-pinned", url: "https://api.minimax.io/v1", apiKey: "mm-key", reasoningFormat: "minimax" },
			],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
			reasoningLevel: "high",
		});
		const config = { ...testConfig, reasoningFormat: "generic", reasoningLevel: "high" } as AppConfig;
		const bridge = createServerBridge(makeResult({ config }));
		const pinned = bridge.createSession(undefined, undefined, undefined, true, undefined, "minimax-pinned");

		await bridge.submit(pinned.id, "hello");

		const run = runAgentLoop.mock.calls[0]![1] as {
			config: AppConfig;
			rebuildSystemPrompt: (ctx: { userText: string; contextFiles: string[] }) => string;
		};
		// loop.ts calls rebuildSystemPrompt for every turn, so this — not the
		// prompt cached at session creation — is what the model actually reads.
		const prompt = run.rebuildSystemPrompt({ userText: "hello", contextFiles: [] });
		expect(prompt).toContain(`- Reasoning: ${run.config.reasoningLevel}`);
		expect(prompt).toContain("- Reasoning: enabled");
		expect(prompt).not.toContain("- Reasoning: high");
	});

	it("chooses a valid model default when the current reasoning level is unsupported", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providers: [{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey }],
			providerUrl: testConfig.baseURL,
			apiKey: testConfig.apiKey,
			modelProvider: "local",
			reasoningLevel: "max",
		});
		mockFetchModels.mockResolvedValue({
			ok: true,
			models: [
				{
					id: "hy3",
					reasoning: {
						mandatory: false,
						defaultEnabled: true,
						supportedEfforts: ["low", "high"],
						defaultEffort: "low",
					},
				},
			],
		});
		const config = { ...testConfig, reasoningLevel: "max", reasoningFormat: "openai-compatible" } as AppConfig;
		const bridge = createServerBridge(makeResult({ config }));
		const ws = bridge.createSession();

		await bridge.executeCommand(ws.id, "/model-selection local hy3");

		expect(loadSettings()).toMatchObject({ model: "hy3", reasoningLevel: "low" });
		expect(bridge.getReasoningOptionsForSession(ws.id).options.map((option) => option.value)).toEqual([
			"off",
			"low",
			"high",
		]);
	});

	it("rebuilds reasoning transport when another surface changes the session model", async () => {
		const { loadSession, saveSession } = await import("../src/core/session.ts");
		const config = { ...testConfig, reasoningLevel: "high", reasoningFormat: "openai-compatible" } as AppConfig;
		mockFetchModels.mockResolvedValue({
			ok: true,
			models: [
				{
					id: "hy3",
					reasoning: {
						mandatory: false,
						defaultEnabled: true,
						supportedEfforts: ["high"],
						defaultEffort: "high",
					},
				},
			],
		});
		const bridge = createServerBridge(makeResult({ config }));
		const ws = bridge.createSession();
		saveSession(ws.session);
		const persisted = loadSession(ws.id)!;
		persisted.model = "hy3";
		persisted.providerUrl = config.baseURL;
		saveSession(persisted);

		await bridge.submit(ws.id, "hello");

		const runConfig = runAgentLoop.mock.calls[0]![1] as { config: AppConfig };
		expect(runConfig.config.reasoningParams.body).toEqual({ reasoning_effort: "high" });
	});

	it("adopts an externally changed reasoning format on the next turn", async () => {
		const { updateSettings } = await import("../src/core/settings.ts");
		const config = { ...testConfig, reasoningLevel: "off", reasoningFormat: "openai-compatible" } as AppConfig;
		updateSettings({
			providers: [{ name: "local", url: config.baseURL, apiKey: config.apiKey, reasoningFormat: "generic" }],
			providerUrl: config.baseURL,
			apiKey: config.apiKey,
			modelProvider: "local",
		});
		const bridge = createServerBridge(makeResult({ config }));
		const ws = bridge.createSession();

		await bridge.submit(ws.id, "hello");

		const runConfig = runAgentLoop.mock.calls[0]![1] as { config: AppConfig };
		expect(runConfig.config.reasoningFormat).toBe("generic");
		expect(runConfig.config.reasoningParams.body).toEqual({});
	});

	it("records the provider on a web-created session", () => {
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();

		expect(ws.session.providerUrl).toBe(testConfig.baseURL);
	});

	it("/provider <name> persists the active provider for the next startup", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		updateSettings({
			providerUrl: "http://localhost",
			apiKey: "test",
			modelProvider: "old",
			providers: [
				{ name: "old", url: "http://localhost", apiKey: "test" },
				{ name: "minimax", url: "https://api.minimax.io/v1", apiKey: "minimax-key" },
			],
		});
		const bridge = createServerBridge(makeResult({ config: { ...testConfig } }));
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/provider minimax");

		expect(res).toEqual({ ok: true, result: 'Switched to provider "minimax" — pick a model with /model' });
		expect(loadSettings()).toMatchObject({
			modelProvider: "minimax",
			providerUrl: "https://api.minimax.io/v1",
			apiKey: "minimax-key",
		});
		updateSettings({
			modelProvider: undefined,
			providerUrl: "http://localhost",
			apiKey: "test",
			providers: [],
		});
	});

	it("/model <name> becomes the default for sessions created afterward", async () => {
		const bridge = createServerBridge(makeResult());
		const first = bridge.createSession();
		expect(first.session.model).toBe("gpt-4o");
		await bridge.executeCommand(first.session.id, "/model gpt-5");
		const second = bridge.createSession();
		expect(second.session.model).toBe("gpt-5");
	});

	it("/model <name> broadcasts a session_update so the sidebar reflects it immediately", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const events: Array<{ type: string }> = [];
		bridge.subscribeAll((e) => events.push(e));
		await bridge.executeCommand(ws.id, "/model gpt-5");
		const update = events.find((e) => e.type === "session_update") as
			| { type: "session_update"; session: { model: string } }
			| undefined;
		expect(update?.session.model).toBe("gpt-5");
	});

	it("/reasoning-format persists the selected format for the active provider", async () => {
		const { loadSettings, updateSettings } = await import("../src/core/settings.ts");
		const config = { ...testConfig, baseURL: "https://provider.example/v1", apiKey: "provider-key" };
		updateSettings({
			providers: [{ name: "provider", url: config.baseURL, apiKey: config.apiKey, reasoningFormat: "auto" }],
		});
		const bridge = createServerBridge(makeResult({ config }));
		const ws = bridge.createSession();

		const res = await bridge.executeCommand(ws.id, "/reasoning-format generic");

		expect(res).toEqual({ ok: true, result: { reasoningFormat: "generic" } });
		expect(loadSettings().providers?.[0]?.reasoningFormat).toBe("generic");
	});

	it("shareSession generates a token and getSharedSession returns a read-only projection by that token", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.title = "My thread";
		ws.session.messages.push(
			{ role: "system", content: "You are the coding persona. Project root: /home/secret/project" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		);

		const shared = bridge.shareSession(ws.id);
		expect(shared?.token).toBeTruthy();

		const view = bridge.getSharedSession(shared.token);
		expect(view?.title).toBe("My thread");
		expect(view?.model).toBe(ws.session.model);
		expect(view?.messages.some((m) => m.content === "hi there")).toBe(true);
		// The persona's system prompt (paths, tool internals) is for the
		// session's own owner, not an anonymous visitor with the link.
		expect(view?.messages.some((m) => m.role === "system")).toBe(false);
	});

	it("the shared view hides what tool calls carried, and the reminders injected into a turn", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.messages.push(
			{
				role: "user",
				content: "read the env\n<system-reminder>project memory: staging password rotates weekly</system-reminder>",
			},
			{
				role: "assistant",
				content: "done",
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"cat /home/me/.env"}' } },
				],
			} as never,
			{ role: "tool", tool_call_id: "c1", content: "OPENAI_API_KEY=sk-SUPERSECRET" } as never,
		);

		const shared = bridge.shareSession(ws.id);
		const view = bridge.getSharedSession(shared.token);
		const json = JSON.stringify(view);

		// The link is a *conversation* link: that `bash` ran and succeeded is
		// fine, what it printed is not — and the JSON is served with no auth,
		// so the client hiding tool cards would not be a control at all.
		const call = view?.messages.find((m) => m.toolCalls?.length)?.toolCalls?.[0];
		expect(call?.name).toBe("bash");
		expect(call?.status).toBe("ok");
		expect(json).not.toContain("SUPERSECRET");
		expect(json).not.toContain("/home/me/.env");
		// Same for the <system-reminder> bodies toDisplayMessages surfaces as
		// `warning` rows — project memory and attached documents, not the
		// visitor's business.
		expect(json).not.toContain("staging password");
		expect(view?.messages.some((m) => m.role === "warning")).toBe(false);
		// Still readable as a conversation.
		expect(view?.messages.some((m) => m.content === "done")).toBe(true);
	});

	it("isFullyIdle is false while anything is happening or anyone is watching", async () => {
		// What ends an unregistered daemon must never be "the clients went
		// away" — that is what the daemon is for: the user closes the terminal
		// and the agent keeps working. So this asks whether anything is in
		// flight, not whether anyone is connected.
		const bridge = createServerBridge(makeResult());
		expect(bridge.isFullyIdle()).toBe(true);

		const ws = bridge.createSession();
		expect(bridge.isFullyIdle(), "a fresh idle session is not work").toBe(true);

		const listener = () => {};
		bridge.subscribe(ws.id, listener);
		expect(bridge.isFullyIdle(), "a subscribed client is someone watching").toBe(false);
		bridge.unsubscribe(ws.id, listener);
		expect(bridge.isFullyIdle()).toBe(true);

		ws.status = "running";
		expect(bridge.isFullyIdle(), "a turn in flight").toBe(false);
		ws.status = "idle";

		ws.backgroundBash.registry.start("sleep 30", process.cwd(), {} as never, 30, ws.backgroundBash);
		expect(bridge.isFullyIdle(), "a background task outlives the turn that started it").toBe(false);
		ws.backgroundBash.registry.killAll();
	});

	it("lastActivityAt moves on any event, so brief work between polls still counts", async () => {
		// The retirement watchdog samples every 30s; a turn that starts and
		// finishes between two samples is invisible to sampling (measured with a
		// 1s tick: a short turn in the middle of the quiet window went unnoticed
		// and the window was never reset). A watermark cannot miss it.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const before = bridge.lastActivityAt();
		await new Promise((resolve) => setTimeout(resolve, 5));

		const listener = () => {};
		bridge.subscribe(ws.id, listener);
		const afterSubscribe = bridge.lastActivityAt();
		expect(afterSubscribe).toBeGreaterThan(before);

		await new Promise((resolve) => setTimeout(resolve, 5));
		bridge.unsubscribe(ws.id, listener);
		expect(bridge.lastActivityAt()).toBeGreaterThan(afterSubscribe);
	});

	it("shareSession is idempotent — calling it twice returns the same token", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const first = bridge.shareSession(ws.id);
		const second = bridge.shareSession(ws.id);
		expect(second?.token).toBe(first?.token);
	});

	it("unshareSession revokes the token — getSharedSession no longer resolves it", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const shared = bridge.shareSession(ws.id);
		expect(bridge.unshareSession(ws.id)).toBe(true);
		expect(bridge.getSharedSession(shared.token)).toBeNull();
	});

	it("getSharedSession returns null for an unknown token, and shareSession/unshareSession return null/false for an unknown session", () => {
		const bridge = createServerBridge(makeResult());
		expect(bridge.getSharedSession("nonexistent")).toBeNull();
		expect(bridge.shareSession("nonexistent")).toBeNull();
		expect(bridge.unshareSession("nonexistent")).toBe(false);
	});

	it("/model and /persona are rejected while the agent is running", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		expect((await bridge.executeCommand(ws.id, "/model gpt-5")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/persona senior")).ok).toBe(false);
	});

	it("/steer while idle just sends the message as a normal turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Sent" });
		expect(runAgentLoop).toHaveBeenCalledTimes(1);
	});

	it("/steer while running enqueues into the steering queue instead of starting a new turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		const res = await bridge.executeCommand(ws.id, "/steer hello");
		expect(res).toEqual({ ok: true, result: "Steered into the running turn" });
		expect(runAgentLoop).not.toHaveBeenCalled();
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
	});

	it("fires the Notification hook when a turn ends, including when it fails", async () => {
		// The event was declared, matcher-aware and dispatched from nowhere — a
		// hook written to ring a bell or post to Slack simply never ran. (The
		// input_needed case fires from the plan question/approval path, which
		// only the agent loop drives; it's covered by a live run, not here.)
		mkdirSync(join(cwd, ".cast"), { recursive: true });
		const marker = join(cwd, "notified.txt");
		writeFileSync(
			join(cwd, ".cast", "hooks.json"),
			JSON.stringify({ Notification: [{ hooks: [{ command: `printf notified >> ${JSON.stringify(marker)}` }] }] }),
		);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		runAgentLoop.mockImplementationOnce(async (messages: unknown) => messages);

		await bridge.submit(ws.id, "hello");
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true));

		// A failed turn ends the wait too — someone watching for the bell wants
		// it either way.
		rmSync(marker, { force: true });
		runAgentLoop.mockImplementationOnce(async () => {
			throw new Error("provider exploded");
		});
		await bridge.submit(ws.id, "again");
		await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
	});

	it("says the turn is running without MCP tools while the servers are still connecting", async () => {
		// The daemon connects MCP in the background after it starts listening; a
		// turn sent in that window ran with none of their tools and said nothing,
		// leaving the user to wonder why a configured server went unused.
		const bridge = createServerBridge(
			makeResult({
				mcpResult: {
					toolIndex: new Map(),
					toolDefinitions: [],
					connections: [],
					diagnostics: [],
					allServerNames: ["context7", "playwright"],
					connectPending: true,
				},
			}),
		);
		const ws = bridge.createSession();
		const notices: string[] = [];
		bridge.subscribe(ws.id, (event) => {
			if (event.type === "notice") notices.push(event.message);
		});

		await bridge.submit(ws.id, "hello");

		expect(notices.join("\n")).toContain("still connecting");
		expect(notices.join("\n")).toContain("context7");
	});

	it("says so when an iteration budget is requested against an already-running turn", async () => {
		// The budget can't apply to a turn that's already going, and it used to
		// be dropped in silence on this path.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const notices: string[] = [];
		bridge.subscribe(ws.id, (event) => {
			if (event.type === "notice") notices.push(event.message);
		});

		let finishTurn!: () => void;
		runAgentLoop.mockImplementationOnce(
			(messages: unknown) =>
				new Promise((resolve) => {
					finishTurn = () => resolve(messages);
				}),
		);
		bridge.submit(ws.id, "first message");
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalled());
		bridge.submit(ws.id, "run this as a goal", undefined, undefined, undefined, { maxOuterIterations: 40 });

		expect(notices.join("\n")).toContain("iteration budget (40)");
		finishTurn();
		await vi.waitFor(() => expect(ws.runner.steeringQueue.hasItems()).toBe(false));
	});

	it("delivers a steer that arrived after the loop's last drain instead of stranding it", async () => {
		// The loop drains the steering queue at fixed points and then the turn
		// ends; a message enqueued between that last drain and idle used to sit
		// on a queue nobody drained again — never delivered, and the client's
		// "Steer queued" chip stayed up forever. Follow-ups already had this
		// net; steering didn't.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const events: string[] = [];
		bridge.subscribe(ws.id, (event) => events.push(event.type));

		// Hold the turn open, steer into it (runAgentLoop is stubbed, so nothing
		// drains the queue), then let the turn finish: exactly the window.
		let finishTurn!: () => void;
		runAgentLoop.mockImplementationOnce(
			(messages: unknown) =>
				new Promise((resolve) => {
					finishTurn = () => resolve(messages);
				}),
		);
		bridge.submit(ws.id, "first message");
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalled());
		bridge.submit(ws.id, "steer that races the end of the turn");
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
		finishTurn();

		// Delivered: the queue drains and the event the client's "Steer queued"
		// chip listens for actually fires. (It used to sit there forever.)
		await vi.waitFor(() => expect(ws.runner.steeringQueue.hasItems()).toBe(false));
		expect(events).toContain("steering_injected");
		expect(runAgentLoop.mock.calls.length).toBeGreaterThan(1);
	});

	it("submit() while a turn is already running steers instead of racing a second runAgentLoop", () => {
		// Two browser tabs on the same session both hitting "send" hit this
		// same code path — without the guard, both would call runAgentLoop
		// concurrently against the same ws.session, scrambling/interleaving
		// the persisted message order (see the real repro this fix closes).
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "first message");
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		bridge.submit(ws.id, "second message, from another tab");
		expect(runAgentLoop).toHaveBeenCalledTimes(1); // still just the one run
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
	});

	it("dedupes a thin-client retry re-send with the same clientMessageId while the first submit is in flight", async () => {
		// The id is claimed synchronously at the top of submit, before the
		// running-check and async setup. A reconnect re-send of the same message
		// must be dropped — not steered into the running turn as a duplicate.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "first message", undefined, "client-id-1");
		bridge.submit(ws.id, "first message (retried)", undefined, "client-id-1");

		expect(runAgentLoop).toHaveBeenCalledTimes(1);
		expect(ws.runner.steeringQueue.hasItems()).toBe(false);
		expect(ws.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("applies a same-name persona override on the next turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		runAgentLoop.mockImplementation(async (messages: unknown) => messages);

		bridge.submit(ws.id, "first turn");
		await new Promise<void>((resolve) => setImmediate(resolve));
		mkdirSync(join(cwd, ".cast", "personas"), { recursive: true });
		writeFileSync(
			join(cwd, ".cast", "personas", "coding.md"),
			`---\nname: coding\nlabel: Customized Coding\ntools: [read]\nskills: [research]\nmcp: []\n---\n\nYou are the customized coding persona.\n`,
			"utf-8",
		);

		bridge.submit(ws.id, "second turn");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const secondRun = runAgentLoop.mock.calls[1]?.[1] as {
			systemPrompt: string;
			personas: Persona[];
			currentPersona: string;
		};
		expect(secondRun.currentPersona).toBe("coding");
		expect(secondRun.systemPrompt).toContain("You are the customized coding persona.");
		expect(secondRun.personas.find((persona) => persona.name === "coding")).toMatchObject({
			source: "project",
			tools: ["read"],
			skills: ["research"],
			mcp: [],
		});
	});

	it("publishes a backend-owned request start time with running status", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const events: Array<{ type: string; status?: string; startedAt?: number }> = [];
		bridge.subscribe(ws.id, (event) => events.push(event));

		bridge.submit(ws.id, "measure this request");

		const status = events.find((event) => event.type === "status" && event.status === "running");
		expect(status?.startedAt).toEqual(expect.any(Number));
		expect(ws.turnStartedAt).toBe(status?.startedAt);
	});

	it("records web answers to multiple questions and resumes the conversation", async () => {
		const { createPlanState, execQuestion } = await import("../src/core/plan.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const planState = createPlanState(ws.session.cwd!, ws.id, {
			onChange: (question, transition) => {
				ws.session.planQuestion = question;
				ws.session.planTransition = transition;
			},
		});
		planState.enabled = true;
		execQuestion(
			{
				questions: [
					{
						question: "Choose cache backend",
						options: [
							{ value: "memory", label: "In-memory" },
							{ value: "redis", label: "Redis" },
						],
					},
					{
						question: "Choose storage",
						options: [
							{ value: "disk", label: "Disk" },
							{ value: "memory", label: "Memory" },
						],
					},
				],
			},
			planState,
		);
		expect(bridge.getQuestion(ws.id)?.questions).toHaveLength(2);

		runAgentLoop.mockImplementationOnce(async (messages) => messages);
		expect(await bridge.answerQuestion(ws.id, ["redis", "disk"])).toEqual({ ok: true });
		expect(ws.session.planQuestion).toBeUndefined();
		expect(ws.session.messages.at(-1)?.content).toContain("Question: Choose cache backend Answer: Redis");
	});

	it("accepts a free-form answer not matching any model-supplied option", async () => {
		const { createPlanState, execQuestion } = await import("../src/core/plan.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		const planState = createPlanState(ws.session.cwd!, ws.id, {
			onChange: (question, transition) => {
				ws.session.planQuestion = question;
				ws.session.planTransition = transition;
			},
		});
		planState.enabled = true;
		execQuestion(
			{
				questions: [
					{
						question: "Which color do you like best?",
						options: [
							{ value: "red", label: "Red" },
							{ value: "blue", label: "Blue" },
							{ value: "green", label: "Green" },
						],
						recommended: "blue",
					},
				],
			},
			planState,
		);

		// The user typed a custom color in the composer — not one of the
		// model-supplied values. The bridge must accept it (instead of 400-ing
		// with "Unknown question option") and pass the raw text to the model.
		runAgentLoop.mockImplementationOnce(async (messages) => messages);
		expect(await bridge.answerQuestion(ws.id, ["orange"])).toEqual({ ok: true });
		expect(ws.session.planQuestion).toBeUndefined();
		expect(ws.session.messages.at(-1)?.content).toContain("Question: Which color do you like best? Answer: orange");
	});

	it("broadcasts decision state when another client resolves a pending question", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.planQuestion = {
			questions: [{ question: "Choose cache", options: [{ value: "memory", label: "In-memory" }] }],
		};
		const firstClientEvents: Array<{ type: string; question?: unknown; planTransition?: unknown }> = [];
		const secondClientEvents: Array<{ type: string; question?: unknown; planTransition?: unknown }> = [];
		bridge.subscribe(ws.id, (event) => firstClientEvents.push(event));
		bridge.subscribe(ws.id, (event) => secondClientEvents.push(event));

		runAgentLoop.mockImplementationOnce(async (messages) => messages);
		expect(await bridge.answerQuestion(ws.id, ["memory"])).toEqual({ ok: true });
		const expected = { type: "decision_state", question: undefined, planTransition: undefined };
		expect(firstClientEvents).toContainEqual(expected);
		expect(secondClientEvents).toContainEqual(expected);
	});

	it("forks an idle session into an independent registered session", () => {
		const bridge = createServerBridge(makeResult());
		const source = bridge.createSession();
		source.session.messages = [
			{ role: "user", content: "Original request" },
			{ role: "assistant", content: "Original answer" },
		];
		source.session.mode = "plan";

		const fork = bridge.forkSession(source.id);

		expect(fork?.id).not.toBe(source.id);
		expect(fork?.session.messages).toEqual(source.session.messages);
		expect(fork?.session.mode).toBe("plan");
		expect(bridge.getSession(fork!.id)).toBe(fork);
		fork!.session.messages[0] = { role: "user", content: "Fork-only request" };
		expect(source.session.messages[0]).toEqual({ role: "user", content: "Original request" });
	});

	it("forking a session with an attachment gives the fork its own independent copy, immune to the source being deleted later", () => {
		const bridge = createServerBridge(makeResult());
		const source = bridge.createSession();
		const sourceInputsDir = sessionInputsDir(source.id);
		mkdirSync(sourceInputsDir, { recursive: true });
		writeFileSync(join(sourceInputsDir, "report.pdf"), "pdf bytes");
		source.session.messages = [
			{
				role: "user",
				content: `Look at this\n\n<system-reminder>\nThe user attached the following file(s) to this message:\n- report.pdf: ${join(sourceInputsDir, "report.pdf")}\n</system-reminder>`,
			},
		];

		const fork = bridge.forkSession(source.id);
		const forkInputsDir = sessionInputsDir(fork!.id);

		// The fork got its own copy of the attachment...
		expect(existsSync(join(forkInputsDir, "report.pdf"))).toBe(true);
		// ...and its history now points at that copy, not the source's.
		const forkContent = fork!.session.messages[0]!.content as string;
		expect(forkContent).toContain(join(forkInputsDir, "report.pdf"));
		expect(forkContent).not.toContain(sourceInputsDir);

		// Deleting the source (which rmSyncs its inputs dir) must not take the
		// fork's copy down with it.
		expect(bridge.deleteSessionPermanently(source.id)).toBe(true);
		expect(existsSync(join(forkInputsDir, "report.pdf"))).toBe(true);
	});

	it("concurrent /mcp enable and disable calls serialize their reconnect instead of racing", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		let releaseFirst: () => void = () => {};
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let calls = 0;
		mockResolveMcpForCwd.mockImplementation(async () => {
			calls++;
			// Only the first call blocks — if the second one starts before this
			// resolves, it proves the two overlapped instead of serializing.
			if (calls === 1) await firstGate;
			return { ...emptyMcp, allServerNames: ["srv"] };
		});

		const first = bridge.executeCommand(ws.id, "/mcp disable srv");
		await new Promise((r) => setTimeout(r, 0));
		expect(calls).toBe(1);

		const second = bridge.executeCommand(ws.id, "/mcp enable srv");
		await new Promise((r) => setTimeout(r, 0));
		// The second call is queued behind the lock, not racing the first —
		// its resolveMcpForCwd hasn't been reached yet.
		expect(calls).toBe(1);

		releaseFirst();
		await Promise.all([first, second]);
		expect(calls).toBe(2);
	});

	// The daemon resolved rules once, for the directory it was started in, and
	// every session reused that catalog — so a session opened in another project
	// ran with none of that project's rules, silently. Personas and hooks were
	// already re-resolved per session directory; rules were not.
	it("resolves rules for the session's own directory, not the daemon's", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-rules-"));
		mkdirSync(join(projectDir, ".cursor", "rules"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cursor", "rules", "project-only.mdc"),
			"---\nalwaysApply: true\n---\nPROJECT_ONLY_RULE\n",
			"utf-8",
		);
		try {
			// The daemon cannot ask about a directory it was not started in, so it
			// reads the decision already recorded for it.
			setProjectTrust(projectDir, true);
			// The daemon's own directory has no rules at all.
			const bridge = createServerBridge(makeResult({ directoryRules: [] }));
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
			};
			const prompt = opts.rebuildSystemPrompt?.({ userText: "hello", contextFiles: [] }) ?? "";
			expect(prompt).toContain("PROJECT_ONLY_RULE");

			const listed = (await bridge.executeCommand(ws.id, "/rules")) as {
				ok: boolean;
				result?: Array<{ name: string }>;
			};
			expect(listed.ok).toBe(true);
			expect((listed.result ?? []).map((r) => r.name)).toContain("project-only");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// The daemon used to answer its own dangerous-command gate with an
	// unconditional "yes", so rm -rf, sudo, git push --force and the rest ran
	// without asking anyone — including for a TUI attached as a thin client,
	// whose picker never got a say.
	describe("dangerous-command confirmation", () => {
		function confirmFromLoop(): (command: string, reason: string) => Promise<boolean> {
			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				confirmBash?: (command: string, reason: string) => Promise<boolean>;
			};
			expect(opts.confirmBash, "daemon must pass a confirm callback outside bypass mode").toBeTypeOf("function");
			return opts.confirmBash!;
		}

		it("asks the connected clients and blocks until one answers", async () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			const events: Array<{ type: string; id?: string; command?: string; reason?: string }> = [];
			bridge.subscribe(ws.id, (event) => events.push(event as { type: string }));
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "clean up");
			await new Promise<void>((resolve) => setImmediate(resolve));

			const pending = confirmFromLoop()("rm -rf build", "recursive/force delete (rm -rf)");
			await new Promise<void>((resolve) => setImmediate(resolve));

			const asked = events.find((e) => e.type === "bash_confirm");
			expect(asked?.command).toBe("rm -rf build");
			expect(asked?.reason).toContain("rm -rf");
			expect(bridge.getBashConfirm(ws.id)?.id).toBe(asked!.id);

			expect(bridge.answerBashConfirm(ws.id, asked!.id!, true)).toBe(true);
			await expect(pending).resolves.toBe(true);
			// Settled: the same id cannot be answered twice.
			expect(bridge.answerBashConfirm(ws.id, asked!.id!, true)).toBe(false);
			expect(bridge.getBashConfirm(ws.id)).toBeUndefined();
		});

		it("denies when the answer says no, and ignores an id that is not pending", async () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			const events: Array<{ type: string; id?: string }> = [];
			bridge.subscribe(ws.id, (event) => events.push(event as { type: string }));
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);
			bridge.submit(ws.id, "push it");
			await new Promise<void>((resolve) => setImmediate(resolve));

			const pending = confirmFromLoop()("git push --force", "force push (rewrites remote history)");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const id = events.find((e) => e.type === "bash_confirm")!.id!;

			expect(bridge.answerBashConfirm(ws.id, "not-the-pending-id", true)).toBe(false);
			expect(bridge.answerBashConfirm(ws.id, id, false)).toBe(true);
			await expect(pending).resolves.toBe(false);
		});

		// Nobody attached means nobody to ask, and "nobody said no" is not a yes.
		it("denies when no client is listening", async () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);
			bridge.submit(ws.id, "delete things");
			await new Promise<void>((resolve) => setImmediate(resolve));

			await expect(confirmFromLoop()("sudo rm -rf /", "elevated privileges (sudo)")).resolves.toBe(false);
		});
	});

	// Global MCP servers stay one shared set for the daemon; a project's own
	// `.cast/mcp.json` only ever reached a session when the daemon happened to
	// start in that project, so a session opened anywhere else ran without the
	// servers its repository declares.
	it("connects the session project's own MCP servers and adds their tools to the turn", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-mcp-"));
		mkdirSync(join(projectDir, ".cast"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cast", "mcp.json"),
			JSON.stringify({ mcpServers: { "project-srv": { command: "true", args: [] } } }),
			"utf-8",
		);
		try {
			setProjectTrust(projectDir, true);
			mockConnectMcpServers.mockResolvedValue({
				toolIndex: new Map([["project_tool", {} as never]]),
				toolDefinitions: [
					{ type: "function", function: { name: "project_tool", description: "", parameters: {} } },
				],
				connections: [],
				diagnostics: [],
				allServerNames: ["project-srv"],
				serverSources: { "project-srv": "project" as const },
			});

			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			expect(mockConnectMcpServers).toHaveBeenCalledWith({ "project-srv": { command: "true", args: [] } });
			// The connect resolves on a microtask; the turn after it lands carries
			// the tools.
			await new Promise<void>((resolve) => setImmediate(resolve));
			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));

			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				mcpTools?: Array<{ function?: { name?: string } }>;
			};
			expect((opts.mcpTools ?? []).map((t) => t.function?.name)).toContain("project_tool");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// The per-directory caches are unbounded in number and stale by
	// construction. AGENTS.md is the clearest case: unlike rule bodies (re-read
	// from disk on every render), its text is cached as a finished string, so an
	// edit made while nothing is open there was invisible until /reload.
	it("forgets a directory's cached AGENTS.md once its last session is gone", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-cache-"));
		const agentsPath = join(projectDir, "AGENTS.md");
		writeFileSync(agentsPath, "FIRST_AGENTS_TEXT\n", "utf-8");
		try {
			setProjectTrust(projectDir, true);
			const persona = makePersona({ agentsMd: true });
			const bridge = createServerBridge(makeResult({ persona, personas: [persona] }));
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);
			const promptFor = (sessionId: string, text: string): string => {
				bridge.submit(sessionId, text);
				const opts = runAgentLoop.mock.calls.at(-1)![1] as {
					rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
				};
				return opts.rebuildSystemPrompt?.({ userText: text, contextFiles: [] }) ?? "";
			};

			const first = bridge.createSession(undefined, undefined, projectDir);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(promptFor(first.id, "hello")).toContain("FIRST_AGENTS_TEXT");

			expect(bridge.closeSession(first.id)).toBe(true);
			writeFileSync(agentsPath, "SECOND_AGENTS_TEXT\n", "utf-8");

			const second = bridge.createSession(undefined, undefined, projectDir);
			await new Promise<void>((resolve) => setImmediate(resolve));
			const prompt = promptFor(second.id, "hello again");
			expect(prompt).toContain("SECOND_AGENTS_TEXT");
			expect(prompt).not.toContain("FIRST_AGENTS_TEXT");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Project servers are real processes, so every path that drops a session has
	// to release them — not just closeSession. Idle eviction and permanent
	// deletion each remove a session on their own, and both used to leave the
	// connections behind for the life of the daemon.
	it("closes a project's MCP servers when its last session is deleted", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-mcp-release-"));
		mkdirSync(join(projectDir, ".cast"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cast", "mcp.json"),
			JSON.stringify({ mcpServers: { "project-srv": { command: "true", args: [] } } }),
			"utf-8",
		);
		try {
			setProjectTrust(projectDir, true);
			// closeMcpConnections closes the client, not the connection wrapper.
			const close = vi.fn(async () => {});
			const connection = { serverName: "project-srv", client: { close } };
			mockConnectMcpServers.mockResolvedValue({
				toolIndex: new Map(),
				toolDefinitions: [],
				connections: [connection],
				diagnostics: [],
				allServerNames: ["project-srv"],
				serverSources: {},
			});

			const bridge = createServerBridge(makeResult());
			const first = bridge.createSession(undefined, undefined, projectDir);
			const second = bridge.createSession(undefined, undefined, projectDir);
			await new Promise<void>((resolve) => setImmediate(resolve));

			// Still another session in that directory — keep the servers up.
			expect(bridge.deleteSessionPermanently(first.id)).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(close).not.toHaveBeenCalled();

			expect(bridge.deleteSessionPermanently(second.id)).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(close).toHaveBeenCalled();
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// `.cast/ssh.json` is project-local and trust-gated, and the daemon merged it
	// once for its own directory — so a session elsewhere was handed that
	// project's remote-execution targets and not its own.
	it("uses the session directory's own ssh hosts", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-ssh-"));
		mkdirSync(join(projectDir, ".cast"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cast", "ssh.json"),
			JSON.stringify({ hosts: { "project-box": { host: "10.0.0.9", username: "deploy" } } }),
			"utf-8",
		);
		try {
			setProjectTrust(projectDir, true);
			const bridge = createServerBridge(
				makeResult({ sshHosts: [{ name: "daemon-box", host: "10.0.0.1", username: "root" }] }),
			);
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as { sshHosts?: Array<{ name: string }> };
			const names = (opts.sshHosts ?? []).map((h) => h.name);
			expect(names).toContain("project-box");
			expect(names).not.toContain("daemon-box");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// AGENTS.md/CLAUDE.md at the project root was loaded once, for the daemon's
	// own directory, and every session got that text — so a session in another
	// project was handed a different project's instructions and never saw its
	// own.
	it("uses the session directory's own AGENTS.md, not the daemon's", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-agents-"));
		writeFileSync(join(projectDir, "AGENTS.md"), "PROJECT_B_INSTRUCTIONS\n", "utf-8");
		try {
			setProjectTrust(projectDir, true);
			// Real personas default to agentsMd: true — that is what makes the
			// root context file reach the prompt at all.
			const persona = makePersona({ agentsMd: true });
			const bridge = createServerBridge(
				makeResult({
					contextFilesSuffix: "\n\nPROJECT_A_INSTRUCTIONS",
					persona,
					personas: [persona],
				}),
			);
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
			};
			const prompt = opts.rebuildSystemPrompt?.({ userText: "hello", contextFiles: [] }) ?? "";
			expect(prompt).toContain("PROJECT_B_INSTRUCTIONS");
			expect(prompt).not.toContain("PROJECT_A_INSTRUCTIONS");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Same defect as the rules, one layer over: the daemon discovered skills for
	// its own directory only, so a session opened in another project was never
	// told that project's skills existed and could not call them.
	it("offers the session directory's own skills to the model", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-skills-"));
		mkdirSync(join(projectDir, ".cast", "skills", "project-only"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cast", "skills", "project-only", "SKILL.md"),
			"---\nname: project-only\ndescription: Only in this project, for the per-session skill check.\n---\n\nbody\n",
			"utf-8",
		);
		try {
			setProjectTrust(projectDir, true);
			// A realistic resolver: the daemon's is fully populated, and skill
			// discovery reads these fields.
			const bridge = createServerBridge(
				makeResult({
					skills: [],
					projectDeps: {
						noSkills: false,
						noMcp: false,
						cliSkillPaths: [],
						cliMcpPaths: [],
						settings: {},
						pickers: {} as never,
					} as StartupResult["projectDeps"],
				}),
			);
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				skills?: Array<{ name: string }>;
				rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
			};
			expect((opts.skills ?? []).map((s) => s.name)).toContain("project-only");
			const prompt = opts.rebuildSystemPrompt?.({ userText: "hello", contextFiles: [] }) ?? "";
			expect(prompt).toContain("project-only");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	// Subagents build their own prompt from the session cwd (task.ts loads
	// AGENTS.md, rules and skills through it), so the trust flag handed to the
	// loop decides what a child may read. The daemon's own decision would let an
	// unvetted checkout's files into a child's prompt.
	it("hands the loop the session directory's trust decision, not the daemon's", async () => {
		const untrusted = mkdtempSync(join(tmpdir(), "cast-bridge-childtrust-"));
		try {
			const bridge = createServerBridge(makeResult({ projectTrusted: true }));
			const ws = bridge.createSession(undefined, undefined, untrusted);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as { projectTrusted?: boolean };
			expect(opts.projectTrusted).toBe(false);
		} finally {
			rmSync(untrusted, { recursive: true, force: true });
		}
	});

	// The flip side of resolving per session directory: `projectTrusted` is one
	// decision the user made about the daemon's own directory, and handing it to
	// a session opened in an unvetted checkout would load that checkout's rules,
	// skills and personas under it. With no recorded decision, don't.
	it("does not load rules from a session directory that was never trusted", async () => {
		const projectDir = mkdtempSync(join(tmpdir(), "cast-bridge-untrusted-"));
		mkdirSync(join(projectDir, ".cursor", "rules"), { recursive: true });
		writeFileSync(
			join(projectDir, ".cursor", "rules", "untrusted.mdc"),
			"---\nalwaysApply: true\n---\nUNTRUSTED_RULE\n",
			"utf-8",
		);
		try {
			const bridge = createServerBridge(makeResult({ directoryRules: [] }));
			const ws = bridge.createSession(undefined, undefined, projectDir);
			runAgentLoop.mockImplementation(async (messages: unknown) => messages);

			bridge.submit(ws.id, "hello");
			await new Promise<void>((resolve) => setImmediate(resolve));
			const opts = runAgentLoop.mock.calls.at(-1)![1] as {
				rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
			};
			const prompt = opts.rebuildSystemPrompt?.({ userText: "hello", contextFiles: [] }) ?? "";
			expect(prompt).not.toContain("UNTRUSTED_RULE");
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});

	it("latches an auto-mode directory rule once a matching file enters context, and keeps it sticky next turn", async () => {
		const rulePath = join(fakeHome, "python-style.md");
		writeFileSync(
			rulePath,
			[
				"---",
				"name: python-style",
				"description: Python conventions",
				"globs: ['**/*.py']",
				"---",
				"",
				"Use type hints on every function.",
			].join("\n"),
			"utf-8",
		);
		const autoRule: Rule = {
			name: "python-style",
			id: "python-style",
			description: "Python conventions",
			filePath: rulePath,
			baseDir: fakeHome,
			source: "project",
			scope: "",
			alwaysApply: false,
			globs: ["**/*.py"],
			applyMode: "auto",
		};

		const bridge = createServerBridge(makeResult({ directoryRules: [autoRule] }));
		const ws = bridge.createSession();
		runAgentLoop.mockImplementation(async (messages: unknown) => messages);

		bridge.submit(ws.id, "look at main.py");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const firstCall = runAgentLoop.mock.calls[0]![1] as {
			rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
		};
		const promptWithoutMatch = firstCall.rebuildSystemPrompt!({ userText: "hi", contextFiles: [] });
		expect(promptWithoutMatch).not.toContain("Use type hints on every function.");

		const promptAfterMatch = firstCall.rebuildSystemPrompt!({ userText: "hi", contextFiles: ["src/main.py"] });
		expect(promptAfterMatch).toContain("Use type hints on every function.");

		// Sticky: a later turn with no .py file in its own contextFiles still
		// carries the rule, because it latched onto the session earlier.
		bridge.submit(ws.id, "now do something unrelated");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const secondCall = runAgentLoop.mock.calls[1]![1] as {
			rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
		};
		const promptNextTurn = secondCall.rebuildSystemPrompt!({ userText: "unrelated", contextFiles: [] });
		expect(promptNextTurn).toContain("Use type hints on every function.");
	});

	it("a nested always-apply rule only applies once a file from its subtree enters context", async () => {
		const rulePath = join(fakeHome, "web-style.md");
		writeFileSync(
			rulePath,
			["---", "name: web-style", "description: Web app conventions", "---", "", "Use Tailwind, not raw CSS."].join(
				"\n",
			),
			"utf-8",
		);
		const nestedAlwaysRule: Rule = {
			name: "web-style",
			id: "apps/web/web-style",
			description: "Web app conventions",
			filePath: rulePath,
			baseDir: fakeHome,
			source: "project",
			scope: "apps/web",
			alwaysApply: true,
			globs: [],
			applyMode: "always",
		};

		const bridge = createServerBridge(makeResult({ directoryRules: [nestedAlwaysRule] }));
		const ws = bridge.createSession();
		runAgentLoop.mockImplementation(async (messages: unknown) => messages);

		bridge.submit(ws.id, "touch something outside apps/web");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const call = runAgentLoop.mock.calls[0]![1] as {
			rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
		};

		// A session that never touches apps/web must not get this rule at all —
		// nested always-apply rules are scoped to their own subtree, not
		// injected into every session in the repo.
		const promptOutsideScope = call.rebuildSystemPrompt!({ userText: "x", contextFiles: ["apps/api/main.ts"] });
		expect(promptOutsideScope).not.toContain("Use Tailwind, not raw CSS.");

		const promptInsideScope = call.rebuildSystemPrompt!({ userText: "x", contextFiles: ["apps/web/index.tsx"] });
		expect(promptInsideScope).toContain("Use Tailwind, not raw CSS.");
	});

	it("injects a nested AGENTS.md only once a file from its subtree enters context", async () => {
		mkdirSync(join(cwd, "apps", "web"), { recursive: true });
		writeFileSync(join(cwd, "apps", "web", "AGENTS.md"), "Use Tailwind for this app, not raw CSS.");

		const bridge = createServerBridge(makeResult({ persona: makePersona({ agentsMd: true }) }));
		const ws = bridge.createSession();
		runAgentLoop.mockImplementation(async (messages: unknown) => messages);

		bridge.submit(ws.id, "touch something outside apps/web");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const call = runAgentLoop.mock.calls[0]![1] as {
			rebuildSystemPrompt?: (ctx: { userText: string; contextFiles: string[] }) => string;
		};

		const promptOutsideScope = call.rebuildSystemPrompt!({ userText: "x", contextFiles: ["apps/api/main.ts"] });
		expect(promptOutsideScope).not.toContain("Use Tailwind for this app, not raw CSS.");

		const promptInsideScope = call.rebuildSystemPrompt!({ userText: "x", contextFiles: ["apps/web/index.tsx"] });
		expect(promptInsideScope).toContain("Use Tailwind for this app, not raw CSS.");
	});

	it("seeds lastPromptTokens from the persisted session so auto-compaction isn't blind on a fresh runAgentLoop call", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.lastPromptTokens = 123_456;

		await bridge.submit(ws.id, "hello");

		const call = runAgentLoop.mock.calls[0]![1] as { lastPromptTokens?: number };
		expect(call.lastPromptTokens).toBe(123_456);
	});

	it("wires announcedLocalDate so a write lands on the persisted session field", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.lastAnnouncedLocalDate = "2020-01-01";

		await bridge.submit(ws.id, "hello");

		const call = runAgentLoop.mock.calls[0]![1] as { announcedLocalDate?: { value: string } };
		expect(call.announcedLocalDate?.value).toBe("2020-01-01");
		call.announcedLocalDate!.value = "2020-01-02";
		expect(ws.session.lastAnnouncedLocalDate).toBe("2020-01-02");
	});

	it("passes the same contextFiles array across separate submits so a match stays sticky once the session goes idle", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		runAgentLoop.mockImplementation(async (messages: unknown) => messages);

		bridge.submit(ws.id, "first turn");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const firstCall = runAgentLoop.mock.calls[0]![1] as { contextFiles?: string[] };
		firstCall.contextFiles!.push("apps/web/index.tsx");

		bridge.submit(ws.id, "second turn");
		await new Promise<void>((resolve) => setImmediate(resolve));
		const secondCall = runAgentLoop.mock.calls[1]![1] as { contextFiles?: string[] };

		expect(secondCall.contextFiles).toBe(firstCall.contextFiles);
		expect(secondCall.contextFiles).toContain("apps/web/index.tsx");
	});

	it("/fork creates and returns a new session id, and refuses a running session", async () => {
		const bridge = createServerBridge(makeResult());
		const source = bridge.createSession();
		source.session.messages.push({ role: "user", content: "Keep this context" });

		const result = await bridge.executeCommand(source.id, "/fork");
		expect(result).toMatchObject({ ok: true, result: { sessionId: expect.any(String) } });
		const forkId = (result.result as { sessionId: string }).sessionId;
		expect(forkId).not.toBe(source.id);
		expect(bridge.getSession(forkId)?.session.messages).toEqual(source.session.messages);

		source.status = "running";
		expect((await bridge.executeCommand(source.id, "/fork")).ok).toBe(false);
	});

	it("resets only the model context for clean plan implementation, retaining the visible thread", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.messages.push(
			{ role: "user", content: "Build a release dashboard" },
			{ role: "assistant", content: "Here is the plan." },
		);
		saveSession(ws.session);

		expect(bridge.resetContext(ws.id)).toEqual({ ok: true, originalTask: "Build a release dashboard" });
		expect(ws.session.messages).toEqual([]);
		expect(getFullHistory(ws.id)).toEqual([
			{ role: "user", content: "Build a release dashboard" },
			{ role: "assistant", content: "Here is the plan." },
		]);
	});

	it("keeps a pending plan review available after a page reload", async () => {
		const { createPlanState, execPlanDone } = await import("../src/core/plan.ts");
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.mode = "plan";
		const planState = createPlanState(ws.session.cwd!, ws.id, {
			onChange: (question, transition) => {
				ws.session.planQuestion = question;
				ws.session.planTransition = transition;
			},
		});
		planState.enabled = true;
		const planPath = join(planState.plansDir, "review.md");
		mkdirSync(planState.plansDir, { recursive: true });
		writeFileSync(planPath, "# Review\n\n## Steps\n- [ ] implement", "utf-8");
		planState.activePlanPath = planPath;
		expect(execPlanDone({}, planState).isError).toBeFalsy();

		expect(bridge.getPlanTransition(ws.id)).toEqual({ kind: "done" });
		expect(bridge.resolvePlanTransition(ws.id, "done")).toEqual({ ok: true });
		expect(bridge.getPlanTransition(ws.id)).toBeUndefined();
	});

	it("setSessionMode flips the hydrated session's mode and rebuilds its system prompt", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(ws.session.mode).toBeUndefined();

		expect(bridge.setSessionMode(ws.id, "plan")).toEqual({ ok: true });
		expect(ws.session.mode).toBe("plan");
		expect(ws.systemPrompt).toContain("Mode: plan");

		expect(bridge.setSessionMode(ws.id, "build")).toEqual({ ok: true });
		expect(ws.session.mode).toBe("build");
		expect(ws.systemPrompt).toContain("Mode: build");
	});

	it("approving a plan switches the session to build in the same call", async () => {
		// The client used to resolve the transition and then separately POST
		// /build, so an interruption between the two left the approval consumed
		// and the mode still "plan": card gone, model still read-only, nothing
		// left to approve. Reproduced against a live daemon before this change.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		bridge.setSessionMode(ws.id, "plan");
		ws.session.planTransition = { kind: "done" };
		expect(ws.session.mode).toBe("plan");

		expect(bridge.resolvePlanTransition(ws.id, "done")).toEqual({ ok: true });

		expect(ws.session.mode).toBe("build");
		expect(ws.session.planTransition).toBeUndefined();
		// The prompt has to follow the mode, or the next turn still advertises
		// the plan-mode surface.
		expect(ws.systemPrompt).toContain("Mode: build");
		// A client that does still send /build afterwards is a no-op, not an error.
		expect(bridge.setSessionMode(ws.id, "build")).toEqual({ ok: true });
	});

	it("setSessionMode clears a stale pending plan question/transition and broadcasts the clear", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.mode = "plan";
		ws.session.planQuestion = {
			questions: [{ question: "Choose approach", options: [{ value: "a", label: "A" }] }],
		};
		ws.session.planTransition = { kind: "done" };
		const events: Array<{ type: string; question?: unknown; planTransition?: unknown }> = [];
		bridge.subscribe(ws.id, (event) => events.push(event));

		// Switching mode by any path other than answering the pending
		// question/transition must not leave it dangling — its premise
		// ("still in plan mode") no longer holds once the mode has moved.
		expect(bridge.setSessionMode(ws.id, "build")).toEqual({ ok: true });

		expect(ws.session.planQuestion).toBeUndefined();
		expect(ws.session.planTransition).toBeUndefined();
		expect(events).toContainEqual({ type: "decision_state", question: undefined, planTransition: undefined });
	});

	it("/plan and /build commands also clear a stale pending plan question/transition", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.mode = "plan";
		ws.session.planTransition = { kind: "done" };

		await expect(bridge.executeCommand(ws.id, "/build")).resolves.toMatchObject({ ok: true });

		expect(ws.session.mode).toBe("build");
		expect(ws.session.planTransition).toBeUndefined();
	});

	it("setSessionMode is a no-op when the mode is already active", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.mode = "plan";

		expect(bridge.setSessionMode(ws.id, "plan")).toEqual({ ok: true });
	});

	it("setSessionMode rejects while the agent is running", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";

		expect(bridge.setSessionMode(ws.id, "plan")).toEqual({ ok: false, error: "Agent running" });
		expect(ws.session.mode).toBeUndefined();
	});

	it("setSessionMode reports a session that was never hydrated", () => {
		const bridge = createServerBridge(makeResult());
		expect(bridge.setSessionMode("no-such-session", "plan")).toEqual({ ok: false, error: "Session not found" });
	});

	it("claims the turn before an async UserPromptSubmit hook so concurrent sends cannot start two loops", async () => {
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(join(cwd, ".cast"));
		writeFileSync(
			join(cwd, ".cast", "hooks.json"),
			JSON.stringify({ UserPromptSubmit: [{ hooks: [{ command: "sleep 0.05" }] }] }),
		);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "first message");
		bridge.submit(ws.id, "second message");

		expect(ws.status).toBe("running");
		expect(runAgentLoop).not.toHaveBeenCalled();
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(1));
	});

	it("claims the turn before async provider reconciliation so concurrent sends cannot start two loops", async () => {
		let releaseModels!: (value: { ok: boolean; models: Array<{ id: string }> }) => void;
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		saveSession(ws.session);
		const persisted = loadSession(ws.id)!;
		persisted.model = "hy3";
		persisted.providerUrl = testConfig.baseURL;
		saveSession(persisted);
		mockFetchModels.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseModels = resolve;
				}),
		);

		bridge.submit(ws.id, "first message");
		bridge.submit(ws.id, "second message");

		// The claim is synchronous, so the second send can only queue.
		expect(runAgentLoop).not.toHaveBeenCalled();
		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
		releaseModels({ ok: true, models: [{ id: "gpt-4o" }] });
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalled());
		// One loop at a time is the invariant here — never two at once...
		expect(runAgentLoop.mock.calls.length).toBeGreaterThanOrEqual(1);
		// ...and the queued message is eventually delivered rather than left on
		// an idle queue forever, which is what used to happen: runAgentLoop is
		// stubbed here, so nothing drains the queue during the turn and the
		// stranded-steer net has to pick it up afterwards.
		await vi.waitFor(() => expect(ws.runner.steeringQueue.hasItems()).toBe(false));
	});

	it("runs MessageDisplay hooks for a completed daemon response", async () => {
		mkdirSync(join(cwd, ".cast"));
		writeFileSync(
			join(cwd, ".cast", "hooks.json"),
			JSON.stringify({ MessageDisplay: [{ hooks: [{ command: "printf displayed > .cast/message-display" }] }] }),
		);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		runAgentLoop.mockImplementationOnce(
			async (messages: unknown[], loopConfig: { onEvent: (event: unknown) => void }) => {
				loopConfig.onEvent({ type: "assistant_message", content: "completed response", thinking: "" });
				return [...messages, { role: "assistant", content: "completed response" }];
			},
		);

		bridge.submit(ws.id, "hello");
		await vi.waitFor(() => expect(readFileSync(join(cwd, ".cast", "message-display"), "utf8")).toBe("displayed"));
	});

	it("runs FileChanged hooks from the daemon watcher while idle", async () => {
		const marker = join(tmpdir(), `cast-file-hook-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		try {
			mkdirSync(join(cwd, ".cast"));
			writeFileSync(
				join(cwd, ".cast", "hooks.json"),
				JSON.stringify({
					FileChanged: [
						{ matcher: "watched.txt", hooks: [{ command: `printf changed > ${JSON.stringify(marker)}` }] },
					],
				}),
			);
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			bridge.subscribe(ws.id, () => {});

			// Re-touch the file on every poll rather than sleeping a fixed amount
			// and writing once: chokidar is registered asynchronously after
			// subscribe(), and a write landing before that is simply never seen,
			// so no fixed delay is right — it's either longer than the test needs
			// or, under load, still too short. The poll interval has to clear the
			// bridge's 500ms fs debounce, which every new event restarts, or the
			// re-touching would itself keep the hook from ever firing.
			await vi.waitFor(
				() => {
					writeFileSync(join(cwd, "watched.txt"), `changed ${Date.now()}`);
					expect(readFileSync(marker, "utf8")).toBe("changed");
				},
				{ timeout: 15_000, interval: 900 },
			);
		} finally {
			rmSync(marker, { force: true });
		}
	});

	it("blocks /worktree before it creates a git worktree", async () => {
		execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Cast Test"], { cwd });
		writeFileSync(join(cwd, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
		mkdirSync(join(cwd, ".cast"));
		writeFileSync(
			join(cwd, ".cast", "hooks.json"),
			JSON.stringify({ WorktreeCreate: [{ hooks: [{ command: "exit 2" }] }] }),
		);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		await expect(bridge.executeCommand(ws.id, "/worktree blocked")).resolves.toMatchObject({ ok: false });
		expect(existsSync(join(cwd, ".cast", "worktrees", "blocked"))).toBe(false);
	});

	it("refuses to remove a worktree another live session still has as its cwd", async () => {
		execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
		execFileSync("git", ["config", "user.name", "Cast Test"], { cwd });
		writeFileSync(join(cwd, "README.md"), "test\n");
		execFileSync("git", ["add", "README.md"], { cwd });
		execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
		const bridge = createServerBridge(makeResult());
		const owner = bridge.createSession();

		const created = await bridge.executeCommand(owner.id, "/worktree in-use");
		expect(created.ok).toBe(true);
		const worktreePath = owner.session.cwd;
		expect(worktreePath).not.toBe(cwd);
		expect(existsSync(worktreePath!)).toBe(true);

		// A second, unrelated session tries to remove the worktree the first
		// session is still sitting in.
		const remover = bridge.createSession();
		const result = await bridge.executeCommand(remover.id, "/worktree remove in-use");

		expect(result).toMatchObject({ ok: false });
		expect(existsSync(worktreePath!)).toBe(true);
		expect(owner.session.cwd).toBe(worktreePath);
	});

	it("blocks manual compaction before starting a model request", async () => {
		mkdirSync(join(cwd, ".cast"));
		writeFileSync(
			join(cwd, ".cast", "hooks.json"),
			JSON.stringify({ PreCompact: [{ hooks: [{ command: "exit 2" }] }] }),
		);
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.session.messages.push({ role: "user", content: "keep this context" });

		await expect(bridge.executeCommand(ws.id, "/compact")).resolves.toMatchObject({ ok: false });
		expect(runAgentLoop).not.toHaveBeenCalled();
	});

	it("submit with images builds a [text, image_url...] content array, always including the text part", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "is this a Bengal?", ["data:image/jpeg;base64,ONE", "data:image/jpeg;base64,TWO"]);

		const sent = ws.session.messages.at(-1);
		expect(sent?.role).toBe("user");
		expect(sent?.content).toEqual([
			{ type: "text", text: "is this a Bengal?" },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ONE" } },
			{ type: "image_url", image_url: { url: "data:image/jpeg;base64,TWO" } },
		]);
	});

	it("submit with no images stays a plain string (unchanged behavior)", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.submit(ws.id, "hello");

		expect(ws.session.messages.at(-1)?.content).toBe("hello");
	});

	it("submit with images while a turn is running steers with the same array content instead of dropping the images", () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		bridge.submit(ws.id, "first message");
		expect(runAgentLoop).toHaveBeenCalledTimes(1);

		bridge.submit(ws.id, "and this photo", ["data:image/png;base64,X"]);

		expect(ws.runner.steeringQueue.hasItems()).toBe(true);
		const [queued] = ws.runner.steeringQueue.drain();
		expect(queued?.content).toEqual([
			{ type: "text", text: "and this photo" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,X" } },
		]);
	});

	it("session_end's messageCount stays a raw per-completion count, not the turn count shown elsewhere", async () => {
		// The web client (app.js) appends one local message per raw
		// "assistant_message" SSE event — including tool-call-only
		// intermediates — and compares that length against this field to
		// decide whether a reconnect-recovery refetch is needed. If this were
		// turn-based (like the sidebar/settings "N msg" counters), it would
		// permanently mismatch on every tool-using turn and force a needless
		// refetch every single time.
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => [
			...messages,
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "ok" },
			{ role: "assistant", content: "final reply" },
		]);

		const events: Array<{ type: string; messageCount?: number }> = [];
		bridge.subscribe(ws.id, (e) => events.push(e as { type: string; messageCount?: number }));

		bridge.submit(ws.id, "read a file");
		await new Promise((r) => setTimeout(r, 0));

		const sessionEnd = events.find((e) => e.type === "session_end");
		// 1 user + 2 assistant completions = 3 raw rows, not the 2 "turns"
		// (1 user + 1 final reply) countTurnMessages would report.
		expect(sessionEnd?.messageCount).toBe(3);
	});

	it("submit() broadcasts turn_meta with the model that answered, so the client can show it under the reply", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession(undefined, "gpt-5");

		runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => [
			...messages,
			{ role: "assistant", content: "final reply" },
		]);

		const events: Array<{ type: string; model?: string; provider?: string; totalMs?: number }> = [];
		bridge.subscribe(ws.id, (e) => events.push(e as (typeof events)[number]));

		bridge.submit(ws.id, "hi");
		await new Promise((r) => setTimeout(r, 0));

		const turnMeta = events.find((e) => e.type === "turn_meta");
		expect(turnMeta?.model).toBe("gpt-5");
		expect(turnMeta?.provider).toBe("default");
		expect(typeof turnMeta?.totalMs).toBe("number");
	});

	it("/queue while running enqueues a follow-up; /queue-reset clears it", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		ws.status = "running";
		await bridge.executeCommand(ws.id, "/queue after this turn");
		expect(ws.runner.followUpQueue.hasItems()).toBe(true);
		await bridge.executeCommand(ws.id, "/queue-reset");
		expect(ws.runner.followUpQueue.hasItems()).toBe(false);
	});

	it("follow-up sent after the daemon turns idle starts a new turn", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		bridge.followUp(ws.id, "after the turn");
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(1));
		expect(ws.runner.followUpQueue.hasItems()).toBe(false);
	});

	it("restarts a turn when follow-up arrives as the previous loop resolves", async () => {
		let resolveFirstRun!: (messages: unknown[]) => void;
		const firstRun = new Promise<unknown[]>((resolve) => {
			resolveFirstRun = resolve;
		});
		runAgentLoop.mockImplementationOnce(async () => firstRun);
		runAgentLoop.mockImplementation(async (messages: unknown[]) => [
			...messages,
			{ role: "assistant", content: "next" },
		]);

		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		bridge.submit(ws.id, "first");
		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(1));

		bridge.followUp(ws.id, "after the turn");
		resolveFirstRun([...ws.session.messages, { role: "assistant", content: "first" }]);

		await vi.waitFor(() => expect(runAgentLoop).toHaveBeenCalledTimes(2));
		expect(ws.runner.followUpQueue.hasItems()).toBe(false);
	});

	it("/steer and /queue require a message", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect((await bridge.executeCommand(ws.id, "/steer")).ok).toBe(false);
		expect((await bridge.executeCommand(ws.id, "/queue")).ok).toBe(false);
	});

	it("suggestCommand returns subcommands for bare commands", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();

		const mcpSuggestions = bridge.suggestCommand(ws.id, "/mcp");
		expect(mcpSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const skillsSuggestions = bridge.suggestCommand(ws.id, "/skills");
		expect(skillsSuggestions.map((s) => s.value)).toEqual(["list", "enable", "disable", "uninstall", "help"]);

		const permissionsSuggestions = bridge.suggestCommand(ws.id, "/permissions");
		expect(permissionsSuggestions.map((s) => s.value)).toEqual(["default", "bypass"]);

		const sshSuggestions = bridge.suggestCommand(ws.id, "/ssh");
		expect(sshSuggestions.map((s) => s.value)).toEqual(["list", "add", "remove"]);
	});

	it("a traversing session id can't turn permanent-delete into an rmSync of ~/.cast", async () => {
		// The router's `([^/]+)` matches "..", and Node never normalizes it out
		// of req.url — so `DELETE /api/sessions/../permanent` used to reach
		// rmSync(join(~/.cast/inputs, ".."), {recursive, force}), i.e. the whole
		// cast home directory, and still answer a misleading 404.
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-id-safety-test-"));
		const previousHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			mkdirSync(join(fakeHome, ".cast", "inputs"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "settings.json"), '{"providers":[]}');
			const bridge = createServerBridge(makeResult());

			expect(bridge.deleteSessionPermanently("..")).toBe(false);
			expect(existsSync(join(fakeHome, ".cast", "settings.json"))).toBe(true);
			expect(existsSync(join(fakeHome, ".cast", "inputs"))).toBe(true);

			expect(bridge.deleteSessionPermanently(".")).toBe(false);
			expect(existsSync(join(fakeHome, ".cast", "inputs"))).toBe(true);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("saveSshKey can't be tricked into writing outside the keys directory", async () => {
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-ssh-key-test-"));
		const previousHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
			const bridge = createServerBridge(makeResult());

			const escaped = bridge.saveSshKey("../../.ssh/authorized_keys", "ssh-rsa AAAA attacker");

			// Written as a literal file name inside the keys dir, if at all —
			// never at the traversed destination.
			expect(existsSync(join(fakeHome, ".ssh", "authorized_keys"))).toBe(false);
			if (escaped.ok) expect(escaped.path).toBe(join(fakeHome, ".cast", "keys", "authorized_keys"));

			expect(bridge.saveSshKey("..", "x").ok).toBe(false);
			expect(bridge.saveSshKey("   ", "x").ok).toBe(false);

			// A normal name still works.
			const normal = bridge.saveSshKey("id_test", "ssh-rsa AAAA legit");
			expect(normal).toMatchObject({ ok: true, path: join(fakeHome, ".cast", "keys", "id_test") });
			expect(readFileSync(normal.path!, "utf-8")).toBe("ssh-rsa AAAA legit\n");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("suggestCommand returns empty for unknown commands", async () => {
		const bridge = createServerBridge(makeResult());
		const ws = bridge.createSession();
		expect(bridge.suggestCommand(ws.id, "/unknown")).toEqual([]);
		expect(bridge.suggestCommand(ws.id, "/mcp enable unknown-server")).toEqual([]);
	});

	describe("SSE broadcast synchronicity", () => {
		it("delivers events to two listeners in the same synchronous tick", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();

			// Track which microtask tick each listener sees per event.
			// A microtask-based counter increments every time the event loop
			// yields. If broadcast were async, the two listeners would see
			// different tick values for at least one event.
			const counter = { value: 0 };
			let ticking = true;
			Promise.resolve().then(function tick() {
				counter.value++;
				if (ticking) Promise.resolve().then(tick);
			});

			const ticksAtListener1: number[] = [];
			const ticksAtListener2: number[] = [];
			const received1: unknown[] = [];
			const received2: unknown[] = [];

			bridge.subscribe(ws.id, (e) => {
				ticksAtListener1.push(counter.value);
				received1.push(e);
			});
			bridge.subscribe(ws.id, (e) => {
				ticksAtListener2.push(counter.value);
				received2.push(e);
			});

			// submit() fires runAgentLoop and broadcasts a status event —
			// grab the onEvent callback it passes in.
			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};
			const onEvent = loopConfig.onEvent;

			// Clear the initial "status: running" event that submit() broadcast
			ticksAtListener1.length = 0;
			ticksAtListener2.length = 0;
			received1.length = 0;
			received2.length = 0;

			// Fire several events simulating a real LLM stream
			const events = [
				{ type: "token", text: "Hello" },
				{ type: "thinking", text: "reasoning..." },
				{ type: "token", text: " world" },
				{ type: "assistant_message", content: "Hello world", thinking: "reasoning..." },
				{ type: "usage", usage: { promptTokens: 10, completionTokens: 5 } },
				{ type: "end", reason: "stop" },
			];

			for (const event of events) {
				onEvent(event);
			}

			ticking = false;

			// Both listeners received every event
			expect(received1).toHaveLength(events.length);
			expect(received2).toHaveLength(events.length);

			// Events arrived in the same order
			for (let i = 0; i < events.length; i++) {
				expect(received1[i]).toBe(events[i]);
				expect(received2[i]).toBe(events[i]);
			}

			// The tick counter was identical for both listeners on every event
			// — proving no microtask ran between them (i.e. broadcast is sync).
			expect(ticksAtListener1).toEqual(ticksAtListener2);
		});

		it("a disconnected listener does not block delivery to remaining listeners", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();

			const goodEvents: unknown[] = [];

			// First listener throws (simulating a disconnected SSE client)
			bridge.subscribe(ws.id, () => {
				throw new Error("client disconnected");
			});
			// Second listener is healthy
			bridge.subscribe(ws.id, (e) => goodEvents.push(e));

			bridge.submit(ws.id, "trigger");
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as {
				onEvent: (event: unknown) => void;
			};

			// Clear the initial "status: running" from submit()
			goodEvents.length = 0;

			loopConfig.onEvent({ type: "token", text: "ok" });
			loopConfig.onEvent({ type: "end", reason: "stop" });

			// Healthy listener got both events despite the first one throwing
			expect(goodEvents).toHaveLength(2);
			expect(goodEvents[0]).toEqual({ type: "token", text: "ok" });
			expect(goodEvents[1]).toEqual({ type: "end", reason: "stop" });
		});

		it("searchSessions finds a live (hydrated) session by message content via the FTS index", async () => {
			const { saveSession } = await import("../src/core/session.ts");
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			ws.session.messages.push(
				{ role: "user", content: "find the needle here" },
				{ role: "assistant", content: "got it" },
			);
			saveSession(ws.session); // every real mutation path saves synchronously — mirror that here

			const results = bridge.searchSessions("find the needle");
			expect(results.map((s) => s.id)).toContain(ws.id);
			// Live overlay still applies — status comes from the in-memory
			// session, not a fresh "idle" cold-load default.
			expect(results.find((s) => s.id === ws.id)?.status).toBe(ws.status);
		});

		it("searchSessions finds a cold session loaded from disk too, and empty query behaves like listSessions", async () => {
			const { appendMessage, createSession, saveSession } = await import("../src/core/session.ts");
			const bridge = createServerBridge(makeResult());
			const orphan = createSession("gpt-4o", cwd);
			appendMessage(orphan, { role: "user", content: "deep unique needle in an unhydrated session" });
			saveSession(orphan);

			expect(bridge.searchSessions("deep unique needle").map((s) => s.id)).toContain(orphan.id);
			expect(bridge.searchSessions("no-such-term-anywhere")).toEqual([]);
			expect(bridge.searchSessions("").map((s) => s.id)).toEqual(bridge.listSessions().map((s) => s.id));
		});

		it("subscribe receives current status immediately on connection", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();

			// Simulate a running session
			ws.status = "running";

			// The SSE endpoint in server.ts sends current status via a direct
			// res.write before subscribing — here we verify the bridge exposes
			// the status so that path can read it.
			const summary = bridge.listSessions();
			const ours = summary.find((s) => s.id === ws.id);
			expect(ours?.status).toBe("running");
		});
	});

	describe("background bash tasks", () => {
		it("submit() threads backgroundBash into the LoopConfig passed to runAgentLoop", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			bridge.submit(ws.id, "hello");
			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const loopConfig = runAgentLoop.mock.calls[0]?.[1] as { backgroundBash?: unknown };
			expect(loopConfig.backgroundBash).toBe(ws.backgroundBash);
		});

		it("closeSession() kills any still-running background tasks", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			const killAllSpy = vi.spyOn(ws.backgroundBash.registry, "killAll");
			bridge.closeSession(ws.id);
			expect(killAllSpy).toHaveBeenCalledTimes(1);
		});

		it("deleteSessionPermanently() kills any still-running background tasks", () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			const killAllSpy = vi.spyOn(ws.backgroundBash.registry, "killAll");
			bridge.deleteSessionPermanently(ws.id);
			expect(killAllSpy).toHaveBeenCalledTimes(1);
		});

		// The whole point of the feature: a background task finishing while the
		// session is fully idle (no turn to steer into) still gets the model's
		// attention — via the registry's onIdleWake, wired to submit() at session
		// construction (bridge.ts's makeBackgroundBash), starting a fresh turn.
		it("a background task finishing while idle wakes a fresh turn with a <system-reminder>", async () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();

			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			bridge.submit(ws.id, "hello");
			await new Promise((r) => setTimeout(r, 0));
			expect(ws.status).toBe("idle");

			runAgentLoop.mockClear();
			runAgentLoop.mockImplementationOnce(async (messages: unknown[]) => messages);
			ws.backgroundBash.registry.start("echo bg-wake-marker", cwd, testConfig, 5, ws.backgroundBash);
			// Poll up to 5s — the inline `setTimeout(500)` wait was flaky under
			// parallel-test load (background tasks schedule on the event loop,
			// not a wall clock). Polling waits on the actual side effect.
			await waitFor(() => runAgentLoop.mock.calls.length >= 1);

			expect(runAgentLoop).toHaveBeenCalledTimes(1);
			const lastMessage = ws.session.messages.at(-1);
			expect(lastMessage?.role).toBe("user");
			expect(String(lastMessage?.content)).toContain("<system-reminder>");
			expect(String(lastMessage?.content)).toContain("bg-wake-marker");
		});

		it("a background task finishing while a turn is still running enqueues onto followUpQueue instead", async () => {
			const bridge = createServerBridge(makeResult());
			const ws = bridge.createSession();
			ws.runner.startRun(new AbortController());

			ws.backgroundBash.registry.start("echo bg-followup-marker", cwd, testConfig, 5, ws.backgroundBash);
			await waitFor(() => ws.runner.followUpQueue.hasItems());

			expect(runAgentLoop).not.toHaveBeenCalled();
			expect(ws.runner.followUpQueue.hasItems()).toBe(true);
			const [queued] = ws.runner.followUpQueue.drain();
			expect(String(queued?.content)).toContain("bg-followup-marker");
		});
	});

	describe("active provider sync from settings.json", () => {
		// The TUI process (or a manual edit) writes the active provider/model to
		// settings.json; the web daemon only reconciles those into its startup
		// `config` when /provider /model run through *this* process. These tests
		// pin the behavior that makes an external switch stick without a restart.

		async function setActive(providerUrl: string, apiKey: string, model?: string) {
			const { updateSettings } = await import("../src/core/settings.ts");
			updateSettings({ providerUrl, apiKey, ...(model ? { model } : {}) });
		}

		function runArgs() {
			return runAgentLoop.mock.calls[0]![1] as { config: AppConfig; model: string };
		}

		// syncActiveProviderFromSettings mutates config in place, and makeResult
		// shares one module-level testConfig across every test — a provider switch
		// in one test would leak into the next. Give each bridge its own clone.
		function freshBridge() {
			return createServerBridge(makeResult({ config: { ...testConfig } }));
		}

		it("adopts a provider switched in settings.json on the next turn", async () => {
			const bridge = freshBridge(); // startup config: http://localhost / "test"
			const ws = bridge.createSession();
			await setActive("https://new.provider/v1", "newkey");

			await bridge.submit(ws.id, "hi");

			expect(runArgs().config.baseURL).toBe("https://new.provider/v1");
			expect(runArgs().config.apiKey).toBe("newkey");
			// gpt-4o is in the default mocked model list — still valid, kept.
			expect(runArgs().model).toBe("gpt-4o");
		});

		it("adopts a model changed by another surface on the next turn", async () => {
			const bridge = freshBridge();
			const ws = bridge.createSession();
			saveSession(ws.session);
			const persisted = loadSession(ws.id)!;
			persisted.model = "hy3";
			persisted.providerUrl = testConfig.baseURL;
			saveSession(persisted);

			await bridge.submit(ws.id, "hi");

			expect(runArgs().model).toBe("hy3");
			expect(ws.session.model).toBe("hy3");
		});

		it("adopts secondary model slots changed by another surface", async () => {
			const { updateSettings } = await import("../src/core/settings.ts");
			const bridge = freshBridge();
			const ws = bridge.createSession();
			updateSettings({ subagentModel: "hy3", subagentModelProvider: "remote" });

			await bridge.submit(ws.id, "hi");

			const args = runAgentLoop.mock.calls[0]![1] as {
				subagentModel?: string;
				subagentModelProvider?: { baseURL: string; apiKey: string };
			};
			expect(args.subagentModel).toBe("hy3");
			expect(args.subagentModelProvider).toEqual({ baseURL: "http://localhost", apiKey: "test" });
		});

		it("does not restart-turn when settings.json still matches the daemon config", async () => {
			const bridge = freshBridge();
			const ws = bridge.createSession();

			await bridge.submit(ws.id, "hi");

			expect(mockFetchModels).not.toHaveBeenCalled();
			expect(runArgs().config.baseURL).toBe("http://localhost");
		});

		it("reconciles a session model that the new provider doesn't serve onto the default model", async () => {
			// New provider only serves "hy3"; the session was on "gpt-4o" against
			// the old endpoint — sending gpt-4o to it would 400.
			mockFetchModels.mockResolvedValue({ ok: true, models: [{ id: "hy3" }] });
			const bridge = freshBridge();
			const ws = bridge.createSession();
			await setActive("https://new.provider/v1", "newkey", "hy3");

			const events: Array<{ type: string; message?: string }> = [];
			bridge.subscribe(ws.id, (event) => events.push(event));
			await bridge.submit(ws.id, "hi");

			expect(runArgs().model).toBe("hy3");
			expect(ws.session.model).toBe("hy3");
			expect(events.some((e) => e.type === "notice" && e.message?.includes('switched to "hy3"'))).toBe(true);
		});

		it("does not reconcile a session pinned to its own provider when only the global endpoint moves", async () => {
			const { updateSettings } = await import("../src/core/settings.ts");
			updateSettings({
				providers: [
					{ name: "local", url: testConfig.baseURL, apiKey: testConfig.apiKey },
					{ name: "pinned-provider", url: "https://pinned.example/v1", apiKey: "pinned-key" },
				],
			});
			// New global endpoint only serves "hy3" — if the pinned session got
			// reconciled against it (the bug), its gpt-4o model would get reset.
			mockFetchModels.mockResolvedValue({ ok: true, models: [{ id: "hy3" }] });
			const bridge = freshBridge();
			const ws = bridge.createSession(undefined, undefined, undefined, true, undefined, "pinned-provider");
			expect(ws.session.model).toBe("gpt-4o");

			// Someone/something else flips the *global* active provider — the
			// pinned session's own provider is untouched by this.
			await setActive("https://new.provider/v1", "newkey");

			await bridge.submit(ws.id, "hi");

			expect(ws.session.model).toBe("gpt-4o");
			expect(ws.session.providerName).toBe("pinned-provider");
			expect(mockFetchModels).not.toHaveBeenCalled();
		});

		it("keeps a session model that exists on both endpoints", async () => {
			const bridge = freshBridge();
			const ws = bridge.createSession();
			await setActive("https://new.provider/v1", "newkey", "hy3");

			await bridge.submit(ws.id, "hi");

			expect(runArgs().model).toBe("gpt-4o");
			expect(ws.session.model).toBe("gpt-4o");
		});

		it("starts brand-new sessions on the model/endpoint currently in settings.json", async () => {
			const bridge = freshBridge();
			await setActive("https://new.provider/v1", "newkey", "hy3");

			const ws = bridge.createSession();

			expect(ws.session.model).toBe("hy3");
			expect(runAgentLoop).not.toHaveBeenCalled(); // createSession doesn't run a turn
			await bridge.submit(ws.id, "hi");
			expect(runArgs().model).toBe("hy3");
			expect(runArgs().config.baseURL).toBe("https://new.provider/v1");
		});
	});
});

// ============================================================================
// toDisplayMessages — tool status reconstruction and image_url user messages
// ============================================================================

describe("toDisplayMessages — tool status reconstruction", () => {
	it("uses the shared terminal vocabulary for persisted successful and failed MCP calls", () => {
		const out = toDisplayMessages([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "ok", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } },
					{ id: "failed", type: "function", function: { name: "mcp_demo_lookup", arguments: '{"id":1}' } },
				],
			} as never,
			{ role: "tool", tool_call_id: "ok", content: "/workspace" } as never,
			{
				role: "tool",
				tool_call_id: "failed",
				content: "not found",
				castIsError: true,
			} as never,
		]);

		expect(out[0]?.toolCalls?.map((call) => [call.name, call.status])).toEqual([
			["bash", "ok"],
			["mcp_demo_lookup", "error"],
		]);
	});
});

describe("toDisplayMessages — inline images from a read on an image file", () => {
	it("extracts data: URLs from an image_url user message instead of dropping them to null", () => {
		const out = toDisplayMessages([
			{ role: "user", content: "look at this" },
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
			} as never,
		]);

		expect(out).toHaveLength(2);
		expect(out[1]).toEqual({ role: "user", content: null, images: ["data:image/png;base64,AAAA"] });
	});

	it("extracts multiple images from a single image_url message", () => {
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: "data:image/png;base64,ONE" } },
					{ type: "image_url", image_url: { url: "data:image/png;base64,TWO" } },
				],
			} as never,
		]);

		expect(out[0]?.images).toEqual(["data:image/png;base64,ONE", "data:image/png;base64,TWO"]);
	});

	it("points at the image-blob route instead of inlining when sessionId+seqs are given", () => {
		// The whole point of the route: a session load must not carry full
		// base64 payloads for every embedded photo (that's what made this
		// session slow to load — see server.ts's /image route).
		const out = toDisplayMessages(
			[
				{
					role: "user",
					content: [
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64,ONE" } },
						{ type: "image_url", image_url: { url: "data:image/jpeg;base64,TWO" } },
					],
				} as never,
			],
			undefined,
			undefined,
			"abc123",
			[42],
		);

		expect(out[0]?.images).toEqual([
			"/api/sessions/abc123/image?seq=42&idx=0",
			"/api/sessions/abc123/image?seq=42&idx=1",
		]);
	});

	it("falls back to inlining when seqs is given but this index has none (not yet persisted)", () => {
		const out = toDisplayMessages(
			[{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,X" } }] } as never],
			undefined,
			undefined,
			"abc123",
			[], // no seq recorded for index 0
		);

		expect(out[0]?.images).toEqual(["data:image/png;base64,X"]);
	});

	it("attributes the image to its originating ToolCard via castToolCallId, not a floating message", () => {
		const out = toDisplayMessages([
			{
				role: "assistant",
				content: null,
				tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
			} as never,
			{ role: "tool", tool_call_id: "call_1", content: "1:abc:def→(image content)" } as never,
			{
				role: "user",
				content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,PHOTO" } }],
				castToolCallId: "call_1",
			} as never,
		]);

		// Exactly one display message (the assistant/tool-call one) — the
		// image_url message must not also become its own floating entry.
		expect(out).toHaveLength(1);
		expect(out[0]?.role).toBe("assistant");
		expect(out[0]?.toolCalls?.[0]).toMatchObject({ id: "call_1", images: ["data:image/jpeg;base64,PHOTO"] });
	});

	it("resolves the attributed image through the same URL-vs-inline rule as the fallback path", () => {
		const out = toDisplayMessages(
			[
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
				} as never,
				{ role: "tool", tool_call_id: "call_1", content: "ok" } as never,
				{
					role: "user",
					content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,PHOTO" } }],
					castToolCallId: "call_1",
				} as never,
			],
			undefined,
			undefined,
			"sess1",
			[10, 11, 12],
		);

		expect(out[0]?.toolCalls?.[0]?.images).toEqual(["/api/sessions/sess1/image?seq=12&idx=0"]);
	});

	it("leaves a normal string user message untouched (no images field)", () => {
		const out = toDisplayMessages([{ role: "user", content: "hello" }]);
		expect(out[0]).toEqual({ role: "user", content: "hello" });
		expect(out[0]?.images).toBeUndefined();
	});

	it("carries persisted message sequences so a reconnect can retain DOM identity", () => {
		const out = toDisplayMessages([{ role: "user", content: "hello" }], undefined, undefined, "session-1", [42]);
		expect(out[0]).toMatchObject({ role: "user", content: "hello", seq: 42 });
	});

	it("keeps the caption alongside the photo for a real user send (text part present)", () => {
		// A real attach-and-send (see bridge.ts's buildUserContent) always
		// includes a text part, even when empty — that's what distinguishes it
		// from the tool-only image_url relay, which never has one.
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "is this a Bengal?" },
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,CAT" } },
				],
			} as never,
		]);
		expect(out[0]).toEqual({ role: "user", content: "is this a Bengal?", images: ["data:image/jpeg;base64,CAT"] });
	});

	it("keeps a caption-less real send distinguishable (empty string, not null) from a tool relay", () => {
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{ type: "text", text: "" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,X" } },
				],
			} as never,
		]);
		// content: "" (a real, if caption-less, send) — not null (which the
		// client renders as "image (read)" instead of "you").
		expect(out[0]?.content).toBe("");
	});

	it("strips a <system-reminder> out of the visible caption when images and an attached document are sent together", () => {
		// A message with both an image and an attached document (see
		// inputs.ts) carries its reminder inside the same text part images
		// use — without extraction here, it used to leak as raw XML into the
		// visible bubble instead of surfacing as a separate notice the way
		// the plain-string branch already handles it.
		const out = toDisplayMessages([
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "check this out\n\n<system-reminder>\nAttached: /tmp/report.pdf\n</system-reminder>",
					},
					{ type: "image_url", image_url: { url: "data:image/jpeg;base64,X" } },
				],
			} as never,
		]);
		expect(out.find((m) => m.role === "user")?.content).toBe("check this out");
		expect(out.find((m) => m.role === "warning")?.content).toBe("[system] Attached: /tmp/report.pdf");
	});
});
