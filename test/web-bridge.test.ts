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
			await new Promise((r) => setTimeout(r, 500));

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
			await new Promise((r) => setTimeout(r, 500));

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
