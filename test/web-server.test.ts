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
});
