import { getDb } from "./db.ts";
import type { ToolResult } from "./tools/shared.ts";

const MAX_RESULTS = 8;

export const SESSION_HISTORY_TOOL_DESCRIPTION =
	"Search previous user, assistant, and tool messages in past sessions. This is conversation history, not durable project memory: use it when the exact earlier discussion or decision is needed. By default it searches sessions from the current project; pass scope=\"global\" to search across EVERY project (the agent's whole history — 'when did we fix X anywhere').";

export interface SessionHistorySearchResult {
	sessionId: string;
	seq: number;
	role: string;
	snippet: string;
	cwd: string;
	title?: string;
	updatedAt: string;
	score: number;
}

function buildSearchQuery(raw: string): string {
	const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export function searchSessionHistory(
	cwd: string,
	query: string,
	limit = MAX_RESULTS,
	scope: "project" | "global" = "project",
): SessionHistorySearchResult[] {
	const ftsQuery = buildSearchQuery(query);
	if (!ftsQuery) return [];
	const rows = getDb()
		.prepare(
			`SELECT m.session_id, m.seq, m.role, s.cwd, s.title, s.updated_at,
				snippet(session_history_fts, 3, '', '', '…', 24) AS snippet,
				-bm25(session_history_fts) AS score
			FROM session_history_fts
			JOIN messages AS m ON m.session_id = session_history_fts.session_id AND m.seq = session_history_fts.seq
			JOIN sessions AS s ON s.id = m.session_id
			WHERE session_history_fts MATCH ? ${scope === "project" ? "AND s.cwd = ?" : ""}
			ORDER BY score DESC, s.updated_at DESC, m.seq DESC
			LIMIT ?`,
		)
		.all(
			...(scope === "project" ? [ftsQuery, cwd] : [ftsQuery]),
			Math.max(1, Math.min(limit, MAX_RESULTS)),
		) as Array<{
		session_id: string;
		seq: number;
		role: string;
		snippet: string;
		cwd: string;
		title: string | null;
		updated_at: string;
		score: number;
	}>;

	return rows.map((row) => ({
		sessionId: row.session_id,
		seq: row.seq,
		role: row.role,
		snippet: row.snippet,
		cwd: row.cwd,
		...(row.title ? { title: row.title } : {}),
		updatedAt: row.updated_at,
		score: row.score,
	}));
}

export function formatSessionHistoryToolResult(query: string, matches: SessionHistorySearchResult[]): string {
	if (matches.length === 0) {
		return `No session history matched "${query}". Try fewer, more distinctive terms or use memory for durable project facts.`;
	}
	return [
		`Found ${matches.length} session histor${matches.length === 1 ? "y result" : "y results"}, ranked by relevance:`,
		...matches.map(
			(match) =>
				`### ${match.title ?? match.sessionId} · ${match.role} · ${new Date(match.updatedAt).toISOString().slice(0, 10)}\n${match.snippet}\nSource: session_history (cwd: ${match.cwd})`,
		),
	].join("\n\n");
}

export function execSessionHistorySearch(args: Record<string, unknown>, cwd: string): ToolResult {
	const query = typeof args.query === "string" ? args.query : "";
	if (!query.trim()) return { content: "Session history search requires a non-empty query.", isError: true };
	return {
		content: formatSessionHistoryToolResult(
			query,
			searchSessionHistory(
				cwd,
				query,
				Number(args.limit) || MAX_RESULTS,
				args.scope === "global" ? "global" : "project",
			),
		),
	};
}
