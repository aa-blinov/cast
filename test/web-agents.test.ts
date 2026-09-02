import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { createSession } from "../src/core/session.ts";
import { createServerBridge } from "../src/server/bridge.ts";
import { startServer } from "../src/server/server.ts";

let server: ReturnType<typeof startServer>;
let origin: string;
let testDbDir: string;
let previousDbPath: string | undefined;

beforeEach(async () => {
	previousDbPath = process.env.CAST_SESSIONS_DB;
	testDbDir = mkdtempSync(join(tmpdir(), "cast-web-agents-test-"));
	process.env.CAST_SESSIONS_DB = join(testDbDir, "sessions.db");
	resetDbConnectionForTests();
	const bridge = createServerBridge({
		config: {
			baseURL: "http://localhost",
			apiKey: "test",
			contextWindow: 128_000,
			maxResponseTokens: 8192,
			compactionThreshold: 0.75,
			maxToolOutputLines: 2000,
			maxToolOutputBytes: 65_536,
			defaultBashTimeout: 120,
			reasoningLevel: "off",
			reasoningParams: { body: {} },
		},
		cwd: testDbDir,
		systemPrompt: "test",
		session: createSession("gpt-4o", testDbDir),
		runner: createAgentRunner(),
		permissionMode: "default",
		mcpResult: { toolIndex: new Map(), toolDefinitions: [], connections: [], diagnostics: [], allServerNames: [] },
		skills: [],
		persona: {
			name: "senior",
			label: "Senior",
			description: "",
			systemPrompt: "",
			source: "builtin",
			filePath: "",
			subagents: false,
		},
		personaOptions: {} as never,
		personas: [],
		subagentPrompts: [],
		confirmBash: async () => true,
		projectDeps: {} as never,
		projectTrusted: true,
		contextFilesSuffix: "",
		rulesSuffix: "",
		rulesLazySuffix: "",
		directoryRules: [],
		activeAutoRules: [],
		skillsPromptSuffix: "",
		sshHosts: [],
		resumed: false,
	});
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
});

afterEach(async () => {
	server.close();
	await once(server, "close");
	resetDbConnectionForTests();
	if (previousDbPath === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = previousDbPath;
	rmSync(testDbDir, { recursive: true, force: true });
});

async function login(): Promise<string> {
	const res = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "cast", password: "test-password" }),
	});
	const cookie = res.headers.get("set-cookie")!;
	return cookie;
}

describe("agents API", () => {
	it("creates, lists, and spawns via agentId", async () => {
		const cookie = await login();
		const headers = { "Content-Type": "application/json", Cookie: cookie };

		const created = await fetch(`${origin}/api/agents`, {
			method: "POST",
			headers,
			body: JSON.stringify({ name: "test-agent", persona: "senior", model: "MiniMax-M3" }),
		});
		expect(created.status).toBe(201);
		const agent = (await created.json()) as { id: string; name: string };
		expect(agent.name).toBe("test-agent");

		const listed = await fetch(`${origin}/api/agents`, { headers: { Cookie: cookie } });
		expect(listed.status).toBe(200);
		const agents = (await listed.json()) as Array<{ id: string }>;
		expect(agents.some((a) => a.id === agent.id)).toBe(true);

		const sessRes = await fetch(`${origin}/api/sessions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ agentId: agent.id }),
		});
		expect(sessRes.status).toBe(201);
		const sess = (await sessRes.json()) as { session: { persona: string; model: string } };
		expect(sess.session.persona).toBe("senior");
		expect(sess.session.model).toBe("MiniMax-M3");
	});

	it("creates session with provider/model directly", async () => {
		const cookie = await login();
		const headers = { "Content-Type": "application/json", Cookie: cookie };
		const res = await fetch(`${origin}/api/sessions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ persona: "senior", model: "gpt-4o", provider: "openai" }),
		});
		expect(res.status).toBe(201);
	});

	it("creates an agent on a database that has the multi-tenant user_id column", async () => {
		// A store migrated by the multi-tenant line of this codebase has
		// `agents.user_id INTEGER NOT NULL REFERENCES users(id)`. This line
		// knows nothing about that column, so every insert failed with "NOT
		// NULL constraint failed: agents.user_id" — agents could not be created
		// at all. Found against the developer's real database.
		const db = getDb();
		db.exec("DROP TABLE IF EXISTS agents");
		db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)");
		db.exec("INSERT OR IGNORE INTO users (id, username) VALUES (1, 'cast')");
		db.exec(`CREATE TABLE agents (
			id TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id),
			name TEXT NOT NULL,
			persona TEXT NOT NULL,
			model TEXT,
			provider TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (user_id, name)
		)`);

		const cookie = await login();
		const created = await fetch(`${origin}/api/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ name: "tenant-agent", persona: "senior" }),
		});
		expect(created.status).toBe(201);
		const row = db.prepare("SELECT user_id FROM agents WHERE name = ?").get("tenant-agent") as { user_id: number };
		expect(row.user_id).toBe(1);
	});
});
