import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import type { SessionState } from "../src/core/session.ts";
import type { PermissionMode } from "../src/core/settings.ts";
import type { Pickers } from "../src/pickers/types.ts";
import type { CommandDeps } from "../src/ui/commands.ts";
import type { UseAgentSession } from "../src/ui/useAgentSession.ts";

vi.mock("../src/core/config.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/core/config.ts")>();
	return { ...mod, probeProvider: vi.fn().mockResolvedValue("ok") };
});

const { handleInput } = await import("../src/ui/commands.ts");

// Every handler that persists (saveSession in /clear and /new, updateSettings
// in /plan-model, readActivePlan in /build) resolves through homedir(), which
// honors $HOME — fake it for the whole file so `npm test` never writes into
// the real ~/.cast (it used to leave a session dir behind on every run).
let realHome: string | undefined;
beforeEach(() => {
	realHome = process.env.HOME;
	process.env.HOME = join(tmpdir(), `cast-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => {
	if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
	process.env.HOME = realHome;
});

interface Calls {
	[key: string]: unknown[][];
}

function createFakeDeps(overrides?: Partial<CommandDeps> & { running?: boolean }): {
	deps: CommandDeps;
	calls: Calls;
} {
	const calls: Calls = {};
	const track =
		(name: string) =>
		(...args: unknown[]) => {
			if (!calls[name]) calls[name] = [];
			calls[name].push(args);
		};

	const agent = {
		submit: track("agent.submit"),
		steer: track("agent.steer"),
		followUp: track("agent.followUp"),
		abort: track("agent.abort"),
		clearContext: track("agent.clearContext"),
		resetQueue: track("agent.resetQueue"),
		refresh: track("agent.refresh"),
		addDisplayMessage: track("agent.addDisplayMessage"),
		messages: [],
		streaming: null,
		status: "idle" as const,
		error: null,
		retry: null,
		usage: null,
	} as unknown as UseAgentSession;

	const session = {
		id: "test-session",
		messages: [],
		model: "test-model",
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		usage: {
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			cost: 0.001,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
		cwd: "/tmp",
	} as unknown as SessionState;

	const fakePickers: Pickers = {
		pickOption: async () => null,
		promptText: async () => null,
		pickMulti: async () => null,
		log: () => {},
	};

	const deps: CommandDeps = {
		agent,
		session,
		config: {
			baseURL: "https://test.example/v1",
			apiKey: "sk-test",
			contextWindow: 128_000,
			maxResponseTokens: 8192,
			defaultBashTimeout: 120,
			compactionThreshold: 0.8,
			reasoningLevel: "off",
			reasoningParams: { body: {}, enabled: false },
		} as AppConfig,
		running: overrides?.running ?? false,
		onQuit: track("onQuit"),
		showNotice: track("showNotice"),
		cwd: "/tmp",
		setCwd: track("setCwd"),
		currentPersona: {
			name: "default",
			label: "Default",
			description: "test persona",
			systemPrompt: "you are a test",
			source: "builtin",
		} as Persona,
		setCurrentPersona: track("setCurrentPersona"),
		skills: [],
		setSkills: track("setSkills"),
		skillsPromptSuffix: "",
		setSkillsPromptSuffix: track("setSkillsPromptSuffix"),
		contextFilesSuffix: "",
		setContextFilesSuffix: track("setContextFilesSuffix"),
		rulesSuffix: "",
		setRulesSuffix: track("setRulesSuffix"),
		rulesLazySuffix: "",
		setRulesLazySuffix: track("setRulesLazySuffix"),
		directoryRules: [],
		setDirectoryRules: track("setDirectoryRules"),
		systemPrompt: "",
		setSystemPrompt: track("setSystemPrompt"),
		mcpResult: {
			connections: [],
			toolDefinitions: [],
			toolIndex: new Map(),
			diagnostics: [],
			allServerNames: [],
		} as unknown as McpSetupResult,
		setMcpResult: track("setMcpResult"),
		permissionMode: "default" as PermissionMode,
		setPermissionMode: track("setPermissionMode"),
		projectTrusted: true,
		setProjectTrusted: track("setProjectTrusted"),
		projectDeps: {
			noSkills: false,
			noMcp: false,
			cliSkillPaths: [],
			cliMcpPaths: [],
			settings: {},
			pickers: fakePickers,
		},
		pickers: fakePickers,
		reasoningMeta: undefined,
		subagentModel: undefined,
		setSubagentModel: track("setSubagentModel"),
		webToolsEnabled: true,
		setWebToolsEnabled: track("setWebToolsEnabled"),
		planMode: false,
		setPlanMode: track("setPlanMode"),
		planModel: undefined,
		setPlanModel: track("setPlanModel"),
		setReasoningMeta: track("setReasoningMeta"),
		personaOptions: {},
		setPersonaOptions: track("setPersonaOptions"),
		sshHosts: overrides?.sshHosts ?? [],
		setSshHosts: track("setSshHosts"),
		...overrides,
	};

	return { deps, calls };
}

function noticeText(calls: Calls): string {
	return String(calls.showNotice?.[0]?.[0] ?? "");
}

function displayMessageText(calls: Calls, index = 1): string {
	const arg = calls["agent.addDisplayMessage"]?.[index]?.[0] as { role?: string; content?: string } | undefined;
	return String(arg?.content ?? "");
}

describe("handleInput", () => {
	it("routes non-slash input to agent.submit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("hello world", undefined, deps);
		expect(calls["agent.submit"]).toEqual([["hello world", undefined]]);
	});

	it("/quit calls onQuit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/quit", undefined, deps);
		expect(calls.onQuit).toHaveLength(1);
	});

	it("/exit calls onQuit", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/exit", undefined, deps);
		expect(calls.onQuit).toHaveLength(1);
	});

	it("/abort calls agent.abort", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/abort", undefined, deps);
		expect(calls["agent.abort"]).toHaveLength(1);
	});

	it("/steer <msg> enqueues steering message", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/steer fix the bug", undefined, deps);
		expect(calls["agent.steer"]).toEqual([["fix the bug"]]);
	});

	it("/queue <msg> enqueues follow-up", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/queue next step", undefined, deps);
		expect(calls["agent.followUp"]).toEqual([["next step"]]);
	});

	it("/s <msg> is an alias for /steer", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/s fix the bug", undefined, deps);
		expect(calls["agent.steer"]).toEqual([["fix the bug"]]);
	});

	it("/q <msg> is an alias for /queue", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/q next step", undefined, deps);
		expect(calls["agent.followUp"]).toEqual([["next step"]]);
	});

	it("blocks most commands while running", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/clear", undefined, deps);
		expect(calls["agent.clearContext"]).toBeUndefined();
		expect(noticeText(calls)).toContain("running");
	});

	it("/clear calls agent.clearContext when idle", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/clear", undefined, deps);
		expect(calls["agent.clearContext"]).toHaveLength(1);
		expect(noticeText(calls)).toContain("cleared");
	});

	it("/help lists command names", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/help", undefined, deps);
		expect(displayMessageText(calls)).toContain("/clear");
		expect(displayMessageText(calls)).toContain("/model");
		expect(displayMessageText(calls)).toContain("/quit");
	});

	it("/persona cancelled (Escape) leaves the persona unchanged and doesn't exit the process", async () => {
		// Regression test: selectPersona used to call process.exit(0) when the
		// picker was cancelled — fine during onboarding (nothing to preserve
		// yet), but this same function is reused for the mid-session /persona
		// command, where that would silently kill the whole running app instead
		// of just leaving the current persona in place. fakePickers.pickOption
		// always resolves null, simulating Escape.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit should not be called on a cancelled /persona");
		});
		try {
			const { deps, calls } = createFakeDeps();
			await handleInput("/persona", undefined, deps);
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("Cancelled");
			expect(calls.setCurrentPersona).toBeUndefined();
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("/model cancelled (Escape) leaves the model unchanged and doesn't exit the process", async () => {
		// Same underlying bug as /persona above, but for selectModel — reached
		// via /model, and also (unfixed until now) via /provider after a
		// successful credential change.
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit should not be called on a cancelled /model");
		});
		try {
			const { deps, calls } = createFakeDeps();
			await handleInput("/model", undefined, deps);
			const lastNotice = String(calls.showNotice?.at(-1)?.[0] ?? "");
			expect(lastNotice).toContain("Cancelled");
			expect(deps.session.model).toBe("test-model");
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("/skills reports none loaded when empty", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/skills", undefined, deps);
		expect(displayMessageText(calls)).toContain("No skills");
	});

	it("/mcp reports none connected when empty", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/mcp", undefined, deps);
		expect(displayMessageText(calls)).toContain("No MCP");
	});

	it("/mcp toggle persists disabled servers and updates mcpResult", async () => {
		const { deps, calls } = createFakeDeps();
		// Populate mcpResult with server names
		(deps.mcpResult as any).allServerNames = ["context7", "github"];
		(deps.mcpResult as any).connections = [
			{ serverName: "context7", toolCount: 5, client: { close: async () => {} } },
		];
		// Override pickers: pickMulti returns only context7 enabled (github disabled)
		deps.pickers = {
			pickOption: async () => null,
			promptText: async () => null,
			pickMulti: async () => ["context7"],
			log: () => {},
		};
		await handleInput("/mcp", undefined, deps);
		expect(displayMessageText(calls)).toContain("disabled 1");
		expect(calls.setMcpResult).toHaveLength(1);
	});

	it("unknown /command submits to agent as text (e.g. file paths)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/notreal", undefined, deps);
		expect(calls["agent.submit"]).toEqual([["/notreal"]]);
	});

	it("/steer without a message shows usage and does not enqueue", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/steer", undefined, deps);
		expect(calls["agent.steer"]).toBeUndefined();
		expect(noticeText(calls)).toContain("Usage");
	});

	it("/steer while idle sends the message as a normal prompt", async () => {
		const { deps, calls } = createFakeDeps({ running: false });
		await handleInput("/steer do the thing", undefined, deps);
		expect(calls["agent.steer"]).toBeUndefined();
		expect(calls["agent.submit"]).toEqual([["do the thing", undefined]]);
	});

	it("/queue without a message shows usage and does not enqueue or submit", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/queue", undefined, deps);
		expect(calls["agent.followUp"]).toBeUndefined();
		expect(calls["agent.submit"]).toBeUndefined();
		expect(noticeText(calls)).toContain("Usage");
	});

	it("/queue while idle runs the message immediately instead of queueing", async () => {
		const { deps, calls } = createFakeDeps({ running: false });
		await handleInput("/queue next step", undefined, deps);
		expect(calls["agent.followUp"]).toBeUndefined();
		expect(calls["agent.submit"]).toEqual([["next step", undefined]]);
	});

	it("/queue-reset calls resetQueue when idle", async () => {
		const { deps, calls } = createFakeDeps({ running: false });
		await handleInput("/queue-reset", undefined, deps);
		expect(calls["agent.resetQueue"]).toHaveLength(1);
		expect(noticeText(calls)).toContain("Queue cleared");
	});

	it("/queue-reset calls resetQueue when running (not blocked by the running guard)", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/queue-reset", undefined, deps);
		expect(calls["agent.resetQueue"]).toHaveLength(1);
		expect(noticeText(calls)).toContain("Queue cleared");
	});

	it("/qr is an alias for /queue-reset", async () => {
		const { deps, calls } = createFakeDeps({ running: true });
		await handleInput("/qr", undefined, deps);
		expect(calls["agent.resetQueue"]).toHaveLength(1);
		expect(noticeText(calls)).toContain("Queue cleared");
	});

	it("empty input does nothing (no submit)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("   ", undefined, deps);
		expect(calls["agent.submit"]).toBeUndefined();
		expect(calls.showNotice).toBeUndefined();
	});

	it("/usage shows token counts and cost", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/usage", undefined, deps);
		const notice = noticeText(calls);
		expect(notice).toContain("100 in");
		expect(notice).toContain("50 out");
		expect(notice).toContain("$0.00");
	});

	it("/usage shows subagent tokens when present", async () => {
		const { deps, calls } = createFakeDeps();
		(deps.session.usage as any).subagentTokens = 3500;
		await handleInput("/usage", undefined, deps);
		const notice = noticeText(calls);
		expect(notice).toContain("3.5k sub");
	});

	it("/usage shows cache hit percentage", async () => {
		const { deps, calls } = createFakeDeps();
		(deps.session.usage as any).cacheReadTokens = 80;
		(deps.session.usage as any).promptTokens = 100;
		await handleInput("/usage", undefined, deps);
		const notice = noticeText(calls);
		expect(notice).toContain("80% cache hit");
	});

	it("/usage reports no usage when totalTokens is 0", async () => {
		const { deps, calls } = createFakeDeps();
		deps.session.usage.totalTokens = 0;
		await handleInput("/usage", undefined, deps);
		expect(noticeText(calls)).toContain("No usage");
	});

	it("/permissions bypass with default current prompts confirmation (declined)", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/permissions bypass", undefined, deps);
		expect(calls.setPermissionMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Cancelled");
	});

	it("/permissions default applies without warning", async () => {
		const { deps, calls } = createFakeDeps({ permissionMode: "bypass" });
		await handleInput("/permissions default", undefined, deps);
		expect(calls.setPermissionMode).toEqual([["default"]]);
	});
});

describe("SLASH_COMMANDS", () => {
	it("is sorted alphabetically by name (palette renders it verbatim)", async () => {
		const { SLASH_COMMANDS } = await import("../src/ui/commands.ts");
		const names = SLASH_COMMANDS.map((c) => c.name);
		expect(names).toEqual([...names].sort());
	});
});

describe("plan mode commands", () => {
	it("/plan enters plan mode", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/plan", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([true]);
		expect(noticeText(calls)).toContain("Plan mode: ON");
		// No MCP connected → no caveat noise.
		expect(noticeText(calls)).not.toContain("MCP");
	});

	it("/plan warns that connected MCP tools are not gated", async () => {
		const { deps, calls } = createFakeDeps();
		deps.mcpResult.toolDefinitions = [
			{ type: "function", function: { name: "mcp_db_write", parameters: { type: "object", properties: {} } } },
			{ type: "function", function: { name: "mcp_db_read", parameters: { type: "object", properties: {} } } },
		] as never;
		await handleInput("/plan", undefined, deps);
		expect(noticeText(calls)).toContain("2 MCP tools stay fully enabled");
	});

	it("/plan is a no-op when already in plan mode", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/plan", undefined, deps);
		expect(calls.setPlanMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Already in plan mode");
	});

	it("/plan and /build are rejected while the agent is running", async () => {
		for (const cmd of ["/plan", "/build"]) {
			const { deps, calls } = createFakeDeps({ running: true, planMode: cmd === "/build" });
			await handleInput(cmd, undefined, deps);
			expect(calls.setPlanMode, cmd).toBeUndefined();
			expect(noticeText(calls), cmd).toContain("Agent running");
		}
	});

	it("/build exits plan mode (no plan on disk: full-toolset notice)", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/build", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([false]);
		expect(noticeText(calls)).toContain("full toolset restored");
	});

	it("/build outside plan mode explains itself", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/build", undefined, deps);
		expect(calls.setPlanMode).toBeUndefined();
		expect(noticeText(calls)).toContain("Not in plan mode");
	});

	it("/new resets the mode to build", async () => {
		const { deps, calls } = createFakeDeps({ planMode: true });
		await handleInput("/new", undefined, deps);
		expect(calls.setPlanMode?.[0]).toEqual([false]);
	});

	it("/plan-model cancelled leaves the override unchanged", async () => {
		const { deps, calls } = createFakeDeps({ planModel: "expensive-model" });
		await handleInput("/plan-model", undefined, deps);
		expect(calls.setPlanModel).toBeUndefined();
		expect(noticeText(calls)).toContain("Cancelled");
	});

	it("/plan-model off clears the override so plan mode uses the main model", async () => {
		const { deps, calls } = createFakeDeps({ planModel: "expensive-model" });
		await handleInput("/plan-model off", undefined, deps);
		expect(calls.setPlanModel?.[0]).toEqual([undefined]);
		expect(noticeText(calls)).toContain("plan mode uses the main model");
	});
});

describe("/ssh", () => {
	it("/ssh with no hosts shows notice", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/ssh", undefined, deps);
		const msg = String(calls["agent.addDisplayMessage"]?.[1]?.[0]?.content ?? "");
		expect(msg).toContain("No SSH hosts");
	});

	it("/ssh lists configured hosts", async () => {
		const { deps, calls } = createFakeDeps({
			sshHosts: [{ name: "myserver", host: "1.2.3.4", username: "root", port: 22, keyPath: "~/.ssh/id_rsa" }],
		});
		await handleInput("/ssh", undefined, deps);
		const msg = String(calls["agent.addDisplayMessage"]?.[1]?.[0]?.content ?? "");
		expect(msg).toContain("myserver");
		expect(msg).toContain("root@1.2.3.4");
		expect(msg).toContain("key");
	});

	it("/ssh add cancelled at first prompt → no save", async () => {
		const { deps, calls } = createFakeDeps();
		await handleInput("/ssh add", undefined, deps);
		expect(noticeText(calls)).toContain("Cancelled");
		expect(calls.setSshHosts).toBeUndefined();
	});

	it("/ssh add full flow → hosts updated", async () => {
		// Create a fake key file in the temp $HOME so validation passes
		const { mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
		const sshDir = join(process.env.HOME!, ".ssh");
		mkdirSync(sshDir, { recursive: true });
		const keyPath = join(sshDir, "id_ed25519");
		writeFileSync(keyPath, "fake-key");
		chmodSync(keyPath, 0o600);

		let promptStep = 0;
		const promptResponses = ["myserver", "1.2.3.4", "root", "22"];
		let pickStep = 0;
		const pickResponses = ["key", keyPath, "default"];

		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async (_label, _def, _placeholder, _error) => {
				if (promptStep >= promptResponses.length) return keyPath;
				return promptResponses[promptStep++] ?? null;
			},
			pickOption: async () => pickResponses[pickStep++] ?? null,
			pickMulti: async () => null,
			log: () => {},
		};

		const { deps, calls } = createFakeDeps({ pickers } as never);
		await handleInput("/ssh add", undefined, deps);
		expect(calls.setSshHosts).toHaveLength(1);
		expect(noticeText(calls)).toContain("added");
	});

	it("/ssh remove with name removes host", async () => {
		const hosts = [{ name: "myserver", host: "1.2.3.4", username: "root" }];
		let pickStep = 0;
		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async () => null,
			pickOption: async () => {
				pickStep++;
				return pickStep === 1 ? true : null;
			},
			pickMulti: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ sshHosts: hosts, pickers } as never);
		await handleInput("/ssh remove myserver", undefined, deps);
		expect(calls.setSshHosts).toHaveLength(1);
		const updated = (calls.setSshHosts as never[][])[0]?.[0] as Array<{ name: string }>;
		expect(updated).toHaveLength(0);
		expect(noticeText(calls)).toContain("removed");
	});

	it("/ssh remove cancelled → no change", async () => {
		const hosts = [{ name: "myserver", host: "1.2.3.4" }];
		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async () => null,
			pickOption: async () => false,
			pickMulti: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ sshHosts: hosts, pickers } as never);
		await handleInput("/ssh remove myserver", undefined, deps);
		expect(calls.setSshHosts).toBeUndefined();
		expect(noticeText(calls)).toContain("Cancelled");
	});

	it("/ssh remove unknown name → error", async () => {
		const hosts = [{ name: "myserver", host: "1.2.3.4" }];
		const { deps, calls } = createFakeDeps({ sshHosts: hosts });
		await handleInput("/ssh remove nonexistent", undefined, deps);
		expect(noticeText(calls)).toContain("Unknown host");
	});
});

describe("/provider", () => {
	function writeSettings(data: Record<string, unknown>) {
		const dir = join(process.env.HOME!, ".cast");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), JSON.stringify(data));
	}

	it("/provider delete with no providers → notice", async () => {
		writeSettings({});
		const { deps, calls } = createFakeDeps();
		await handleInput("/provider delete", undefined, deps);
		expect(noticeText(calls)).toContain("No providers to delete");
	});

	it("/provider <unknown-name> → error", async () => {
		writeSettings({ providers: [{ name: "openrouter", url: "https://x", apiKey: "k" }] });
		const { deps, calls } = createFakeDeps();
		await handleInput("/provider nonexistent", undefined, deps);
		expect(noticeText(calls)).toContain("Unknown provider");
	});

	it("/provider with no providers → triggers add wizard", async () => {
		writeSettings({});
		// pickers return null → cancelled at first prompt
		const { deps, calls } = createFakeDeps();
		await handleInput("/provider", undefined, deps);
		const notice = noticeText(calls);
		expect(notice.includes("No providers") || notice.includes("Cancelled")).toBe(true);
	});

	it("/provider delete removes provider and switches active to fallback", async () => {
		writeSettings({
			providers: [
				{ name: "a", url: "https://a.example", apiKey: "key-a" },
				{ name: "b", url: "https://b.example", apiKey: "key-b" },
			],
			providerUrl: "https://a.example",
			apiKey: "key-a",
		});
		let pickStep = 0;
		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async () => null,
			pickOption: async () => {
				pickStep++;
				return pickStep === 1 ? "a" : true; // first pick: select "a", second: confirm
			},
			pickMulti: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ pickers } as never);
		// Mirror the persisted active provider in the in-memory config so the
		// handler's wasActive check matches.
		deps.config.baseURL = "https://a.example";
		deps.config.apiKey = "key-a";
		await handleInput("/provider delete", undefined, deps);
		expect(noticeText(calls)).toContain("Switched to");
		expect(noticeText(calls)).toContain("b");
		expect(deps.config.baseURL).toBe("https://b.example");
		expect(deps.config.apiKey).toBe("key-b");
	});

	// Regression for the legacy code path: delete-the-only-active-provider
	// used to write { providerUrl: undefined, apiKey: undefined }, which the
	// spread-based updateSettings converts into "erase those keys". Then the
	// next startup's migrateProviders would resurrect the deleted provider
	// as a `default` entry (providerUrl/apiKey still in the legacy fields),
	// silently putting a dead credential back into the picker.
	it("/provider delete of last active provider clears legacy fields", async () => {
		writeSettings({
			providers: [{ name: "only", url: "https://only.example", apiKey: "k-only" }],
			providerUrl: "https://only.example",
			apiKey: "k-only",
		});
		let pickStep = 0;
		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async () => null,
			pickOption: async () => {
				pickStep++;
				return pickStep === 1 ? "only" : true;
			},
			pickMulti: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ pickers } as never);
		deps.config.baseURL = "https://only.example";
		deps.config.apiKey = "k-only";
		await handleInput("/provider delete", undefined, deps);
		expect(noticeText(calls)).toContain("No providers left");
		// The handler clears the legacy fields so migration can't resurrect.
		expect(deps.config.baseURL).toBe("");
		expect(deps.config.apiKey).toBe("");
	});

	it("/provider add → save + select model", async () => {
		// drive the add wizard through the three prompts, then a model selection,
		// then a reasoning level. The helper extracted in 0.6.6+ should reuse
		// the same selectModel + selectReasoningLevel flow /activate uses.
		writeSettings({});
		let textStep = 0;
		const pickers: import("../src/pickers/types.ts").Pickers = {
			promptText: async () => {
				textStep++;
				// name → url → key
				if (textStep === 1) return "openrouter";
				if (textStep === 2) return "https://openrouter.example/v1";
				if (textStep === 3) return "sk-or-test";
				return null;
			},
			pickOption: async () => ({
				model: "gpt-test",
				contextWindow: 64_000,
			}),
			pickMulti: async () => null,
			log: () => {},
		};
		const { deps, calls } = createFakeDeps({ pickers } as never);
		await handleInput("/provider add", undefined, deps);
		// Wizard produces an "added and selected" notice (distinct from /activate's
		// "Provider: ... . Select a model." wording). If the helper extract is
		// wrong, this check goes red because the notice shape changes.
		const notice = String(calls.showNotice?.at(-1)?.[0] ?? "");
		expect(notice).toMatch(/added|Model:/);
	});
});
