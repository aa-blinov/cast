import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import type { McpSetupResult } from "../src/core/mcp.ts";
import type { Persona } from "../src/core/personas.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { createSession } from "../src/core/session.ts";
import type { StartupResult } from "../src/core/startup.ts";
import { createServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

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

function makePersona(): Persona {
	return {
		name: "coding",
		label: "Coding",
		description: "Reads files, runs commands, edits code",
		systemPrompt: "You are the coding persona.",
		source: "builtin",
		filePath: "/builtin/coding.md",
		subagents: false,
	} as Persona;
}

function makeResult(cwd: string): StartupResult {
	const coding = makePersona();
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
		personas: [coding],
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
	};
}

function git(cwd: string, args: string[]): void {
	execFileSync("git", args, { cwd });
}

let repoDir: string;
let server: ReturnType<typeof startServer>;
let origin: string;
let cookie: string;
let sessionId: string;

beforeEach(async () => {
	repoDir = mkdtempSync(join(tmpdir(), "cast-diff-rename-test-"));
	git(repoDir, ["init", "-q"]);
	git(repoDir, ["config", "user.email", "t@t.com"]);
	git(repoDir, ["config", "user.name", "t"]);
	writeFileSync(join(repoDir, "old.txt"), "line1\nline2\nline3\n");
	git(repoDir, ["add", "old.txt"]);
	git(repoDir, ["commit", "-qm", "init"]);

	const bridge = createServerBridge(makeResult(repoDir));
	const ws = bridge.createSession();
	sessionId = ws.id;

	server = startServer({
		port: 0,
		host: "127.0.0.1",
		bridge,
		webUser: "cast",
		serverPassword: "test-password",
		version: "test",
	});
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;

	const authenticated = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "cast", password: "test-password" }),
	});
	cookie = authenticated.headers.get("set-cookie")!;
});

afterEach(async () => {
	server.close();
	await once(server, "close");
	rmSync(repoDir, { recursive: true, force: true });
});

async function fetchDiff(): Promise<{
	files: Array<{ path: string; oldPath?: string; additions: number; deletions: number }>;
	groups: { renamed: string[]; modified: string[] };
}> {
	const res = await fetch(`${origin}/api/sessions/${sessionId}/diff`, { headers: { Cookie: cookie } });
	return res.json();
}

describe("GET /api/sessions/:id/diff — renamed files", () => {
	it("shows a pure rename (no content change) as a rename, not the whole file re-added", async () => {
		git(repoDir, ["mv", "old.txt", "new.txt"]);

		const data = await fetchDiff();
		expect(data.groups.renamed).toEqual(["new.txt"]);
		expect(data.groups.modified).toEqual([]);
		const file = data.files.find((f) => f.path === "new.txt");
		expect(file?.oldPath).toBe("old.txt");
		// A same-content rename has nothing to add/remove — the old bug diffed
		// the new path alone (nothing to compare it against) and reported the
		// entire file as freshly added instead.
		expect(file?.additions).toBe(0);
		expect(file?.deletions).toBe(0);
	});

	it("shows a rename with a staged content edit, correctly attributed to the rename", async () => {
		git(repoDir, ["mv", "old.txt", "new.txt"]);
		writeFileSync(join(repoDir, "new.txt"), "line1\nline2\nline3\nline4 added\n");
		git(repoDir, ["add", "new.txt"]);

		const data = await fetchDiff();
		expect(data.groups.renamed).toEqual(["new.txt"]);
		const file = data.files.find((f) => f.path === "new.txt");
		expect(file?.oldPath).toBe("old.txt");
		expect(file?.additions).toBe(1);
		expect(file?.deletions).toBe(0);
	});

	it("shows both the staged rename+edit and further unstaged edits on the same renamed file", async () => {
		git(repoDir, ["mv", "old.txt", "new.txt"]);
		writeFileSync(join(repoDir, "new.txt"), "line1\nline2\nline3\nline4 added\n");
		git(repoDir, ["add", "new.txt"]);
		writeFileSync(join(repoDir, "new.txt"), "line1\nline2\nline3\nline4 added\nline5 unstaged\n");

		const data = await fetchDiff();
		expect(data.groups.renamed).toEqual(["new.txt"]);
		expect(data.groups.modified).toEqual([]);
		const entries = data.files.filter((f) => f.path === "new.txt");
		// One entry for the staged rename+edit (old.txt -> new.txt, +1 line),
		// one for the further unstaged edit (+1 more line) — the previous bug
		// silently dropped the staged half entirely.
		expect(entries).toHaveLength(2);
		const staged = entries.find((f) => f.oldPath === "old.txt");
		const unstaged = entries.find((f) => f.oldPath !== "old.txt");
		expect(staged?.additions).toBe(1);
		expect(unstaged?.additions).toBe(1);
	});
});
