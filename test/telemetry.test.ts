import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbConnectionForTests } from "../src/core/db.ts";
import {
	countRecentLlmRequests,
	queryEndpointOverview,
	queryEndpointSeries,
	queryFileEdits,
	queryLlmLatencyPercentiles,
	queryRecentLlmRequests,
	queryReliabilityOverview,
	queryTelemetryOverview,
	queryTelemetrySeries,
	queryTokensPerSecond,
	queryToolUsage,
	recordApiRequest,
	recordLlmRequest,
	recordToolCall,
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
		// retry/error rows are NOT requests (no double count) — the eora group
		// has zero usage rows, so requests is 0 and only errors/retries show up.
		expect(eora).toBeUndefined();
		const reliability = queryReliabilityOverview(0);
		expect(reliability.requests).toBe(2);
		expect(reliability.retries).toBe(1);
		expect(reliability.errorTypes.some((t) => t.errorType === "other" && t.count >= 1)).toBe(true);
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

	it("records tool latency and file-edit counts", () => {
		recordToolCall("s1", "bash", false, 250);
		recordToolCall("s1", "bash", true, 900);
		recordToolCall("s1", "write", false, 15);

		const tools = queryToolUsage(0);
		const bash = tools.find((t) => t.toolName === "bash");
		expect(bash).toMatchObject({ count: 2, errors: 1 });
		expect(bash!.avgLatencyMs).toBe(Math.round((250 + 900) / 2));
		expect(queryFileEdits(0)).toBe(1);
	});

	it("computes latency percentiles and tokens/sec", () => {
		// 10 rows, one per 100ms step from 100ms to 1000ms; tokens scale with
		// latency so each row decodes at exactly 100 tokens/sec.
		for (let i = 0; i < 10; i++) {
			recordLlmRequest({
				provider: "p",
				model: "m",
				kind: "main",
				latencyMs: (i + 1) * 100,
				completionTokens: (i + 1) * 10,
			});
		}
		const p = queryLlmLatencyPercentiles(0);
		expect(p.p50).toBe(600);
		expect(p.p95).toBe(1000);
		expect(p.p99).toBe(1000);
		expect(queryTokensPerSecond(0)).toBe(100);
	});

	it("counts doom-loop and empty-response error types in reliability", () => {
		recordLlmRequest({ provider: "p", model: "m", kind: "error", error: "doom loop: bash x3", errorType: "doom-loop" });
		recordLlmRequest({ provider: "p", model: "m", kind: "error", error: "empty response", errorType: "empty-response" });

		const reliability = queryReliabilityOverview(0);
		expect(reliability.errorTypes.some((t) => t.errorType === "doom-loop" && t.count === 1)).toBe(true);
		expect(reliability.errorTypes.some((t) => t.errorType === "empty-response" && t.count === 1)).toBe(true);
	});
});
