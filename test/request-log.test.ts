import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/core/config.ts";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import { createClient, streamAndCollect } from "../src/core/llm.ts";
import { listLoggedRequests, loadLoggedRequest } from "../src/core/request-log.ts";
import { createSession, deleteSession, saveSession } from "../src/core/session.ts";

/** A provider that records every raw body and streams one short answer. */
function fakeProvider(opts: { failFirst?: boolean } = {}) {
	const bodies: string[] = [];
	let calls = 0;
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => {
			raw += c;
		});
		req.on("end", () => {
			calls++;
			if (opts.failFirst && calls === 1) {
				res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
				res.end(JSON.stringify({ error: { message: "overloaded" } }));
				return;
			}
			bodies.push(raw);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "hel" } }] });
			chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "lo" } }] });
			chunk({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			chunk({
				id: "1",
				object: "chat.completion.chunk",
				choices: [],
				usage: { prompt_tokens: 42, completion_tokens: 2, total_tokens: 44 },
			});
			res.end("data: [DONE]\n\n");
		});
	});
	return {
		bodies,
		start: () =>
			new Promise<string>((resolve) =>
				server.listen(0, "127.0.0.1", () =>
					resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`),
				),
			),
		stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function configFor(baseURL: string): AppConfig {
	return {
		baseURL,
		apiKey: "test-key",
		contextWindow: 128_000,
		maxResponseTokens: 1000,
		compactionThreshold: 0.8,
		maxToolOutputLines: 2000,
		maxToolOutputBytes: 64 * 1024,
		defaultBashTimeoutMs: 10_000,
		reasoningLevel: "off",
		reasoningParams: { body: {}, enabled: false },
		reasoningFormat: "openai-compatible",
	};
}

const tools = [
	{
		type: "function" as const,
		function: { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
	},
];

describe("request log", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-request-log-test-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});
	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("rebuilds the exact body the provider received", async () => {
		const provider = fakeProvider();
		const client = createClient(configFor(await provider.start()));
		const target = { sessionId: "s1", purpose: "turn" };
		const history = [
			{ role: "system" as const, content: "You are cast. Today is 2026-09-28." },
			{ role: "user" as const, content: "hi — в UTF-8 тоже" },
		];
		try {
			const out = await streamAndCollect(
				client,
				"m1",
				history,
				tools,
				500,
				undefined,
				undefined,
				undefined,
				{ reasoning_effort: "low" },
				undefined,
				{ prompt_cache_key: "cast:s1" },
				undefined,
				target,
			);
			expect(out.content).toBe("hello");
		} finally {
			await provider.stop();
		}

		const logged = loadLoggedRequest("s1", 1)!;
		// Same bytes, not just the same data: key order survives the round trip.
		expect(JSON.stringify(logged.body)).toBe(provider.bodies[0]);
		expect(logged.response).toEqual({ content: "hello", reasoning: "", toolCalls: [] });
		const [entry] = listLoggedRequests("s1");
		expect(entry).toMatchObject({ seq: 1, purpose: "turn", outcome: "ok", finishReason: "stop", messageCount: 2 });
		expect(entry!.usage?.promptTokens).toBe(42);
	});

	it("stores a message once however many requests carry it", async () => {
		const provider = fakeProvider();
		const client = createClient(configFor(await provider.start()));
		const target = { sessionId: "s2", purpose: "turn" };
		const history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "x".repeat(10_000) },
		];
		try {
			for (let i = 0; i < 3; i++) {
				await streamAndCollect(client, "m", history, tools, 100, ...Array(6).fill(undefined), undefined, target);
				history.push({ role: "assistant", content: "hello" }, { role: "user", content: `next ${i}` });
			}
		} finally {
			await provider.stop();
		}
		// sys, the big user message, the tool set, the assistant "hello", "next 0",
		// "next 1", and the one response all three requests got: each once, not
		// once per request.
		const blobs = getDb().prepare("SELECT COUNT(*) AS n FROM model_request_blobs WHERE session_id = ?").get("s2") as {
			n: number;
		};
		expect(blobs.n).toBe(7);
		for (let seq = 1; seq <= 3; seq++) {
			expect(JSON.stringify(loadLoggedRequest("s2", seq)!.body)).toBe(provider.bodies[seq - 1]);
		}
	});

	it("records the retries of one request and the error that ended another", async () => {
		const provider = fakeProvider({ failFirst: true });
		const client = createClient(configFor(await provider.start()));
		try {
			await streamAndCollect(client, "m", [{ role: "user", content: "a" }], [], 100, ...Array(7).fill(undefined), {
				sessionId: "s3",
				purpose: "turn",
			});
		} finally {
			await provider.stop();
		}
		const [first] = listLoggedRequests("s3");
		expect(first!.retries).toHaveLength(1);
		expect(first!.outcome).toBe("ok");

		// The provider is gone now: a connection error, logged and still thrown.
		await expect(
			streamAndCollect(
				client,
				"m",
				[{ role: "user", content: "b" }],
				[],
				100,
				AbortSignal.timeout(500),
				...Array(6).fill(undefined),
				{ sessionId: "s3", purpose: "turn" },
			),
		).rejects.toThrow();
		const second = listLoggedRequests("s3")[1]!;
		expect(second.outcome).toBe("error");
		expect(second.error).toBeTruthy();
	});

	it("goes with its session", async () => {
		const session = createSession("m", root);
		saveSession(session);
		const provider = fakeProvider();
		const client = createClient(configFor(await provider.start()));
		try {
			await streamAndCollect(client, "m", [{ role: "user", content: "a" }], [], 100, ...Array(7).fill(undefined), {
				sessionId: session.id,
				purpose: "turn",
			});
		} finally {
			await provider.stop();
		}
		expect(listLoggedRequests(session.id)).toHaveLength(1);
		deleteSession(session.id);
		expect(listLoggedRequests(session.id)).toHaveLength(0);
		const blobs = getDb()
			.prepare("SELECT COUNT(*) AS n FROM model_request_blobs WHERE session_id = ?")
			.get(session.id) as { n: number };
		expect(blobs.n).toBe(0);
	});

	it("never fails the request when the log can't be written", async () => {
		getDb().exec("DROP TABLE model_requests");
		const provider = fakeProvider();
		const client = createClient(configFor(await provider.start()));
		try {
			const out = await streamAndCollect(
				client,
				"m",
				[{ role: "user", content: "a" }],
				[],
				100,
				...Array(7).fill(undefined),
				{ sessionId: "s5", purpose: "turn" },
			);
			expect(out.content).toBe("hello");
		} finally {
			await provider.stop();
		}
	});
});
