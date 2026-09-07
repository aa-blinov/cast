import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEvent } from "../src/server/bridge.ts";
import {
	abortServerSession,
	createServerSession,
	ensureServerSession,
	followUpServerSession,
	steerServerSession,
	submitServerChat,
	subscribeServerEvents,
} from "../src/server/client.ts";

// Real HTTP server standing in for the cast server daemon: exercises the
// client's fetch calls and SSE subscription against a live socket (URL
// construction, token header, JSON bodies, event-stream framing) without
// needing an actual daemon process.
describe("server client", () => {
	let server: Server;
	let baseUrl: string;
	const received: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];

	beforeEach(async () => {
		server = createServer((req, res) => {
			const entry: { method: string; path: string; auth?: string; body?: unknown } = {
				method: req.method ?? "",
				path: req.url ?? "",
				auth: req.headers.authorization,
			};
			received.push(entry);
			if (req.method === "POST") {
				let raw = "";
				req.on("data", (chunk) => {
					raw += String(chunk);
				});
				req.on("end", () => {
					try {
						entry.body = JSON.parse(raw);
					} catch {
						entry.body = raw;
					}
				});
			}
			if (req.method === "POST" && req.url === "/api/v1/sessions") {
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "sess-1", session: { id: "sess-1" } }));
				return;
			}
			if (req.method === "GET" && req.url === "/api/v1/sessions") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify([
						{ id: "old-1", cwd: "/tmp", updatedAt: "2026-01-01T00:00:00.000Z" },
						{ id: "sess-1", cwd: "/tmp", updatedAt: "2026-02-01T00:00:00.000Z" },
					]),
				);
				return;
			}
			if (req.method === "GET" && req.url === "/api/v1/sessions/sess-1") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "sess-1", cwd: "/tmp", mode: "build", status: "idle", messages: [] }));
				return;
			}
			if (req.method === "POST" && req.url === "/api/v1/sessions/sess-1/chat") {
				res.writeHead(202, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (req.method === "GET" && req.url?.startsWith("/api/v1/sessions/sess-1/events")) {
				res.writeHead(200, { "content-type": "text/event-stream", "Cache-Control": "no-cache" });
				res.write(": connected\n\n");
				const writeEvent = (e: WebEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
				setTimeout(() => writeEvent({ type: "token", text: "hello" }), 10);
				setTimeout(() => writeEvent({ type: "end", reason: "stop" }), 20);
				setTimeout(() => writeEvent({ type: "session_end", usage: null as never, messageCount: 1 }), 30);
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${addr.port}`;
	});

	afterEach(async () => {
		received.length = 0;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("createServerSession posts persona/model/cwd and returns the id", async () => {
		const client = { baseUrl, token: "tok-123" };
		const id = await createServerSession(client, { persona: "senior", model: "hy3", cwd: "/tmp" });
		expect(id).toBe("sess-1");
		expect(received[0]).toMatchObject({ method: "POST", path: "/api/v1/sessions", auth: "Bearer tok-123" });
	});

	it("passes --bypass-permissions through to the daemon (regression)", async () => {
		// The flag never reached the daemon, so a non-interactive run hit the
		// dangerous-command confirmation, had nothing that could answer it, and
		// hung until the five-minute timeout refused the command. Verified
		// live: the same run exited 124 on a `rm -f` before this, and prints
		// the command's output after.
		const client = { baseUrl, token: undefined };
		await ensureServerSession(client, { cwd: "/tmp", permissionMode: "bypass" });
		await new Promise((r) => setTimeout(r, 20));
		const post = received.find((r) => r.method === "POST" && r.path === "/api/v1/sessions");
		expect(post?.body).toMatchObject({ permissionMode: "bypass" });
	});

	it("passes --reasoning through to the daemon (regression)", async () => {
		// Parsed, documented, and dropped like the rest: the level lived in
		// runStartup, which the daemon never runs, so `cast run -r disabled`
		// used whatever the daemon's global level was. Verified live: two
		// sessions on one daemon now report "disabled" and "enabled".
		const client = { baseUrl, token: undefined };
		await ensureServerSession(client, { cwd: "/tmp", reasoningLevel: "disabled" });
		await new Promise((r) => setTimeout(r, 20));
		const post = received.find((r) => r.method === "POST" && r.path === "/api/v1/sessions");
		expect(post?.body).toMatchObject({ reasoningLevel: "disabled" });
	});

	it("passes --no-skills / --no-mcp through to the daemon (regression)", async () => {
		// Both were parsed, documented, and dropped before the daemon: a run
		// with --no-mcp called an MCP tool anyway, and --no-skills still had
		// the skill tool. Verified live against a fixture MCP server.
		const client = { baseUrl, token: undefined };
		await ensureServerSession(client, { cwd: "/tmp", noSkills: true, noMcp: true });
		await new Promise((r) => setTimeout(r, 20));
		const post = received.find((r) => r.method === "POST" && r.path === "/api/v1/sessions");
		expect(post?.body).toMatchObject({ noSkills: true, noMcp: true });
	});

	it("passes --worktree through to the daemon (regression)", async () => {
		// `cast run -w <name>` was dropped on the floor: the flag was parsed,
		// documented in --help, and never reached createServerSession, so the
		// session ran in the project root with nothing saying otherwise.
		// Verified live before the fix — `pwd` printed the project root.
		const client = { baseUrl, token: undefined };
		await ensureServerSession(client, { persona: "senior", model: "hy3", cwd: "/tmp", worktree: "feature-one" });
		// Give the body handler a tick to finish reading.
		await new Promise((r) => setTimeout(r, 20));
		const post = received.find((r) => r.method === "POST" && r.path === "/api/v1/sessions");
		expect(post?.body).toMatchObject({ worktree: "feature-one" });
	});

	it("submitServerChat posts the text", async () => {
		const client = { baseUrl, token: undefined };
		await submitServerChat(client, "sess-1", "hello there");
		expect(received[0]).toMatchObject({ method: "POST", path: "/api/v1/sessions/sess-1/chat" });
	});

	it("rejects steering and control commands when the daemon rejects them", async () => {
		const client = { baseUrl, token: undefined };
		await expect(steerServerSession(client, "sess-1", "wait")).rejects.toThrow("steer failed");
		await expect(followUpServerSession(client, "sess-1", "after")).rejects.toThrow("follow-up failed");
		await expect(abortServerSession(client, "sess-1")).rejects.toThrow("abort failed");
	});

	it("subscribeServerEvents streams events until the predicate resolves", async () => {
		const client = { baseUrl, token: "tok" };
		const seen: string[] = [];
		const { done } = subscribeServerEvents(
			client,
			"sess-1",
			(e) => seen.push(e.type),
			(e) => e.type === "session_end",
		);
		await done;
		expect(seen).toEqual(["token", "end", "session_end"]);
	});

	it("ensureServerSession resumes an explicit id via GET", async () => {
		const client = { baseUrl, token: "tok" };
		const { id, resumed } = await ensureServerSession(client, { resumeId: "sess-1" });
		expect(id).toBe("sess-1");
		expect(resumed).toBe(true);
		expect(received[0]).toMatchObject({ method: "GET", path: "/api/v1/sessions/sess-1" });
	});

	it("ensureServerSession picks the most recent session in cwd for --continue", async () => {
		const client = { baseUrl, token: "tok" };
		const { id, resumed } = await ensureServerSession(client, { cwd: "/tmp", resumeRequested: true });
		expect(id).toBe("sess-1"); // newer than old-1
		expect(resumed).toBe(true);
		expect(received[0]).toMatchObject({ method: "GET", path: "/api/v1/sessions" });
	});

	it("ensureServerSession creates a fresh session without resume flags", async () => {
		const client = { baseUrl, token: "tok" };
		const { id, resumed } = await ensureServerSession(client, { cwd: "/other" });
		expect(id).toBe("sess-1");
		expect(resumed).toBe(false);
		expect(received[0]).toMatchObject({ method: "POST", path: "/api/v1/sessions" });
	});
});

describe("ensureServerClient", () => {
	let realHome: string | undefined;
	let fakeHome: string;

	beforeEach(() => {
		realHome = process.env.HOME;
		fakeHome = mkdtempSync(join(tmpdir(), "cast-server-client-test-"));
		process.env.HOME = fakeHome;
		mkdirSync(join(fakeHome, ".cast"), { recursive: true });
		vi.resetModules();
	});

	afterEach(() => {
		process.env.HOME = realHome;
		rmSync(fakeHome, { recursive: true, force: true });
	});

	it("refuses a live daemon whose state predates protocol negotiation", async () => {
		const { writeServerState } = await import("../src/server/daemon-state.ts");
		writeServerState({ pid: process.pid, port: 1337, host: "127.0.0.1", startedAt: "now", foreground: false });

		const { ensureServerClient } = await import("../src/server/client.ts");
		await expect(ensureServerClient()).rejects.toThrow("Daemon protocol mismatch");
	});
});
