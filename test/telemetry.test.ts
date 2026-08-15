import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import {
	countRecentLlmRequests,
	queryEndpointOverview,
	queryEndpointSeries,
	queryRecentLlmRequests,
	queryTelemetryOverview,
	queryTelemetrySeries,
	recordApiRequest,
	recordLlmRequest,
} from "../src/core/telemetry.ts";

describe("llm telemetry", () => {
	let root = "";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cast-telemetry-test-"));
		process.env.CAST_SESSIONS_DB = join(root, "sessions.db");
		resetDbConnectionForTests();
	});

	afterEach(() => {
		resetDbConnectionForTests();
		delete process.env.CAST_SESSIONS_DB;
		rmSync(root, { recursive: true, force: true });
	});

	it("records one row per request with tokens, cache, cost, and latency", () => {
		recordLlmRequest({
			sessionId: "s1",
			provider: "minimax",
			model: "MiniMax-M3",
			kind: "main",
			promptTokens: 10_000,
			completionTokens: 500,
			cacheReadTokens: 8_000,
			cacheWriteTokens: 0,
			cost: 0.01,
			latencyMs: 900,
		});

		const rows = queryRecentLlmRequests(10);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			provider: "minimax",
			model: "MiniMax-M3",
			kind: "main",
			promptTokens: 10_000,
			completionTokens: 500,
			cacheReadTokens: 8_000,
			latencyMs: 900,
			error: null,
		});
	});

	it("overview aggregates by provider+model including errors", () => {
		recordLlmRequest({
			provider: "minimax",
			model: "M",
			kind: "main",
			promptTokens: 100,
			completionTokens: 10,
			cost: 0.001,
		});
		recordLlmRequest({
			provider: "minimax",
			model: "M",
			kind: "main",
			promptTokens: 200,
			completionTokens: 20,
			cost: 0.002,
		});
		recordLlmRequest({ provider: "eora", model: "deepseek", kind: "error", error: "boom" });
		recordLlmRequest({ provider: "eora", model: "deepseek", kind: "retry", retries: 2, error: "timeout" });

		const rows = queryTelemetryOverview(0);
		const minimax = rows.find((r) => r.provider === "minimax");
		const eora = rows.find((r) => r.provider === "eora");
		expect(minimax).toMatchObject({ requests: 2, promptTokens: 300, completionTokens: 30, cost: 0.003, errors: 0 });
		// The retry/error rows count as requests but carry no tokens.
		expect(eora).toMatchObject({ requests: 2, errors: 1 });
	});

	it("series buckets by resolution and fills empty buckets", () => {
		const now = Date.now();
		// Force rows into the current bucket regardless of test timing.
		getDb().prepare("UPDATE llm_requests SET ts = ?").run(now);
		recordLlmRequest({ provider: "p", model: "m", kind: "main", promptTokens: 100 });

		const buckets = queryTelemetrySeries(now - 3 * 60 * 60 * 1000, 60 * 60 * 1000);
		// Query-time Date.now() may have ticked past `now`, so expect 3 or 4.
		expect(buckets.length).toBeGreaterThanOrEqual(3);
		const last = buckets[buckets.length - 1]!;
		expect(last.requests).toBe(1);
		expect(last.promptTokens).toBe(100);
		expect(buckets[0]!.requests).toBe(0);
		expect(buckets[0]!.promptTokens).toBe(0);
	});

	it("recent orders newest first and caps at the limit", () => {
		for (let i = 0; i < 5; i++) {
			recordLlmRequest({ provider: "p", model: "m", kind: "main" });
		}
		const rows = queryRecentLlmRequests(3);
		expect(rows).toHaveLength(3);
	});

	it("recent paginates with offset and total", () => {
		for (let i = 0; i < 7; i++) {
			recordLlmRequest({ provider: "p", model: "m", kind: "main" });
		}
		expect(countRecentLlmRequests()).toBe(7);
		const page = queryRecentLlmRequests(3, 3);
		expect(page).toHaveLength(3);
	});

	it("records api request latency and aggregates endpoints", () => {
		recordApiRequest({ method: "GET", path: "/api/sessions", status: 200, latencyMs: 5 });
		recordApiRequest({ method: "GET", path: "/api/sessions", status: 200, latencyMs: 15 });
		recordApiRequest({ method: "POST", path: "/api/sessions/abc/chat", status: 500, latencyMs: 900 });

		const rows = queryEndpointOverview(0);
		const sessions = rows.find((r) => r.path === "/api/sessions");
		const chat = rows.find((r) => r.path === "/api/sessions/abc/chat");
		expect(sessions).toMatchObject({ requests: 2, avgLatencyMs: 10, maxLatencyMs: 15, errors: 0 });
		expect(chat).toMatchObject({ requests: 1, errors: 1, maxLatencyMs: 900 });
	});

	it("endpoint series buckets by resolution", () => {
		const now = Date.now();
		getDb().prepare("UPDATE api_requests SET ts = ?").run(now);
		recordApiRequest({ method: "GET", path: "/api/config", status: 200, latencyMs: 2 });

		const buckets = queryEndpointSeries(now - 2 * 60 * 60 * 1000, 60 * 60 * 1000);
		const last = buckets[buckets.length - 1]!;
		expect(last.requests).toBe(1);
		expect(last.avgLatencyMs).toBe(2);
		expect(buckets[0]!.requests).toBe(0);
	});
});
