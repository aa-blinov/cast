/**
 * The log of what each model request actually contained: every body cast
 * sent, rebuildable exactly, with how it ended. DeepSeek Harness's "model-
 * visible means logged": the session's messages say what was said, but not
 * what the model saw — the system prompt of that moment, the reminders added
 * to one request only, a history already compacted or pruned, the tool set,
 * the retries. Replaying a bad turn, or an eval, needs the request itself.
 *
 * Messages and tool sets are stored once per session, deflated, keyed by
 * hash; a request row keeps its body minus those, plus the list of hashes.
 * Consecutive requests share almost all of their messages, so a session
 * costs about one compressed copy of what it sent. Rows go with the session
 * (a trigger in migration 39). Logging never fails a request.
 */

import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { getDb } from "./db.ts";
import type { Usage } from "./llm.ts";

export interface RequestLogTarget {
	sessionId: string;
	/** What the request was for: "turn", "compaction", "memory", ... */
	purpose: string;
}

export interface LoggedRequest {
	retry(reason: string): void;
	end(outcome: {
		finishReason: string;
		usage?: Usage;
		content: string;
		reasoning: string;
		toolCalls?: Array<{ id: string; name: string; arguments: string }>;
		interrupted?: boolean;
	}): void;
	fail(error: unknown): void;
}

export interface RequestLogEntry {
	seq: number;
	purpose: string;
	startedAt: string;
	finishedAt?: string;
	outcome?: string;
	finishReason?: string;
	usage?: Usage;
	error?: string;
	retries: string[];
	messageCount: number;
}

function putBlob(sessionId: string, json: string): string {
	const hash = createHash("sha256").update(json).digest("hex").slice(0, 32);
	getDb()
		.prepare("INSERT OR IGNORE INTO model_request_blobs (session_id, hash, data) VALUES (?, ?, ?)")
		.run(sessionId, hash, deflateSync(json));
	return hash;
}

function getBlob(sessionId: string, hash: string): unknown {
	const row = getDb()
		.prepare("SELECT data FROM model_request_blobs WHERE session_id = ? AND hash = ?")
		.get(sessionId, hash) as { data: Uint8Array } | undefined;
	if (!row) throw new Error(`request log: blob ${hash} missing`);
	return JSON.parse(inflateSync(row.data).toString("utf-8"));
}

function warnOnce(error: unknown): void {
	if (warned) return;
	warned = true;
	console.error(`[cast] request log disabled for this process: ${error instanceof Error ? error.message : error}`);
}
let warned = false;

/**
 * Records a request body just before it is sent. The body's key order is kept
 * (messages and tools stay where they were, as placeholders), so the rebuilt
 * body serializes to the same string.
 */
export function logRequest(target: RequestLogTarget, params: Record<string, unknown>): LoggedRequest | undefined {
	if (warned) return undefined;
	try {
		const db = getDb();
		const { sessionId } = target;
		const messages = (params.messages as unknown[]) ?? [];
		const hashes = messages.map((m) => putBlob(sessionId, JSON.stringify(m)));
		const toolsHash = params.tools === undefined ? null : putBlob(sessionId, JSON.stringify(params.tools));
		const rest = JSON.stringify({
			...params,
			messages: null,
			...(params.tools === undefined ? {} : { tools: null }),
		});
		const { seq } = db
			.prepare(
				`INSERT INTO model_requests (session_id, seq, purpose, started_at, params_json, message_hashes, tools_hash)
				 SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ? FROM model_requests WHERE session_id = ?
				 RETURNING seq`,
			)
			.get(
				sessionId,
				target.purpose,
				new Date().toISOString(),
				rest,
				JSON.stringify(hashes),
				toolsHash,
				sessionId,
			) as {
			seq: number;
		};
		const retries: string[] = [];
		const finish = (fields: Record<string, string | null>) => {
			try {
				const cols = Object.keys(fields);
				db.prepare(
					`UPDATE model_requests SET ${cols.map((c) => `${c} = ?`).join(", ")}, finished_at = ?, retries_json = ? WHERE session_id = ? AND seq = ?`,
				).run(
					...cols.map((c) => fields[c]!),
					new Date().toISOString(),
					retries.length ? JSON.stringify(retries) : null,
					sessionId,
					seq,
				);
			} catch (error) {
				warnOnce(error);
			}
		};
		return {
			retry: (reason) => {
				retries.push(reason);
			},
			end: (o) => {
				let responseHash: string | null = null;
				try {
					responseHash = putBlob(
						sessionId,
						JSON.stringify({ content: o.content, reasoning: o.reasoning, toolCalls: o.toolCalls ?? [] }),
					);
				} catch (error) {
					warnOnce(error);
				}
				finish({
					outcome: o.interrupted ? "aborted" : "ok",
					finish_reason: o.finishReason,
					usage_json: o.usage ? JSON.stringify(o.usage) : null,
					response_hash: responseHash,
				});
			},
			fail: (error) => finish({ outcome: "error", error: error instanceof Error ? error.message : String(error) }),
		};
	} catch (error) {
		warnOnce(error);
		return undefined;
	}
}

export function listLoggedRequests(sessionId: string): RequestLogEntry[] {
	const rows = getDb()
		.prepare(
			"SELECT seq, purpose, started_at, finished_at, outcome, finish_reason, usage_json, error, retries_json, message_hashes FROM model_requests WHERE session_id = ? ORDER BY seq",
		)
		.all(sessionId) as Array<Record<string, string | number | null>>;
	return rows.map((r) => ({
		seq: r.seq as number,
		purpose: r.purpose as string,
		startedAt: r.started_at as string,
		finishedAt: (r.finished_at as string | null) ?? undefined,
		outcome: (r.outcome as string | null) ?? undefined,
		finishReason: (r.finish_reason as string | null) ?? undefined,
		usage: r.usage_json ? (JSON.parse(r.usage_json as string) as Usage) : undefined,
		error: (r.error as string | null) ?? undefined,
		retries: r.retries_json ? (JSON.parse(r.retries_json as string) as string[]) : [],
		messageCount: (JSON.parse(r.message_hashes as string) as string[]).length,
	}));
}

/** The body of request `seq`, exactly as it was sent, plus what came back. */
export function loadLoggedRequest(
	sessionId: string,
	seq: number,
): { body: Record<string, unknown>; response?: unknown } | undefined {
	const row = getDb()
		.prepare(
			"SELECT params_json, message_hashes, tools_hash, response_hash FROM model_requests WHERE session_id = ? AND seq = ?",
		)
		.get(sessionId, seq) as
		| { params_json: string; message_hashes: string; tools_hash: string | null; response_hash: string | null }
		| undefined;
	if (!row) return undefined;
	const body = JSON.parse(row.params_json) as Record<string, unknown>;
	body.messages = (JSON.parse(row.message_hashes) as string[]).map((h) => getBlob(sessionId, h));
	if (row.tools_hash) body.tools = getBlob(sessionId, row.tools_hash);
	return { body, response: row.response_hash ? getBlob(sessionId, row.response_hash) : undefined };
}
