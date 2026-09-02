import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import { storeProjectMemory } from "../src/core/memory.ts";
import { createAgentRunner } from "../src/core/runner.ts";
import { appendMessage, createSession, saveSession } from "../src/core/session.ts";
import { queryEndpointOverview } from "../src/core/telemetry.ts";
import type { ServerBridge } from "../src/server/bridge.ts";
import { createServerBridge } from "../src/server/bridge.ts";
import { isInsideRoot, startServer } from "../src/server/server.ts";

let server: ReturnType<typeof startServer>;
let origin: string;
let testDbDir: string;
let previousDbPath: string | undefined;

async function startTestServer(): Promise<void> {
	server = startServer({
		port: 0,
		host: "127.0.0.1",
		bridge: {} as ServerBridge,
		webUser: "cast",
		serverPassword: "test-password",
		version: "test",
	});
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
}

async function stopTestServer(): Promise<void> {
	server.close();
	await once(server, "close");
}

beforeEach(async () => {
	previousDbPath = process.env.CAST_SESSIONS_DB;
	testDbDir = mkdtempSync(join(tmpdir(), "cast-web-server-test-"));
	process.env.CAST_SESSIONS_DB = join(testDbDir, "sessions.db");
	resetDbConnectionForTests();
	await startTestServer();
});

afterEach(async () => {
	await stopTestServer();
	resetDbConnectionForTests();
	if (previousDbPath === undefined) delete process.env.CAST_SESSIONS_DB;
	else process.env.CAST_SESSIONS_DB = previousDbPath;
	rmSync(testDbDir, { recursive: true, force: true });
});

describe("web session authentication", () => {
	it("uses Cast's login page instead of a browser Basic Auth prompt", async () => {
		const root = await fetch(`${origin}/`, { redirect: "manual" });
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/login");
		expect(root.headers.get("www-authenticate")).toBeNull();
		expect(root.headers.get("x-frame-options")).toBe("DENY");
		expect(root.headers.get("cross-origin-opener-policy")).toBe("same-origin");

		const login = await fetch(`${origin}/login`);
		expect(login.status).toBe(200);
		expect(await login.text()).toContain('aria-label="Sign in to Cast"');
	});

	it("limits repeated failed sign-in attempts", async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await fetch(`${origin}/api/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: "cast", password: "wrong" }),
			});
			expect(response.status).toBe(401);
		}

		const limited = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "wrong" }),
		});
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).not.toBeNull();
	});

	it("protects the API with a server-side HttpOnly session", async () => {
		const unauthorized = await fetch(`${origin}/api/sessions`);
		expect(unauthorized.status).toBe(401);
		expect(await unauthorized.json()).toEqual({ error: "Authentication required" });

		const rejected = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "wrong" }),
		});
		expect(rejected.status).toBe(401);

		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		expect(authenticated.status).toBe(200);
		const cookie = authenticated.headers.get("set-cookie");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");

		const app = await fetch(`${origin}/`, { headers: { Cookie: cookie! } });
		expect(app.status).toBe(200);
		expect(await app.text()).toContain('<div id="app"></div>');
	});

	it("keeps an authenticated session across a server restart", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie");
		expect(cookie).not.toBeNull();

		await stopTestServer();
		await startTestServer();

		const app = await fetch(`${origin}/`, { headers: { Cookie: cookie! } });
		expect(app.status).toBe(200);
	});

	it("keeps the shared view's static application assets public", async () => {
		const app = await fetch(`${origin}/app.js`);
		expect(app.status).toBe(200);
		expect(await app.text()).toContain("cast server");
	});

	it("rejects the worktree+sandbox combo up front so the modal surfaces a clean 400", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie")!;
		const res = await fetch(`${origin}/api/sessions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({ cwd: "sandbox", worktree: "feature-x" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toMatch(/worktree/i);
	});

	it("redirects an already-signed-in visitor from /login to /", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie")!;

		const login = await fetch(`${origin}/login`, { headers: { Cookie: cookie }, redirect: "manual" });
		expect(login.status).toBe(302);
		expect(login.headers.get("location")).toBe("/");
		expect(login.headers.get("cache-control")).toBe("no-store");
		expect(await login.text()).not.toContain("Sign in");

		const loginHtml = await fetch(`${origin}/login.html`, {
			headers: { Cookie: cookie },
			redirect: "manual",
		});
		expect(loginHtml.status).toBe(302);
		expect(loginHtml.headers.get("location")).toBe("/");
	});
});

describe("/api/server/status", () => {
	beforeEach(async () => {
		// The status endpoint reads the real ~/.cast/server.json. Tests run in
		// parallel with everything else in the world; point HOME at the per-
		// test tmp dir so a stray daemon state file from a real run can't
		// leak into the response, and so writing a state file below doesn't
		// pollute the user's real config.
		process.env.HOME = testDbDir;
		process.env.USERPROFILE = testDbDir;
	});

	it("reports running=false when no daemon state file exists", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie")!;
		const res = await fetch(`${origin}/api/server/status`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ running: false });
	});

	it("reports running=true with the daemon's pid/host/port when its state file points at a live process", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie")!;

		const { mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		mkdirSync(join(testDbDir, ".cast"), { recursive: true });
		writeFileSync(
			join(testDbDir, ".cast", "server.json"),
			JSON.stringify({
				pid: process.pid, // self — guaranteed live for the duration of the test
				port: 9999,
				host: "127.0.0.1",
				startedAt: new Date().toISOString(),
				foreground: true,
			}),
		);

		const res = await fetch(`${origin}/api/server/status`, { headers: { Cookie: cookie } });
		const body = (await res.json()) as {
			running: boolean;
			pid?: number;
			host?: string;
			port?: number;
			startedAt?: string;
			foreground?: boolean;
		};
		expect(res.status).toBe(200);
		expect(body.running).toBe(true);
		expect(body.pid).toBe(process.pid);
		expect(body.host).toBe("127.0.0.1");
		expect(body.port).toBe(9999);
		expect(body.foreground).toBe(true);
		expect(typeof body.startedAt).toBe("string");
	});

	it("self-heals a state file that points at a dead pid (cleans it up, reports running=false)", async () => {
		const authenticated = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = authenticated.headers.get("set-cookie")!;

		const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const stateFile = join(testDbDir, ".cast", "server.json");
		mkdirSync(join(testDbDir, ".cast"), { recursive: true });
		// A pid we can be confident isn't alive — extremely high number that's
		// far past any real pid on a Linux box, and well above any pid that
		// could be recycled to a live one inside the test process.
		writeFileSync(
			stateFile,
			JSON.stringify({ pid: 4_000_000_000, port: 1337, host: "127.0.0.1", startedAt: "x", foreground: false }),
		);
		expect(existsSync(stateFile)).toBe(true);

		const res = await fetch(`${origin}/api/server/status`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ running: false });
		// The endpoint should also have cleaned up the stale file, so the
		// next request sees the same answer instead of "still stale".
		expect(existsSync(stateFile)).toBe(false);
	});
});
// JSON response compression
// ============================================================================
// The api/json() helper gzip-encodes anything over 8 KB so the worst
// payloads on the server (the sidebar list, a single-session detail
// page) cross the wire as a tenth of their JSON size. SSE endpoints
// deliberately stay uncompressed — chunked text/event-stream and a
// Content-Encoding header don't mix on every browser/proxy. This block
// pins both behaviors through the real startServer call so a future
// refactor can't silently regress them.
describe("JSON response compression", () => {
	let memorySessionId = "";
	// The shared startServer above uses `{} as ServerBridge`, so this
	// describe swaps it out for a populated one — 80 sessions are enough
	// to push the /api/sessions responses past the 8 KB compression
	// threshold without needing to spin up a real provider. runAgentLoop
	// is fire-and-forget; stub it so the bridge doesn't need one.
	const runAgentLoop = vi.fn().mockResolvedValue(undefined);
	vi.mock("../src/core/loop.ts", async (importOriginal) => {
		const actual = await importOriginal<typeof import("../src/core/loop.ts")>();
		return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoop(...args) };
	});
	beforeEach(async () => {
		await stopTestServer();
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
			mcpResult: {
				toolIndex: new Map(),
				toolDefinitions: [],
				connections: [],
				diagnostics: [],
				allServerNames: [],
			},
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
		const memorySession = bridge.createSession("senior", "gpt-4o", testDbDir, false);
		memorySessionId = memorySession.id;
		storeProjectMemory(testDbDir, memorySessionId, "demo-turn", [
			{
				type: "architecture",
				content: "The project memory panel is scoped to the current working directory.",
				importance: 92,
			},
		]);
		// 80 sessions × a short user + assistant message easily clears
		// the 8 KB threshold once listSessionSummaries JSON-encodes them.
		for (let i = 0; i < 80; i++) {
			const session = createSession("gpt-4o", testDbDir);
			appendMessage(session, {
				role: "user",
				content: `do thing number ${i} on this path that requires the model to act`,
			});
			appendMessage(session, {
				role: "assistant",
				content: `Here is what happened next, including the tool calls and the final answer ${i}`,
			});
			saveSession(session);
		}
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

	it("gzip-encodes JSON responses that exceed the 8 KB threshold", async () => {
		const auth = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = auth.headers.get("set-cookie")!;

		const res = await fetch(`${origin}/api/sessions`, {
			headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-encoding")).toBe("gzip");
		expect(res.headers.get("content-type")).toBe("application/json");
		// Vary must include Accept-Encoding so a downstream cache key
		// Note: undici's fetch automatically decompresses a gzip response body
		// before exposing it via arrayBuffer()/json(), so all we can verify
		// from the outside is the wire-level header — the server set it, a
		// downstream cache key must include it (Vary), and the body parses
		// as valid JSON once uncompressed. The actual byte-level round-trip
		// is covered by the unit tests for json() itself.
		expect(res.headers.get("vary")).toContain("Accept-Encoding");
		const sessions = (await res.json()) as Array<{ id: string; title: string }>;
		expect(sessions.length).toBeGreaterThanOrEqual(80);
	});

	it("does not gzip responses smaller than the threshold", async () => {
		const auth = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = auth.headers.get("set-cookie")!;

		// /api/auth/session is a tiny JSON `{authenticated:true}` — well
		// below the 8 KB threshold. Must ship uncompressed.
		const res = await fetch(`${origin}/api/auth/session`, {
			headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-encoding")).toBeNull();
		const body = await res.json();
		expect(body).toEqual({ authenticated: true });
	});

	it("serves project memory for the selected session", async () => {
		const auth = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = auth.headers.get("set-cookie")!;

		const res = await fetch(`${origin}/api/sessions/${memorySessionId}/memory?q=memory%20panel`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Array<{ content: string; sourceSessionId: string }> };
		expect(body.items).toHaveLength(1);
		expect(body.items[0]?.content).toContain("memory panel");
		expect(body.items[0]?.sourceSessionId).toBe(memorySessionId);
	});

	it("keeps SSE endpoints uncompressed to avoid chunked-encoding + gzip conflict", async () => {
		const auth = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = auth.headers.get("set-cookie")!;

		// The SSE endpoint sends the initial ": connected" frame right
		// after writeHead, so a single fetch of the headers is enough to
		// observe the Content-Encoding contract. Stream body is left
		// to the publisher (test/web-bridge.test.ts already covers
		// listener-side event delivery).
		const controller = new AbortController();
		const res = await fetch(`${origin}/api/sessions/events`, {
			headers: { Cookie: cookie, "Accept-Encoding": "gzip" },
			signal: controller.signal,
		});
		// text/event-stream must not declare gzip — even when the session
		// list behind it would otherwise well exceed the 8 KB threshold.
		expect(res.headers.get("content-encoding")).toBeNull();
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		// Drain the response so the server doesn't see lingering
		// connections on the next test.
		controller.abort();
		await res.arrayBuffer().catch(() => undefined);
	});
});

describe("request body limits", () => {
	it("rejects an oversized request body with 413 instead of buffering it all in memory", async () => {
		const auth = await fetch(`${origin}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "cast", password: "test-password" }),
		});
		const cookie = auth.headers.get("set-cookie")!;

		// Streamed, not one big string: the point is that the *server* must
		// not accumulate the whole thing, so the client must not either.
		// 56MB total, past the 48MB readBody ceiling.
		const chunk = new Uint8Array(1024 * 1024).fill(0x20);
		const totalChunks = 56;
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent >= totalChunks) {
					controller.close();
					return;
				}
				sent++;
				controller.enqueue(chunk);
			},
		});

		const res = await fetch(`${origin}/api/sessions`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body,
			// Node's fetch requires this for a streaming request body.
			duplex: "half",
		} as RequestInit & { duplex: "half" });

		expect(res.status).toBe(413);
		expect(((await res.json()) as { error?: string }).error).toContain("too large");
		// Without the cap this same request is buffered in full and answered by
		// the route handler (400/500 from the JSON parse), never 413 — so the
		// status alone distinguishes "refused while streaming" from "swallowed".
		// How much of the body the client got to send before the refusal is
		// deliberately not asserted: the server drains the remainder rather than
		// resetting the socket, so that count is load-dependent, not a contract.
	});
});

describe("factory UI slugs", () => {
	it("a UI directory named after a daemon route can't make that route public", async () => {
		// A UI directory can appear on disk without going through createUi's
		// reserved-name check — a user (or an agent, which server.ts documents as
		// an expected editor of ~/.cast/ui/*) simply making the directory. When a
		// discovered UI's slug matched a real route's first path segment, the auth
		// gate treated every such request as a public static route, so `api` here
		// meant the whole API answered unauthenticated.
		const fakeHome = mkdtempSync(join(tmpdir(), "cast-ui-slug-test-"));
		const previousHome = process.env.HOME;
		process.env.HOME = fakeHome;
		try {
			const unauthenticated = await fetch(`${origin}/api/sessions`);
			expect(unauthenticated.status).toBe(401);

			mkdirSync(join(fakeHome, ".cast", "ui", "api"), { recursive: true });
			writeFileSync(join(fakeHome, ".cast", "ui", "api", "index.html"), "<h1>hi</h1>");

			const stillGated = await fetch(`${origin}/api/sessions`);
			expect(stillGated.status).toBe(401);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});
});

describe("api telemetry paths", () => {
	it("records the route template, never the share token or session id in the URL", async () => {
		// A share link's token is the only thing guarding an otherwise
		// unauthenticated read of a thread — persisting it into the telemetry
		// store (7-day retention) and rendering it in the dashboard's endpoint
		// table would hand it to anyone with dashboard access. Recording the
		// template also stops every session id becoming its own row in the
		// endpoint overview's GROUP BY.
		const token = "sharetokenthatmustnotbestored";
		await fetch(`${origin}/api/shared/${token}`);
		await fetch(`${origin}/api/shared/${token}`, { method: "POST" }); // 404, no route
		await fetch(`${origin}/api/sessions/abc123/rename`, { method: "POST" });

		const paths = queryEndpointOverview().map((row) => row.path);
		expect(paths.join("\n")).not.toContain(token);
		expect(paths).toContain("/api/shared/:token");
		expect(paths).toContain("/api/sessions/:id/rename");
	});
});

describe("isInsideRoot", () => {
	let root: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-inside-root-"));
		outside = mkdtempSync(join(tmpdir(), "cast-outside-root-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	it("accepts the root itself and paths under it", () => {
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src", "app.ts"), "x");
		expect(isInsideRoot(root, root)).toBe(true);
		expect(isInsideRoot(root, join(root, "src"))).toBe(true);
		expect(isInsideRoot(root, join(root, "src", "app.ts"))).toBe(true);
		// A destination that doesn't exist yet is judged by its parent.
		expect(isInsideRoot(root, join(root, "src", "new-name.ts"))).toBe(true);
	});

	it("rejects a traversing path", () => {
		expect(isInsideRoot(root, join(root, "..", "etc"))).toBe(false);
		expect(isInsideRoot(root, outside)).toBe(false);
	});

	it("rejects a path reached through a symlink out of the root", () => {
		// The /fs routes' consumers all follow symlinks (statSync,
		// createReadStream, rmSync, renameSync), so a purely lexical check let
		// a link inside the cwd list, download and delete outside the project.
		writeFileSync(join(outside, "secret.txt"), "secret");
		symlinkSync(outside, join(root, "link"));

		expect(isInsideRoot(root, join(root, "link"))).toBe(false);
		expect(isInsideRoot(root, join(root, "link", "secret.txt"))).toBe(false);
	});
});
