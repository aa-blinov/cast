import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbConnectionForTests } from "../src/core/db.ts";
import type { WebBridge } from "../src/web/bridge.ts";
import { startWebServer } from "../src/web/server.ts";

let server: ReturnType<typeof startWebServer>;
let origin: string;
let testDbDir: string;
let previousDbPath: string | undefined;

async function startServer(): Promise<void> {
	server = startWebServer({
		port: 0,
		host: "127.0.0.1",
		bridge: {} as WebBridge,
		webUser: "cast",
		webPassword: "test-password",
		version: "test",
	});
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	origin = `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
	server.close();
	await once(server, "close");
}

beforeEach(async () => {
	previousDbPath = process.env.CAST_SESSIONS_DB;
	testDbDir = mkdtempSync(join(tmpdir(), "cast-web-server-test-"));
	process.env.CAST_SESSIONS_DB = join(testDbDir, "sessions.db");
	resetDbConnectionForTests();
	await startServer();
});

afterEach(async () => {
	await stopServer();
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

		await stopServer();
		await startServer();

		const app = await fetch(`${origin}/`, { headers: { Cookie: cookie! } });
		expect(app.status).toBe(200);
	});

	it("keeps the shared view's static application assets public", async () => {
		const app = await fetch(`${origin}/app.js`);
		expect(app.status).toBe(200);
		expect(await app.text()).toContain("cast web");
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

describe("/api/web/status", () => {
	beforeEach(async () => {
		// The status endpoint reads the real ~/.cast/web.json. Tests run in
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
		const res = await fetch(`${origin}/api/web/status`, { headers: { Cookie: cookie } });
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
			join(testDbDir, ".cast", "web.json"),
			JSON.stringify({
				pid: process.pid, // self — guaranteed live for the duration of the test
				port: 9999,
				host: "127.0.0.1",
				startedAt: new Date().toISOString(),
				foreground: true,
			}),
		);

		const res = await fetch(`${origin}/api/web/status`, { headers: { Cookie: cookie } });
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
		const stateFile = join(testDbDir, ".cast", "web.json");
		mkdirSync(join(testDbDir, ".cast"), { recursive: true });
		// A pid we can be confident isn't alive — extremely high number that's
		// far past any real pid on a Linux box, and well above any pid that
		// could be recycled to a live one inside the test process.
		writeFileSync(
			stateFile,
			JSON.stringify({ pid: 4_000_000_000, port: 1337, host: "127.0.0.1", startedAt: "x", foreground: false }),
		);
		expect(existsSync(stateFile)).toBe(true);

		const res = await fetch(`${origin}/api/web/status`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ running: false });
		// The endpoint should also have cleaned up the stale file, so the
		// next request sees the same answer instead of "still stale".
		expect(existsSync(stateFile)).toBe(false);
	});
});
