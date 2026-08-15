import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getDb } from "./db.ts";

// ============================================================================
// LLM request telemetry — append-only analytics for the web dashboard.
// One row per LLM request / retry / error, keyed by timestamp so the
// dashboard can build provider/model cuts and time series without touching
// `messages` or `session_events`. Rows are pruned by age.
// ============================================================================

export type LlmRequestKind = "main" | "subagent" | "background" | "retry" | "error";

export interface LlmRequestRecord {
	sessionId?: string;
	provider?: string;
	model?: string;
	kind: LlmRequestKind;
	promptTokens?: number;
	completionTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
	/** Decode time for a completed completion; undefined for retry/error rows. */
	latencyMs?: number;
	retries?: number;
	error?: string;
}

const TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

// Prepared lazily and re-prepared when the DB connection changes (tests close
// and reopen it via resetDbConnectionForTests). The hot path — one insert per
// LLM request, fired from the bridge's event handler — pays only for run(),
// not for re-preparing the statement on every request.
let insertStmt: StatementSync | null = null;
let preparedDb: DatabaseSync | null = null;

function getInsertStmt(): StatementSync {
	const db = getDb();
	if (!insertStmt || preparedDb !== db) {
		insertStmt = db.prepare(
			`INSERT INTO llm_requests
			 (ts, session_id, provider, model, kind, prompt_tokens, completion_tokens,
			  cache_read_tokens, cache_write_tokens, cost, latency_ms, ttft_ms, retries, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		preparedDb = db;
	}
	return insertStmt;
}

function prune(): void {
	const now = Date.now();
	// Prune at most once a minute — cheap guard against running a DELETE on
	// every single request.
	if (now - lastPruneAt < 60_000) return;
	lastPruneAt = now;
	getDb()
		.prepare("DELETE FROM llm_requests WHERE ts < ?")
		.run(now - TELEMETRY_RETENTION_MS);
}

export function recordLlmRequest(record: LlmRequestRecord): void {
	getInsertStmt().run(
		Date.now(),
		record.sessionId ?? null,
		record.provider ?? null,
		record.model ?? null,
		record.kind,
		record.promptTokens ?? 0,
		record.completionTokens ?? 0,
		record.cacheReadTokens ?? 0,
		record.cacheWriteTokens ?? 0,
		record.cost ?? null,
		record.latencyMs ?? null,
		null,
		record.retries ?? 0,
		record.error ?? null,
	);
	prune();
}

export interface TelemetryOverviewRow {
	provider: string;
	model: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	avgLatencyMs: number | null;
	errors: number;
}

/** Aggregate all requests since `sinceMs` grouped by provider + model. */
export function queryTelemetryOverview(sinceMs?: number): TelemetryOverviewRow[] {
	const db = getDb();
	const where = sinceMs !== undefined ? "WHERE ts >= ?" : "";
	const rows = db
		.prepare(
			`SELECT provider, model,
				COUNT(*) AS requests,
				SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(prompt_tokens) AS prompt_tokens,
				SUM(completion_tokens) AS completion_tokens,
				SUM(cache_read_tokens) AS cache_read_tokens,
				SUM(cache_write_tokens) AS cache_write_tokens,
				COALESCE(SUM(cost), 0) AS cost,
				AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency
			FROM llm_requests
			${where}
			GROUP BY provider, model
			ORDER BY requests DESC`,
		)
		.all(...(sinceMs !== undefined ? [sinceMs] : []));
	return rows.map((r) => ({
		provider: (r as { provider: string | null }).provider ?? "unknown",
		model: (r as { model: string | null }).model ?? "unknown",
		requests: (r as { requests: number }).requests,
		promptTokens: (r as { prompt_tokens: number }).prompt_tokens,
		completionTokens: (r as { completion_tokens: number }).completion_tokens,
		cacheReadTokens: (r as { cache_read_tokens: number }).cache_read_tokens,
		cacheWriteTokens: (r as { cache_write_tokens: number }).cache_write_tokens,
		cost: (r as { cost: number }).cost,
		avgLatencyMs: (r as { avg_latency: number | null }).avg_latency,
		errors: (r as { errors: number }).errors,
	}));
}

export interface TelemetrySeriesBucket {
	ts: number;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	errors: number;
	avgLatencyMs: number | null;
}

/** Bucketed time series over `sinceMs` (e.g. 24h) at `resolutionMs` (e.g. 1h). */
export function queryTelemetrySeries(sinceMs: number, resolutionMs: number): TelemetrySeriesBucket[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT
				CAST(((ts - ?) / ?) AS INTEGER) AS bucket,
				COUNT(*) AS requests,
				SUM(CASE WHEN kind = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(prompt_tokens) AS prompt_tokens,
				SUM(completion_tokens) AS completion_tokens,
				SUM(cache_read_tokens) AS cache_read_tokens,
				SUM(cache_write_tokens) AS cache_write_tokens,
				AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avg_latency
			FROM llm_requests
			WHERE ts >= ?
			GROUP BY bucket
			ORDER BY bucket`,
		)
		.all(sinceMs, resolutionMs, sinceMs);
	const byBucket = new Map<number, TelemetrySeriesBucket>();
	for (const r of rows) {
		const bucket = Number((r as { bucket: number }).bucket);
		byBucket.set(bucket, {
			ts: sinceMs + bucket * resolutionMs,
			requests: (r as { requests: number }).requests,
			promptTokens: (r as { prompt_tokens: number }).prompt_tokens,
			completionTokens: (r as { completion_tokens: number }).completion_tokens,
			cacheReadTokens: (r as { cache_read_tokens: number }).cache_read_tokens,
			cacheWriteTokens: (r as { cache_write_tokens: number }).cache_write_tokens,
			errors: (r as { errors: number }).errors,
			avgLatencyMs: (r as { avg_latency: number | null }).avg_latency,
		});
	}
	// Fill empty buckets so the chart axis is continuous.
	const out: TelemetrySeriesBucket[] = [];
	const count = Math.max(1, Math.ceil((Date.now() - sinceMs) / resolutionMs));
	for (let i = 0; i < count; i++) {
		out.push(
			byBucket.get(i) ?? {
				ts: sinceMs + i * resolutionMs,
				requests: 0,
				promptTokens: 0,
				completionTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				errors: 0,
				avgLatencyMs: null,
			},
		);
	}
	return out;
}

// ── System / endpoint responsiveness ────────────────────────────────────

export interface ApiRequestRecord {
	method: string;
	path: string;
	status: number;
	latencyMs: number;
}

let apiInsertStmt: StatementSync | null = null;
let apiPreparedDb: DatabaseSync | null = null;

function getApiInsertStmt(): StatementSync {
	const db = getDb();
	if (!apiInsertStmt || apiPreparedDb !== db) {
		apiInsertStmt = db.prepare(
			"INSERT INTO api_requests (ts, method, path, status, latency_ms) VALUES (?, ?, ?, ?, ?)",
		);
		apiPreparedDb = db;
	}
	return apiInsertStmt;
}

export function recordApiRequest(record: ApiRequestRecord): void {
	getApiInsertStmt().run(Date.now(), record.method, record.path, record.status, record.latencyMs);
}

export interface EndpointOverviewRow {
	path: string;
	method: string;
	requests: number;
	avgLatencyMs: number | null;
	maxLatencyMs: number | null;
	errors: number;
}

/** Aggregate /api/* requests since `sinceMs` grouped by path + method. */
export function queryEndpointOverview(sinceMs?: number): EndpointOverviewRow[] {
	const db = getDb();
	const where = sinceMs !== undefined ? "WHERE ts >= ?" : "";
	const rows = db
		.prepare(
			`SELECT path, method,
				COUNT(*) AS requests,
				SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
				AVG(latency_ms) AS avg_latency,
				MAX(latency_ms) AS max_latency
			FROM api_requests
			${where}
			GROUP BY path, method
			ORDER BY requests DESC
			LIMIT 50`,
		)
		.all(...(sinceMs !== undefined ? [sinceMs] : []));
	return rows.map((r) => {
		const x = r as {
			path: string;
			method: string;
			requests: number;
			errors: number;
			avg_latency: number | null;
			max_latency: number | null;
		};
		return {
			path: x.path,
			method: x.method,
			requests: x.requests,
			avgLatencyMs: x.avg_latency,
			maxLatencyMs: x.max_latency,
			errors: x.errors,
		};
	});
}

export interface EndpointSeriesBucket {
	ts: number;
	requests: number;
	avgLatencyMs: number | null;
	errors: number;
}

/** Bucketed latency/request series over `sinceMs` at `resolutionMs`. */
export function queryEndpointSeries(sinceMs: number, resolutionMs: number): EndpointSeriesBucket[] {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT
				CAST(((ts - ?) / ?) AS INTEGER) AS bucket,
				COUNT(*) AS requests,
				SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors,
				AVG(latency_ms) AS avg_latency
			FROM api_requests
			WHERE ts >= ?
			GROUP BY bucket
			ORDER BY bucket`,
		)
		.all(sinceMs, resolutionMs, sinceMs);
	const byBucket = new Map<number, EndpointSeriesBucket>();
	for (const r of rows) {
		const bucket = Number((r as { bucket: number }).bucket);
		byBucket.set(bucket, {
			ts: sinceMs + bucket * resolutionMs,
			requests: (r as { requests: number }).requests,
			avgLatencyMs: (r as { avg_latency: number | null }).avg_latency,
			errors: (r as { errors: number }).errors,
		});
	}
	const out: EndpointSeriesBucket[] = [];
	const count = Math.max(1, Math.ceil((Date.now() - sinceMs) / resolutionMs));
	for (let i = 0; i < count; i++) {
		out.push(byBucket.get(i) ?? { ts: sinceMs + i * resolutionMs, requests: 0, avgLatencyMs: null, errors: 0 });
	}
	return out;
}

export interface RecentLlmRequest {
	ts: number;
	sessionId: string | null;
	provider: string | null;
	model: string | null;
	kind: LlmRequestKind;
	promptTokens: number;
	completionTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	latencyMs: number | null;
	error: string | null;
}

export function queryRecentLlmRequests(limit = 50): RecentLlmRequest[] {
	const rows = getDb()
		.prepare(
			`SELECT ts, session_id, provider, model, kind, prompt_tokens, completion_tokens,
			        cache_read_tokens, cache_write_tokens, latency_ms, error
			 FROM llm_requests ORDER BY id DESC LIMIT ?`,
		)
		.all(limit);
	return rows.map((r) => {
		const x = r as {
			ts: number;
			session_id: string | null;
			provider: string | null;
			model: string | null;
			kind: LlmRequestKind;
			prompt_tokens: number;
			completion_tokens: number;
			cache_read_tokens: number;
			cache_write_tokens: number;
			latency_ms: number | null;
			error: string | null;
		};
		return {
			ts: x.ts,
			sessionId: x.session_id,
			provider: x.provider,
			model: x.model,
			kind: x.kind,
			promptTokens: x.prompt_tokens,
			completionTokens: x.completion_tokens,
			cacheReadTokens: x.cache_read_tokens,
			cacheWriteTokens: x.cache_write_tokens,
			latencyMs: x.latency_ms,
			error: x.error,
		};
	});
}
