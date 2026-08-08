import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebEvent } from "../src/server/bridge.ts";
import { createServerSession, submitServerChat, subscribeServerEvents } from "../src/server/client.ts";

// Real HTTP server standing in for the cast server daemon: exercises the
// client's fetch calls and SSE subscription against a live socket (URL
// construction, token header, JSON bodies, event-stream framing) without
// needing an actual daemon process.
describe("server client", () => {
	let server: Server;
	let baseUrl: string;
	const received: Array<{ method: string; path: string; auth?: string }> = [];

	beforeEach(async () => {
		server = createServer((req, res) => {
			received.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
			if (req.method === "POST" && req.url === "/api/sessions") {
				res.writeHead(201, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "sess-1", session: { id: "sess-1" } }));
				return;
			}
			if (req.method === "POST" && req.url === "/api/sessions/sess-1/chat") {
				res.writeHead(202, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
				return;
			}
			if (req.method === "GET" && req.url?.startsWith("/api/sessions/sess-1/events")) {
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
		expect(received[0]).toMatchObject({ method: "POST", path: "/api/sessions", auth: "Bearer tok-123" });
	});

	it("submitServerChat posts the text", async () => {
		const client = { baseUrl, token: undefined };
		await submitServerChat(client, "sess-1", "hello there");
		expect(received[0]).toMatchObject({ method: "POST", path: "/api/sessions/sess-1/chat" });
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
});
