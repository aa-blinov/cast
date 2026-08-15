import type { Dirent } from "node:fs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getDb } from "./db.ts";
import { ccMemoryRoot, memoryRoot } from "./memory-files.ts";
import { memoryCcIndex, memoryReconcileOnSearch, memorySearchScoreFloor } from "./settings.ts";

const MAX_FILE_CHARS = 40_000;
const MAX_RESULTS = 8;
const FETCH_LIMIT = 50;

export type MemoryFileScope = "global" | "projects" | "sessions" | "cc";

export interface MemoryFileMatch {
	path: string;
	scope: MemoryFileScope;
	scopeId: string;
	type: string;
	snippet: string;
	score: number;
}

interface MemoryFileLocator {
	scope: MemoryFileScope;
	scopeId: string;
	type: string;
	key: string;
}

const TYPE_PATTERNS: Array<{ match: RegExp; type: string }> = [
	// MEMORY.md and spillover MEMORY-<topic>.md both classify as memory; the
	// regex is case-insensitive so the index bridges any casing during a rename.
	{ match: /^memory$/i, type: "memory" },
	{ match: /^memory-/i, type: "memory" },
	{ match: /^checkpoint$/, type: "checkpoint" },
	{ match: /^checkpoint-/, type: "checkpoint" },
	{ match: /^tasks\/[^/]+\/progress$/, type: "progress" },
	{ match: /^notes$/, type: "notes" },
];

const CC_TYPES = ["feedback", "project", "reference", "user"] as const;
type CcType = (typeof CC_TYPES)[number];

// Match <indent>type: <word> inside a YAML frontmatter block — Claude Code nests
// the type under `metadata:`, so an indented `type:` line is the signal.
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n/;
const METADATA_TYPE_RE = /^[ \t]+type:[ \t]*(\w+)[ \t]*$/m;
const CC_RELATIVE_RE = /^([^/]+)\/memory\/(.+)\.md$/;
const MEMORY_RELATIVE_RE = /^(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/;

function detectType(key: string): string {
	for (const pattern of TYPE_PATTERNS) if (pattern.match.test(key)) return pattern.type;
	return "free";
}

export function parseCcMemoryFrontmatterType(body: string): string | undefined {
	const frontmatter = body.match(FRONTMATTER_RE);
	if (!frontmatter) return undefined;
	const match = frontmatter[1]!.match(METADATA_TYPE_RE);
	if (!match) return undefined;
	const value = match[1]!;
	return (CC_TYPES as readonly string[]).includes(value) ? (value as CcType) : undefined;
}

function locateMemoryFile(relPath: string, isCc: boolean, body: string): MemoryFileLocator | undefined {
	if (isCc) {
		const match = relPath.match(CC_RELATIVE_RE);
		if (!match) return undefined;
		const [, slug, key] = match;
		return { scope: "cc", scopeId: slug!, type: parseCcMemoryFrontmatterType(body) ?? "free", key: key! };
	}
	const match = relPath.match(MEMORY_RELATIVE_RE);
	if (!match) return undefined;
	const [, scope, idMaybe, keyRaw] = match;
	const scopeId = scope === "global" ? "" : (idMaybe ?? "");
	return { scope: scope as MemoryFileScope, scopeId, type: detectType(keyRaw!), key: keyRaw! };
}

function walkMdFiles(root: string): string[] {
	const out: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile() && full.endsWith(".md")) out.push(full);
		}
	}
	return out;
}

function walkCcRoot(root: string): string[] {
	const out: string[] = [];
	let slugs: Dirent[];
	try {
		slugs = readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const slug of slugs) {
		if (!slug.isDirectory()) continue;
		const memoryDir = join(root, slug.name, "memory");
		let hasFiles = false;
		try {
			hasFiles = readdirSync(memoryDir, { withFileTypes: true }).some((entry) => entry.isFile());
		} catch {
			hasFiles = false;
		}
		if (!hasFiles) continue;
		out.push(...walkMdFiles(memoryDir));
	}
	return out;
}

/**
 * Walk the whole memory tree (project/session/global files, plus Claude Code
 * memory when enabled) and mirror every `.md` file into the `memory_files`
 * search index, pruning rows whose file disappeared. Fingerprinted by
 * size+mtime so unchanged files are skipped without a content read.
 */
export function reconcileMemoryFileIndex(includeCc: boolean): { indexed: number; pruned: number } {
	const memoryTreeRoot = memoryRoot();
	const ccRoot = ccMemoryRoot();
	const diskFiles: Array<{ path: string; isCc: boolean }> = [
		...walkMdFiles(memoryTreeRoot).map((path) => ({ path, isCc: false })),
		...(includeCc ? walkCcRoot(ccRoot).map((path) => ({ path, isCc: true })) : []),
	];
	const diskPaths = new Set(diskFiles.map((file) => file.path));
	const db = getDb();
	let pruned = 0;
	let indexed = 0;
	db.exec("BEGIN IMMEDIATE");
	try {
		const rows = db.prepare("SELECT path FROM memory_files").all() as Array<{ path: string }>;
		const remove = db.prepare("DELETE FROM memory_files WHERE path = ?");
		for (const row of rows) {
			if (diskPaths.has(row.path)) continue;
			remove.run(row.path);
			pruned++;
		}
		const existing = db.prepare("SELECT path, fingerprint FROM memory_files").all() as Array<{
			path: string;
			fingerprint: string;
		}>;
		const existingFingerprint = new Map(existing.map((row) => [row.path, row.fingerprint]));
		const upsert = db.prepare(`
			INSERT INTO memory_files (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET
				scope = excluded.scope,
				scope_id = excluded.scope_id,
				type = excluded.type,
				body = excluded.body,
				fingerprint = excluded.fingerprint,
				last_indexed_at = excluded.last_indexed_at
		`);
		for (const file of diskFiles) {
			let stat: import("node:fs").Stats | undefined;
			try {
				stat = statSync(file.path);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			const fingerprint = `${stat.size}:${stat.mtimeMs}`;
			if (existingFingerprint.get(file.path) === fingerprint) continue;
			let body = "";
			try {
				body = readFileSync(file.path, "utf8").slice(0, MAX_FILE_CHARS);
			} catch {
				continue;
			}
			const root = file.isCc ? ccRoot : memoryTreeRoot;
			const locator = locateMemoryFile(relative(root, file.path), file.isCc, body);
			if (!locator) continue;
			upsert.run(file.path, locator.scope, locator.scopeId, locator.type, body, fingerprint, Date.now());
			indexed++;
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return { indexed, pruned };
}

export function buildMemoryFilesSearchQuery(raw: string): string {
	const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? [];
	return [...new Set(tokens)].map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export interface MemoryFileSearchOptions {
	scope?: MemoryFileScope;
	scopeId?: string;
	type?: string;
	limit?: number;
	includeCc?: boolean;
	/** project_id hash of the querying cwd — scopes the projects/default branch. */
	projectId?: string;
	/** Session ids belonging to the querying project; their files join the projects branch. */
	projectSessionIds?: string[];
}

/**
 * BM25 search over every memory file (MEMORY.md, spillover MEMORY-<topic>.md,
 * session checkpoint/notes/tasks, global memory, and Claude Code memory when
 * enabled). The index is reconciled from disk on demand.
 */
export function searchMemoryFiles(query: string, options: MemoryFileSearchOptions = {}): MemoryFileMatch[] {
	const includeCc = options.includeCc ?? memoryCcIndex();
	if (memoryReconcileOnSearch()) reconcileMemoryFileIndex(includeCc);
	const ftsQuery = buildMemoryFilesSearchQuery(query);
	if (!ftsQuery) return [];
	const resultLimit = Math.max(1, Math.min(options.limit ?? MAX_RESULTS, MAX_RESULTS));
	const fetchLimit = Math.min(resultLimit * 3, FETCH_LIMIT);
	const where = ["memory_files_fts MATCH ?"];
	const parameters: string[] = [ftsQuery];
	if (options.scope === "sessions" || options.scope === "cc" || options.scope === "global") {
		where.push("mf.scope = ?");
		parameters.push(options.scope);
		if (options.scopeId) {
			where.push("mf.scope_id = ?");
			parameters.push(options.scopeId);
		}
	} else {
		// projects / default: this project's spillover files plus the memory files
		// of this project's sessions (checkpoint/notes/task progress).
		const clauses: string[] = [];
		if (options.projectId) {
			clauses.push("(mf.scope = 'projects' AND mf.scope_id = ? AND mf.path NOT LIKE '%/MEMORY.md')");
			parameters.push(options.projectId);
		}
		if (options.projectSessionIds && options.projectSessionIds.length > 0) {
			clauses.push(
				`(mf.scope = 'sessions' AND mf.scope_id IN (${options.projectSessionIds.map(() => "?").join(",")}))`,
			);
			parameters.push(...options.projectSessionIds);
		}
		// Without a project context the query spans the whole memory tree.
		if (clauses.length > 0) where.push(`(${clauses.join(" OR ")})`);
	}
	if (options.type) {
		where.push("mf.type = ?");
		parameters.push(options.type);
	}
	const rows = getDb()
		.prepare(`
			SELECT mf.path, mf.scope, mf.scope_id, mf.type,
			       snippet(memory_files_fts, 0, '<<', '>>', '...', 32) AS snippet,
			       bm25(memory_files_fts) AS score
			FROM memory_files_fts
			JOIN memory_files AS mf ON mf.id = memory_files_fts.rowid
			WHERE ${where.join(" AND ")}
			ORDER BY score
			LIMIT ?
		`)
		.all(...parameters, fetchLimit) as Array<{
		path: string;
		scope: MemoryFileScope;
		scope_id: string;
		type: string;
		snippet: string;
		score: number;
	}>;

	const mapped = rows.map((row) => ({
		path: row.path,
		scope: row.scope,
		scopeId: row.scope_id,
		type: row.type,
		snippet: row.snippet.replaceAll("<<", "").replaceAll(">>", "").replaceAll(sep, "/").trim(),
		score: -row.score,
	}));
	if (mapped.length === 0) return [];
	const floorRatio = memorySearchScoreFloor();
	const topScore = mapped[0]!.score;
	const cutoff = floorRatio > 0 ? topScore * floorRatio : Number.NEGATIVE_INFINITY;
	return mapped.filter((row, index) => index === 0 || row.score >= cutoff).slice(0, resultLimit);
}
