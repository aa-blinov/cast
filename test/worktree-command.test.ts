/**
 * /worktree slash command — switch the live session into an isolated git
 * worktree. Tests exercise the full `ensureSessionWorktree` plumbing (real
 * `git worktree add`, real commits, real branch creation) since mocking the
 * git CLI would just be testing our mocks, not git.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import type { SessionState } from "../src/core/session.ts";
import type { PermissionMode } from "../src/core/settings.ts";
import type { Pickers } from "../src/pickers/types.ts";
import { type CommandDeps, handleInput } from "../src/ui/commands.ts";
import type { UseAgentSession } from "../src/ui/useAgentSession.ts";

vi.mock("../src/core/config.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/core/config.ts")>();
	return {
		...mod,
		probeProvider: vi.fn().mockResolvedValue("ok"),
		runOnboardingCheck: vi.fn().mockResolvedValue(true),
	};
});

let tmpRoot: string | undefined;

beforeEach(() => {
	tmpRoot = join(tmpdir(), `cast-wt-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(path: string): void {
	git(path, ["init", "--initial-branch=main"]);
	git(path, ["config", "user.email", "test@example.com"]);
	git(path, ["config", "user.name", "Test"]);
	git(path, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(path, "README.md"), "hello\n");
	writeFileSync(join(path, ".gitignore"), ".cast/\n");
	git(path, ["add", "."]);
	git(path, ["commit", "-m", "init"]);
}

function createFakeDeps(opts: { cwd: string; running?: boolean }): {
	deps: CommandDeps;
	calls: { [k: string]: unknown[][] };
} {
	const calls: { [k: string]: unknown[][] } = {};
	const track =
		(name: string) =>
		(...args: unknown[]) => {
			if (!calls[name]) calls[name] = [];
			calls[name].push(args);
		};

	const agent = {
		submit: track("submit"),
		steer: track("steer"),
		followUp: track("followUp"),
		abort: track("abort"),
		clearContext: track("clearContext"),
		resetQueue: track("resetQueue"),
		refresh: track("refresh"),
		refreshMeta: track("refreshMeta"),
		addDisplayMessage: track("addDisplayMessage"),
		messages: [],
		streaming: null,
		status: "idle",
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
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		cwd: opts.cwd,
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
		running: opts.running ?? false,
		onQuit: track("onQuit"),
		showNotice: track("showNotice"),
		cwd: opts.cwd,
		setCwd: track("setCwd"),
		currentPersona: {
			name: "default",
			label: "Default",
			description: "test",
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
		activeAutoRules: [],
		setActiveAutoRules: track("setActiveAutoRules"),
		systemPrompt: "",
		setSystemPrompt: track("setSystemPrompt"),
		mcpResult: {
			allServerNames: [],
			connections: [],
			toolDefinitions: [],
			toolIndex: new Map(),
			disabledServerNames: [],
			diagnostics: [],
		} as McpSetupResult,
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
			settings: { providers: [] } as never,
			pickers: fakePickers,
		} as never,
		pickers: fakePickers,
		sshHosts: [],
		setSshHosts: track("setSshHosts"),
		reasoningMeta: undefined,
		setReasoningMeta: track("setReasoningMeta"),
		webToolsEnabled: false,
		setWebToolsEnabled: track("setWebToolsEnabled"),
		planMode: false,
		setPlanMode: track("setPlanMode"),
		statusBar: { segments: [] } as never,
		setStatusBar: track("setStatusBar"),
	};

	return { deps, calls };
}

describe("/worktree slash command", () => {
	it("creates a worktree and switches session.cwd into it", async () => {
		const repo = join(tmpRoot!, "repo");
		mkdirSync(repo);
		initRepo(repo);

		const { deps, calls } = createFakeDeps({ cwd: repo });
		await handleInput("/worktree feature-1", undefined, deps);

		const notices = (calls.showNotice ?? []).map((n) => n[0]).map(String);
		const success = notices.find((m) => m.includes("Worktree:"));
		expect(success, `expected a success notice, got: ${notices.join(" | ")}`).toBeDefined();

		// The session.cwd on the in-memory state should be the new worktree path.
		expect((deps.session as SessionState).cwd).toBeTruthy();
		expect((deps.session as SessionState).cwd).not.toBe(repo);
		expect((deps.session as SessionState).cwd).toMatch(/\.cast[\\/]worktrees[\\/]feature-1$/);

		// setCwd on the UI state and the agent refresh should both have fired.
		expect(calls.setCwd?.length ?? 0).toBeGreaterThan(0);
		expect(calls.refresh?.length ?? 0).toBeGreaterThan(0);

		// The branch was created off main and lives on disk.
		const wtPath = (deps.session as SessionState).cwd!;
		expect(existsSync(wtPath)).toBe(true);
		const branch = git(wtPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
		expect(branch).toBe("cast-feature-1");
	});

	it("reuses an existing worktree with the same name (resume case)", async () => {
		const repo = join(tmpRoot!, "repo");
		mkdirSync(repo);
		initRepo(repo);

		const first = createFakeDeps({ cwd: repo });
		await handleInput("/worktree reuse-me", undefined, first.deps);
		const firstWt = (first.deps.session as SessionState).cwd!;
		// Drop a marker file in the worktree so we can prove it survived.
		writeFileSync(join(firstWt, "marker.txt"), "kept\n");

		// Second "session" pointing at the same main checkout, same worktree name.
		const second = createFakeDeps({ cwd: repo });
		await handleInput("/worktree reuse-me", undefined, second.deps);
		const secondWt = (second.deps.session as SessionState).cwd!;

		expect(secondWt).toBe(firstWt);
		expect(existsSync(join(secondWt, "marker.txt"))).toBe(true);
	});

	it("rejects the command while the agent is running", async () => {
		const repo = join(tmpRoot!, "repo");
		mkdirSync(repo);
		initRepo(repo);

		const { deps, calls } = createFakeDeps({ cwd: repo, running: true });
		await handleInput("/worktree nope", undefined, deps);

		const notices = (calls.showNotice ?? []).map((n) => n[0]).map(String);
		expect(notices.some((m) => m.includes("Agent running"))).toBe(true);
		expect((deps.session as SessionState).cwd).toBe(repo);
		expect(calls.setCwd?.length ?? 0).toBe(0);
	});

	it("shows a usage hint when no name is given", async () => {
		const { deps, calls } = createFakeDeps({ cwd: tmpRoot! });
		await handleInput("/worktree", undefined, deps);

		const notices = (calls.showNotice ?? []).map((n) => n[0]).map(String);
		expect(notices.some((m) => m.startsWith("[Usage: /worktree"))).toBe(true);
	});

	it("surfaces git errors verbatim (not-a-repo)", async () => {
		const notARepo = join(tmpRoot!, "not-a-repo");
		mkdirSync(notARepo);
		// no initRepo — plain directory.

		const { deps, calls } = createFakeDeps({ cwd: notARepo });
		await handleInput("/worktree foo", undefined, deps);

		const notices = (calls.showNotice ?? []).map((n) => n[0]).map(String);
		const failure = notices.find((m) => m.startsWith("[Worktree failed:"));
		expect(failure, `expected a failure notice, got: ${notices.join(" | ")}`).toBeDefined();
		expect(failure).toMatch(/requires a git repository/);
	});
});
