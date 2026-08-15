import type { DatabaseSync, StatementSync } from "node:sqlite";
import { getDb } from "./db.ts";

// ============================================================================
// LLM request telemetry — append-only analytics for the web dashboard.
// One row per LLM request / retry / error, keyed by timestamp so the
// dashboard can build provider/model cuts and time series without touching
// `messages` or `session_events`. Rows are pruned by age.
// ============================================================================

export type LlmRequestKind = "main" | "subagent" | "background" | "retry" | "error";

/** Coarse classification of retry/error rows, derived from the message text. */
export type LlmErrorType =
	| "vision"
	| "overflow"
	| "quota"
	| "moderation"
	| "upstream"
	| "rate-limit"
	| "auth"
	| "doom-loop"
	| "empty-response"
	| "other";

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
	/** Time to first streamed token, when the provider streamed. */
	ttftMs?: number;
	retries?: number;
	error?: string;
	errorType?: LlmErrorType;
	/** Model context window (tokens) — for context-utilization metrics. */
	contextWindow?: number;
	/** One user request spans several completions; clientMessageId groups them. */
	turnId?: string;
}

// Classify error/retry messages into a small taxonomy for the reliability tab.
const ERROR_TYPE_PATTERNS: Array<[LlmErrorType, RegExp]> = [
	["vision", /image|vision|image_url/i],
	["overflow", /context|token.*exceed|too long|context_length/i],
	["quota", /quota|billing|insufficient_quota|out of budget/i],
	["moderation", /moderation|content.?policy|content_filter|refus|risk control|安全|敏感/i],
	["upstream", /upstream|stream_interrupted|provider|server_error|overloaded|timeout/i],
	["rate-limit", /rate.?limit|429|too many requests/i],
	["auth", /401|403|api.?key|unauthorized|forbidden|permission/i],
];

export function classifyLlmError(message: string | undefined): LlmErrorType {
	if (!message) return "other";
	for (const [type, pattern] of ERROR_TYPE_PATTERNS) {
		if (pattern.test(message)) return type;
	}
	return "other";
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
			  cache_read_tokens, cache_write_tokens, cost, latency_ms, ttft_ms, retries, error, error_type, context_window, turn_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		record.ttftMs ?? null,
		record.retries ?? 0,
		record.error ?? null,
		record.errorType ?? (record.error ? classifyLlmError(record.error) : null),
		record.contextWindow ?? null,
		record.turnId ?? null,
	);
	prune();
}

// ── Tool calls ──────────────────────────────────────────────────────────

let toolInsertStmt: StatementSync | null = null;
let toolPreparedDb: DatabaseSync | null = null;

function getToolInsertStmt(): StatementSync {
	const db = getDb();
	if (!toolInsertStmt || toolPreparedDb !== db) {
		toolInsertStmt = db.prepare(
			"INSERT INTO tool_calls (ts, session_id, tool_name, is_error, latency_ms, turn_id) VALUES (?, ?, ?, ?, ?, ?)",
		);
		toolPreparedDb = db;
	}
	return toolInsertStmt;
}

export function recordToolCall(
	sessionId: string | undefined,
	toolName: string,
	isError: boolean,
	latencyMs?: number,
	turnId?: string,
): void {
	getToolInsertStmt().run(Date.now(), sessionId ?? null, toolName, isError ? 1 : 0, latencyMs ?? null, turnId ?? null);
}

// ── Compactions ─────────────────────────────────────────────────────────

let compactionInsertStmt: StatementSync | null = null;
let compactionPreparedDb: DatabaseSync | null = null;

function getCompactionInsertStmt(): StatementSync {
	const db = getDb();
	if (!compactionInsertStmt || compactionPreparedDb !== db) {
		compactionInsertStmt = db.prepare(
			"INSERT INTO compactions (ts, session_id, messages_compacted, tokens_before) VALUES (?, ?, ?, ?)",
		);
		compactionPreparedDb = db;
	}
	return compactionInsertStmt;
}

export function recordLlmCompaction(
	sessionId: string | undefined,
	messagesCompacted: number,
	tokensBefore: number,
): void {
	getCompactionInsertStmt().run(Date.now(), sessionId ?? null, messagesCompacted, tokensBefore);
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
				SUM(CASE WHEN kind IN ('main','subagent','background') THEN 1 ELSE 0 END) AS requests,
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
			HAVING requests > 0
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
				SUM(CASE WHEN kind IN ('main','subagent','background') THEN 1 ELSE 0 END) AS requests,
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

/** Global mean latency over usage rows since `sinceMs` — for KPIs; a mean of
 * per-group means (as the overview returns) is biased toward small groups. */
export function queryLlmAvgLatency(sinceMs: number): number | null {
	const row = getDb()
		.prepare(
			`SELECT AVG(latency_ms) AS a FROM llm_requests
			 WHERE ts >= ? AND kind IN ('main','subagent','background') AND latency_ms IS NOT NULL`,
		)
		.get(sinceMs);
	const v = (row as { a: number | null }).a;
	return v != null ? Math.round(v) : null;
}

/** Global mean latency over api_requests since `sinceMs`. */
export function queryEndpointAvgLatency(sinceMs: number): number | null {
	const row = getDb()
		.prepare(`SELECT AVG(latency_ms) AS a FROM api_requests WHERE ts >= ? AND latency_ms IS NOT NULL`)
		.get(sinceMs);
	const v = (row as { a: number | null }).a;
	return v != null ? Math.round(v) : null;
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

export function queryRecentLlmRequests(limit = 50, offset = 0, sinceMs?: number): RecentLlmRequest[] {
	const where = sinceMs !== undefined ? "WHERE ts >= ?" : "";
	const rows = getDb()
		.prepare(
			`SELECT ts, session_id, provider, model, kind, prompt_tokens, completion_tokens,
			        cache_read_tokens, cache_write_tokens, latency_ms, error
			 FROM llm_requests ${where}
			 ORDER BY id DESC LIMIT ? OFFSET ?`,
		)
		.all(...(sinceMs !== undefined ? [sinceMs, limit, offset] : [limit, offset]));
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

/** Total llm_requests rows since `sinceMs` (for pagination page counts). */
export function countRecentLlmRequests(sinceMs?: number): number {
	const where = sinceMs !== undefined ? "WHERE ts >= ?" : "";
	const row = getDb()
		.prepare(`SELECT COUNT(*) AS n FROM llm_requests ${where}`)
		.get(...(sinceMs !== undefined ? [sinceMs] : []));
	return Number((row as { n: number }).n);
}

// ── Reliability ─────────────────────────────────────────────────────────

export interface ReliabilityOverview {
	errorTypes: Array<{ errorType: string; count: number }>;
	retries: number;
	requests: number;
	refusals: number;
}

/** Error-type distribution + retry/refusal counts since `sinceMs`. */
export function queryReliabilityOverview(sinceMs: number): ReliabilityOverview {
	const db = getDb();
	const types = db
		.prepare(
			`SELECT COALESCE(error_type, 'other') AS t, COUNT(*) AS n
			 FROM llm_requests WHERE ts >= ? AND (kind = 'error' OR kind = 'retry')
			 GROUP BY t ORDER BY n DESC`,
		)
		.all(sinceMs);
	const retries = db.prepare(`SELECT COUNT(*) AS n FROM llm_requests WHERE ts >= ? AND kind = 'retry'`).get(sinceMs);
	const refusals = db
		.prepare(`SELECT COUNT(*) AS n FROM llm_requests WHERE ts >= ? AND kind = 'error' AND error_type = 'moderation'`)
		.get(sinceMs);
	const requests = db
		.prepare(`SELECT COUNT(*) AS n FROM llm_requests WHERE ts >= ? AND kind IN ('main','subagent','background')`)
		.get(sinceMs);
	return {
		errorTypes: (types as Array<{ t: string; n: number }>).map((r) => ({ errorType: r.t, count: r.n })),
		retries: Number((retries as { n: number }).n),
		requests: Number((requests as { n: number }).n),
		refusals: Number((refusals as { n: number }).n),
	};
}

// ── Context & lifecycle ─────────────────────────────────────────────────

export interface CompactionOverview {
	count: number;
	messagesCompacted: number;
	tokensBefore: number;
}

export function queryCompactionOverview(sinceMs: number): CompactionOverview {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS count, COALESCE(SUM(messages_compacted),0) AS messages, COALESCE(SUM(tokens_before),0) AS tokens
			 FROM compactions WHERE ts >= ?`,
		)
		.get(sinceMs);
	const r = row as { count: number; messages: number; tokens: number };
	return { count: r.count, messagesCompacted: r.messages, tokensBefore: r.tokens };
}

export interface ContextUtilization {
	avgPromptTokens: number | null;
	avgUtilizationPct: number | null;
}

export function queryContextUtilization(sinceMs: number): ContextUtilization {
	const row = getDb()
		.prepare(
			`SELECT AVG(prompt_tokens) AS avg_prompt, AVG(prompt_tokens * 1.0 / context_window) AS util
			 FROM llm_requests WHERE ts >= ? AND context_window IS NOT NULL AND context_window > 0`,
		)
		.get(sinceMs);
	const r = row as { avg_prompt: number | null; util: number | null };
	return {
		avgPromptTokens: r.avg_prompt,
		avgUtilizationPct: r.util != null ? Math.round(r.util * 100) : null,
	};
}

// ── Tool usage ──────────────────────────────────────────────────────────

export interface ToolUsageRow {
	toolName: string;
	count: number;
	errors: number;
	avgLatencyMs: number | null;
}

export function queryToolUsage(sinceMs: number, limit = 15): ToolUsageRow[] {
	const rows = getDb()
		.prepare(
			`SELECT tool_name, COUNT(*) AS count, SUM(is_error) AS errors, AVG(latency_ms) AS avg_latency
			 FROM tool_calls WHERE ts >= ?
			 GROUP BY tool_name ORDER BY count DESC LIMIT ?`,
		)
		.all(sinceMs, limit);
	return (rows as Array<{ tool_name: string; count: number; errors: number; avg_latency: number | null }>).map(
		(r) => ({
			toolName: r.tool_name,
			count: r.count,
			errors: r.errors,
			avgLatencyMs: r.avg_latency != null ? Math.round(r.avg_latency) : null,
		}),
	);
}

/** Count of file-modifying tool calls (write/edit) since `sinceMs`. */
export function queryFileEdits(sinceMs: number): number {
	const row = getDb()
		.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ? AND tool_name IN ('write','edit')")
		.get(sinceMs);
	return Number((row as { n: number }).n);
}

/** p50/p95/p99 over usage-row decode latencies since `sinceMs`. */
export function queryLlmLatencyPercentiles(sinceMs: number): {
	p50: number | null;
	p95: number | null;
	p99: number | null;
} {
	const db = getDb();
	const row = db
		.prepare(
			`WITH l AS (
				SELECT latency_ms FROM llm_requests
				WHERE ts >= ? AND kind IN ('main','subagent','background') AND latency_ms IS NOT NULL
				ORDER BY latency_ms
			)
			SELECT
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.5 AS INTEGER) FROM l)) AS p50,
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.95 AS INTEGER) FROM l)) AS p95,
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.99 AS INTEGER) FROM l)) AS p99`,
		)
		.get(sinceMs);
	const r = row as { p50: number | null; p95: number | null; p99: number | null };
	return {
		p50: r.p50 != null ? Math.round(r.p50) : null,
		p95: r.p95 != null ? Math.round(r.p95) : null,
		p99: r.p99 != null ? Math.round(r.p99) : null,
	};
}

/** p50/p95/p99 over endpoint latencies since `sinceMs`. */
export function queryEndpointLatencyPercentiles(sinceMs: number): {
	p50: number | null;
	p95: number | null;
	p99: number | null;
} {
	const db = getDb();
	const row = db
		.prepare(
			`WITH l AS (
				SELECT latency_ms FROM api_requests WHERE ts >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms
			)
			SELECT
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.5 AS INTEGER) FROM l)) AS p50,
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.95 AS INTEGER) FROM l)) AS p95,
				(SELECT latency_ms FROM l LIMIT 1 OFFSET (SELECT CAST(COUNT(*) * 0.99 AS INTEGER) FROM l)) AS p99`,
		)
		.get(sinceMs);
	const r = row as { p50: number | null; p95: number | null; p99: number | null };
	return {
		p50: r.p50 != null ? Math.round(r.p50) : null,
		p95: r.p95 != null ? Math.round(r.p95) : null,
		p99: r.p99 != null ? Math.round(r.p99) : null,
	};
}

/** Average model throughput (completion tokens / decode seconds) since `sinceMs`. */
export function queryTokensPerSecond(sinceMs: number): number | null {
	const row = getDb()
		.prepare(
			`SELECT AVG(completion_tokens * 1000.0 / latency_ms) AS tps
			 FROM llm_requests WHERE ts >= ? AND kind IN ('main','subagent','background')
			   AND latency_ms IS NOT NULL AND latency_ms > 0`,
		)
		.get(sinceMs);
	const v = (row as { tps: number | null }).tps;
	return v != null ? Math.round(v) : null;
}

// ── Memory maintenance ──────────────────────────────────────────────────

export interface MemoryMaintenanceRecord {
	sessionId?: string;
	kind: "dream" | "distill";
	status: "completed" | "failed";
	entriesStored?: number;
	entriesRemoved?: number;
	usageTokens?: number;
}

let memoryInsertStmt: StatementSync | null = null;
let memoryPreparedDb: DatabaseSync | null = null;

function getMemoryInsertStmt(): StatementSync {
	const db = getDb();
	if (!memoryInsertStmt || memoryPreparedDb !== db) {
		memoryInsertStmt = db.prepare(
			"INSERT INTO memory_maintenance (ts, session_id, kind, status, entries_stored, entries_removed, usage_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		memoryPreparedDb = db;
	}
	return memoryInsertStmt;
}

export function recordMemoryMaintenance(record: MemoryMaintenanceRecord): void {
	getMemoryInsertStmt().run(
		Date.now(),
		record.sessionId ?? null,
		record.kind,
		record.status,
		record.entriesStored ?? null,
		record.entriesRemoved ?? null,
		record.usageTokens ?? null,
	);
}

export interface MemoryMaintenanceRow {
	kind: string;
	status: string;
	count: number;
}

export interface MemoryMaintenanceOverview {
	runs: MemoryMaintenanceRow[];
	entriesStored: number;
	usageTokens: number;
}

/** Per-kind/status maintenance runs, total entries written, and LLM tokens
 * spent on maintenance since `sinceMs`. */
export function queryMemoryMaintenance(sinceMs: number): MemoryMaintenanceOverview {
	const db = getDb();
	const runs = db
		.prepare(
			"SELECT kind, status, COUNT(*) AS count FROM memory_maintenance WHERE ts >= ? GROUP BY kind, status ORDER BY kind",
		)
		.all(sinceMs);
	const totals = db
		.prepare(
			"SELECT SUM(entries_stored) AS stored, SUM(usage_tokens) AS tokens FROM memory_maintenance WHERE ts >= ? AND status = 'completed'",
		)
		.get(sinceMs);
	return {
		runs: (runs as Array<{ kind: string; status: string; count: number }>).map((r) => ({
			kind: r.kind,
			status: r.status,
			count: r.count,
		})),
		entriesStored: Number((totals as { stored: number | null }).stored ?? 0),
		usageTokens: Number((totals as { tokens: number | null }).tokens ?? 0),
	};
}

/** Memory tool (search) usage from the tool_calls table. */
export function queryMemoryToolUsage(sinceMs: number): { count: number; errors: number; avgLatencyMs: number | null } {
	const row = getDb()
		.prepare(
			"SELECT COUNT(*) AS count, SUM(is_error) AS errors, AVG(latency_ms) AS avg_latency FROM tool_calls WHERE ts >= ? AND tool_name = 'memory'",
		)
		.get(sinceMs);
	const r = row as { count: number; errors: number; avg_latency: number | null };
	return { count: r.count, errors: r.errors, avgLatencyMs: r.avg_latency != null ? Math.round(r.avg_latency) : null };
}

// ── Session analytics ───────────────────────────────────────────────────

export interface SessionAnalytics {
	sessions: number;
	avgMessagesPerSession: number | null;
}

export function querySessionAnalytics(sinceMs: number): SessionAnalytics {
	const sessionsRow = getDb()
		.prepare("SELECT COUNT(*) AS n FROM sessions WHERE created_at >= ?")
		.get(new Date(sinceMs).toISOString());
	const msgsRow = getDb()
		.prepare("SELECT AVG(c) AS avg_msgs FROM (SELECT COUNT(*) AS c FROM messages GROUP BY session_id)")
		.get();
	return {
		sessions: Number((sessionsRow as { n: number }).n),
		avgMessagesPerSession: Number((msgsRow as { avg_msgs: number | null }).avg_msgs) || null,
	};
}

// ── Turn analytics ───────────────────────────────────────────────────────

export interface TurnMetrics {
	turns: number;
	avgToolCallsPerTurn: number | null;
	avgTokensPerTurn: number | null;
	avgDurationMs: number | null;
}

const TURN_KINDS = "('main','subagent','background')";

/** Per-user-request aggregates: one turn spans several LLM completions and
 * tool calls, grouped by turn_id (the client message id). */
export function queryTurnMetrics(sinceMs: number): TurnMetrics {
	const db = getDb();
	const turnsRow = db
		.prepare(
			`SELECT COUNT(*) AS n FROM (SELECT DISTINCT turn_id FROM llm_requests
			 WHERE ts >= ? AND turn_id IS NOT NULL AND kind IN ${TURN_KINDS})`,
		)
		.get(sinceMs);
	const toolsRow = db
		.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE ts >= ? AND turn_id IS NOT NULL")
		.get(sinceMs);
	const tokensRow = db
		.prepare(
			`SELECT AVG(v) AS a FROM (SELECT SUM(prompt_tokens + completion_tokens) AS v FROM llm_requests
			 WHERE ts >= ? AND turn_id IS NOT NULL AND kind IN ${TURN_KINDS} GROUP BY turn_id)`,
		)
		.get(sinceMs);
	const durRow = db
		.prepare(
			`SELECT AVG(v) AS a FROM (SELECT MAX(ts) - MIN(ts) AS v FROM llm_requests
			 WHERE ts >= ? AND turn_id IS NOT NULL AND kind IN ${TURN_KINDS} GROUP BY turn_id)`,
		)
		.get(sinceMs);
	const num = (v: unknown): number | null => (v != null ? Math.round(Number(v)) : null);
	const turns = Number((turnsRow as { n: number }).n);
	const totalTools = Number((toolsRow as { n: number }).n);
	return {
		turns,
		avgToolCallsPerTurn: turns > 0 ? Math.round(totalTools / turns) : null,
		avgTokensPerTurn: num((tokensRow as { a: number | null }).a),
		avgDurationMs: num((durRow as { a: number | null }).a),
	};
}
