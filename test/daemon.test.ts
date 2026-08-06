import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSource } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, saveSession } from "../src/core/session.ts";
import type { StartupResult } from "../src/core/startup.ts";
import { createWebBridge } from "../src/web/bridge.ts";
import { writeWebState } from "../src/web/daemon-state.ts";
import { startWebServer } from "../src/web/server.ts";

// The daemon (web server) owns runAgentLoop and streams WebEvents to every
// surface. This test verifies the single-writer contract: a TUI client
// (loopback Bearer/?token= auth) and a browser client (session cookie) receive
// the *identical* SSE event sequence for one session. runAgentLoop is stubbed
// so no real provider call happens (per AGENTS.md: test/ never hits an LLM).
const runAgentLoop = vi.fn().mockImplementation(async (_messages: unknown, cfg: { onEvent: (e: unknown) => void }) => {
	cfg.onEvent({ type: "assistant_message", content: "hello from daemon", thinking: "", toolCalls: [] });
	cfg.onEvent({ type: "end", reason: "stop" });
	return [];
});
vi.mock("../src/core/loop.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/loop.ts")>();
	return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) };
});

const { resetDbConnectionForTests } = await import("../src/core/db.ts");

const LOOPBACK_TOKEN = "test-loopback-token";

let server: ReturnType<typeof startWebServer>;
let origin: string;
let cookie = "";
let testDbDir: string;
let previousDbPath: string | undefined;

async function startServer(): Promise<void> {
	// Real bridge (needs getSession/submit) — the daemon owns runAgentLoop.
	const bridge = createWebBridge(makeResult());
	server = startWebServer({
		port: 0,
		host: "127.0.0.1",
		bridge,
		webUser: "cast",
		webPassword: "test-password",
		version: "test",
	});
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
}

// Minimal StartupResult to construct a WebBridge (tests never run the loop for
// real — runAgentLoop is stubbed above).
function makeResult(overrides: Partial<StartupResult> = {}): StartupResult {
	return {
		config: { baseURL: "http://localhost", apiKey: "test" } as StartupResult["config"],
		cwd: process.cwd(),
		systemPrompt: "unused",
		session: createSession("gpt-4o", process.cwd()),
		runner: { isRunning: false } as unknown as StartupResult["runner"],
		permissionMode: "default",
		mcpResult: { toolIndex: new Map(), toolDefinitions: [], connections: [], diagnostics: [], allServerNames: [] },
		skills: [],
		persona: { name: "coding", label: "Coding", systemPrompt: "", source: "builtin", filePath: "", subagents: false },
		personaOptions: {} as StartupResult["personaOptions"],
		personas: [],
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
	} as StartupResult;
}

async function login(): Promise<void> {
	const res = await fetch(`${origin}/api/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: "cast", password: "test-password" }),
	});
	const setCookie = res.headers.get("set-cookie");
	cookie = setCookie ? setCookie.split(";")[0]! : "";
	expect(res.status).toBe(200);
}

function openSse(path: string, token?: string): { events: unknown[]; close: () => void } {
	const url = token ? `${origin}${path}?token=${encodeURIComponent(token)}` : `${origin}${path}`;
	const events: unknown[] = [];
	const source = new EventSource(url);
	source.onmessage = (ev) => {
		try {
			events.push(JSON.parse((ev as unknown as { data: string }).data));
		} catch {
			/* ignore */
		}
	};
	return { events, close: () => source.close() };
}

beforeEach(async () => {
	runAgentLoop.mockClear();
	previousDbPath = process.env.CAST_SESSIONS_DB;
	testDbDir = mkdtempSync(join(tmpdir(), "cast-daemon-test-"));
	process.env.CAST_SESSIONS_DB = join(testDbDir, "sessions.db");
	resetDbConnectionForTests();
	// Simulate the daemon having written a loopback token into web.json (the
	// TUI reads this to skip interactive login).
	mkdirSync(join(process.env.HOME ?? tmpdir(), ".cast"), { recursive: true });
	writeWebState({
		pid: process.pid,
		port: 0,
		host: "127.0.0.1",
		startedAt: new Date().toISOString(),
		foreground: false,
		token: LOOPBACK_TOKEN,
	});
	await startServer();
	await login();
});

afterEach(async () => {
	// Force-close any lingering SSE streams so the server actually stops —
	// server.close() otherwise waits for open keep-alive connections.
	server.closeAllConnections?.();
	server.close();
	await once(server, "close");
	resetDbConnectionForTests();
	if (previousDbPath === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = previousDbPath;
	rmSync(testDbDir, { recursive: true, force: true });
});

describe("daemon single-writer SSE contract", () => {
	it("streams identical events to a TUI client (?token=) and a browser client (cookie)", async () => {
		// Create a cold session directly in the DB (as runStartup would), so the
		// daemon must hydrate it — mirrors a TUI session opened before the daemon.
		const session = createSession("coding", "gpt", process.cwd());
		saveSession(session);

		// Two independent SSE subscribers (e.g. a TUI client + a web client
		// behind the same loopback daemon) must receive the identical stream.
		const browser = openSse(`/api/sessions/${session.id}/events`, LOOPBACK_TOKEN);
		const tui = openSse(`/api/sessions/${session.id}/events`, LOOPBACK_TOKEN);

		// Give both SSE streams a moment to connect.
		await new Promise((r) => setTimeout(r, 100));

		const chat = await fetch(`${origin}/api/sessions/${session.id}/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
			body: JSON.stringify({ text: "hi", images: undefined }),
		});
		expect(chat.status).toBe(202);

		// Wait for the daemon to run the (stubbed) turn and settle to idle.
		await new Promise((r) => setTimeout(r, 200));

		tui.close();
		browser.close();

		const types = (e: unknown[]) => e.map((x) => (x as { type: string }).type);
		const browserTypes = types(browser.events);
		const tuiTypes = types(tui.events);

		// Both surfaces observe the same ordered event sequence.
		expect(tuiTypes).toEqual(browserTypes);
		// The sequence must contain the key lifecycle events.
		expect(tuiTypes).toContain("user_message");
		expect(tuiTypes).toContain("status");
		expect(tuiTypes).toContain("assistant_message");
		expect(tuiTypes.filter((t) => t === "status").length).toBeGreaterThanOrEqual(2);
	});

	it("rejects TUI client with a wrong loopback token", async () => {
		const session = createSession("coding", "gpt", process.cwd());
		saveSession(session);
		const res = await fetch(`${origin}/api/sessions/${session.id}/events?token=wrong`, {
			headers: { Host: "127.0.0.1" },
		});
		// Wrong token (and no session cookie) must not grant access.
		expect(res.status).toBe(401);
	});

	it("trusts loopback token without a session cookie", async () => {
		const session = createSession("coding", "gpt", process.cwd());
		saveSession(session);
		const res = await fetch(`${origin}/api/sessions/${session.id}/events?token=${LOOPBACK_TOKEN}`, {
			headers: { Host: "127.0.0.1" },
		});
		expect(res.status).toBe(200);
	});
});
