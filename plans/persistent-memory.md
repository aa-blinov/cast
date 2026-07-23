# ADR: Persistent Memory для Cast

## Context

Cast компактирует контекст через LLM-summarization, но между сессиями не помнит ничего о проекте. Каждый новый запуск — с чистого листа. MiMo Code решает это через markdown файлы + SQLite FTS5 full-text search. У cast уже есть `node:sqlite` (Node 22+, experimental) — новые зависимости не нужны.

**Проблема:** компакция теряет детали ("какой порт у postgres?", "какой флаг использовать для production"). Проектные факты, правила, заметки агента — всё теряется между запусками.

**Цель:** кросс-сессионная память проекта с BM25-поиском, по аналогии с MiMo Code.

---

## Структура файлов

```
~/.cast/memory/
├── global/
│   └── MEMORY.md           # глобальные правила ("всегда biome", "никогда не удаляй")
├── projects/<hash>/
│   ├── MEMORY.md           # факты проекта ("port 5433", "SQLite", "esbuild")
│   └── NOTES.md            # заметки агента
└── sessions/<session-id>/
    └── checkpoint.md        # автосохранение контекста (checkpoint-writer subagent)
```

Project hash = `sha256(абсолютный_путь_к_репо).slice(0, 12)` — точно как в MiMo Code.

---

## Модули

### 1. `src/core/memory/paths.ts` (~80 строк)

Определение scope, type, парсинг путей, построение hash проекта, path traversal guard.

```typescript
import path from "node:path";
import { createHash } from "node:crypto";

export type Scope = "global" | "projects" | "sessions";

export type MemoryType =
  | "free"
  | "memory"
  | "checkpoint"
  | "progress"
  | "notes";

export interface MemoryLocator {
  scope: Scope;
  scope_id: string;
  type: MemoryType;
  key: string;
}

// Only `memory` is case-insensitive: it's the one file renamed lowercase
// memory.md → MEMORY.md, so the index must bridge both casings.
// checkpoint/tasks/notes have no legacy-casing bridge and stay exact.
const TYPE_PATTERNS: Array<{ match: RegExp; type: MemoryType }> = [
  { match: /^memory$/i, type: "memory" },
  { match: /^memory-/i, type: "memory" },
  { match: /^checkpoint$/, type: "checkpoint" },
  { match: /^checkpoint-/, type: "checkpoint" },
  { match: /^tasks\/[^/]+\/progress$/, type: "progress" },
  { match: /^tasks\/[^/]+\/notes$/, type: "notes" },
];

function detectType(key: string): MemoryType {
  for (const p of TYPE_PATTERNS) if (p.match.test(key)) return p.type;
  return "free";
}

export function parsePath(absPath: string): MemoryLocator | null {
  const m = absPath.match(
    /\/memory\/(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/
  );
  if (!m) return null;
  const [, scope, idMaybe, keyRaw] = m;
  const scope_id = scope === "global" ? "" : (idMaybe ?? "");
  const key = keyRaw;
  return { scope: scope as Scope, scope_id, type: detectType(key), key };
}

function assertSafeComponent(value: string): void {
  // Reject any segment containing ".." or starting with "/" — guards against
  // path traversal and absolute-path injection from caller-supplied scope_id/key.
  for (const segment of value.split("/")) {
    if (segment === "..")
      throw new Error(`buildPath: invalid path component: ${value}`);
  }
  if (value.startsWith("/"))
    throw new Error(`buildPath: invalid path component: ${value}`);
}

export function buildPath(input: {
  root: string;
  scope: Scope;
  scope_id?: string;
  key: string;
}): string {
  if (input.scope_id !== undefined) assertSafeComponent(input.scope_id);
  assertSafeComponent(input.key);
  const parts = [input.root, input.scope];
  if (input.scope !== "global") parts.push(input.scope_id ?? "");
  parts.push(`${input.key}.md`);
  return path.join(...parts);
}

export function resolveProjectId(absRepoPath: string): string {
  return createHash("sha256").update(absRepoPath).digest("hex").slice(0, 12);
}
```

### 2. `src/core/memory/fts-query.ts` (~30 строк)

Токенизация запроса → FTS5 MATCH expression. OR-join, phrase-quoted tokens.

```typescript
/**
 * Build an FTS5 MATCH expression from a free-form user query.
 *
 * FTS5's MATCH grammar has its own operators and special characters
 * (`"`, `(`, `)`, `*`, `:`, `^`, `-`, `.`, `{`, `}`). Passing a raw user
 * string with any of these crashes the parser. Wrapping each token as a
 * phrase and joining avoids the crash; OR-join keeps recall high.
 *
 * OR (not AND): AND-join required EVERY query word to appear in a document,
 * so a single descriptive word the user added that wasn't in the stored
 * text (e.g. "postgres database port 5433" — "database" absent) zeroed the
 * whole query even when 6/7 tokens matched. OR lets BM25 rank by how many /
 * how rare the matched tokens are; the caller applies a score floor to drop
 * common-word-only noise.
 *
 * \p{L} includes CJK letters.
 *
 * Returns null when no usable tokens are extracted.
 */
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}
```

### 3. `src/core/memory/index.ts` (~120 строк)

SQLite FTS5: content table `memory_fts` + external content virtual table `memory_fts_idx` + triggers.

```typescript
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildFtsQuery } from "./fts-query.js";
import { MEMORY_ROOT } from "./paths.js";

let db: DatabaseSync;

export function initMemoryDb(): DatabaseSync {
  const dbPath = join(MEMORY_ROOT, "index.db");
  mkdirSync(MEMORY_ROOT, { recursive: true });
  db = new DatabaseSync(dbPath);

  // Content table — source of truth for all memory rows
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_fts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      body TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      last_indexed_at INTEGER NOT NULL
    )
  `);

  // B-tree indexes for scope/type filtering (same as MiMo)
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_fts_scope_idx
    ON memory_fts (scope, scope_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS memory_fts_type_idx
    ON memory_fts (type)
  `);

  // FTS5 virtual table — external content pattern, indexes body only
  // tokenize='unicode61 remove_diacritics 1' — same as MiMo
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_idx USING fts5(
      body,
      content='memory_fts',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 1'
    )
  `);

  // Triggers — keep FTS index in sync with content table automatically
  // Uses the 'delete' magic command for external content FTS5 (not plain DELETE)
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body)
      VALUES('delete', OLD.id, OLD.body);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_fts BEGIN
      INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body)
      VALUES('delete', OLD.id, OLD.body);
      INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body);
    END
  `);

  return db;
}

export function getMemoryDb(): DatabaseSync {
  if (!db) db = initMemoryDb();
  return db;
}

export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
  scope: string;
  scope_id: string;
  type: string;
}

export function searchMemory(input: {
  query: string;
  scope?: string;
  scope_id?: string;
  type?: string;
  limit?: number;
}): SearchResult[] {
  const d = getMemoryDb();
  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];

  const limit = input.limit ?? 10;
  const floorRatio = 0.15;

  // Construct WHERE clauses for scope/scope_id/type filtering
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (input.scope) { conditions.push("memory_fts.scope = ?"); params.push(input.scope); }
  if (input.scope_id) { conditions.push("memory_fts.scope_id = ?"); params.push(input.scope_id); }
  if (input.type) { conditions.push("memory_fts.type = ?"); params.push(input.type); }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  // Query the FTS virtual table, join back to content table
  const sql = `
    SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
           snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
           bm25(memory_fts_idx) AS score
    FROM memory_fts_idx
    JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
    WHERE memory_fts_idx MATCH ? ${whereClause}
    ORDER BY score
    LIMIT ?
  `;

  // Over-fetch (3x, capped) so the relative floor can trim common-word noise
  const fetchLimit = Math.min(limit * 3, 50);
  const rows = d.prepare(sql).all(ftsQuery, ...params, fetchLimit) as any[];

  // FTS5 bm25() returns lower = better; convert to higher = better
  const mapped = rows.map((r: any) => ({
    path: r.path,
    snippet: r.snippet,
    score: -r.score,
    scope: r.scope,
    scope_id: r.scope_id,
    type: r.type,
  }));

  if (mapped.length === 0) return [];

  // Relative score floor — drop common-word noise
  // #1 result is ALWAYS kept; drop trailing rows below floorRatio of its score
  const topScore = mapped[0].score;
  const cutoff = floorRatio > 0 ? topScore * floorRatio : -Infinity;
  return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit);
}
```

### 4. `src/core/memory/reconcile.ts` (~90 строк)

Walk .md файлы на диске → diff с индексом → sync. Triggers обновляют FTS автоматически.

```typescript
import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { MEMORY_ROOT, parsePath, type MemoryLocator } from "./paths.js";
import { getMemoryDb } from "./index.js";

async function walkMemoryDir(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await recurse(full);
      else if (entry.isFile() && full.endsWith(".md")) out.push(full);
    }
  }
  await recurse(root);
  return out;
}

function fileFingerprint(s: { size: number; mtimeMs: number }): string {
  return `${s.size}-${s.mtimeMs}`;
}

async function indexFromDisk(
  absPath: string,
  loc: MemoryLocator,
  oldFingerprint?: string,
): Promise<"hit" | "updated" | "skipped"> {
  const s = await stat(absPath).catch(() => null);
  if (!s) return "skipped";

  const fingerprint = fileFingerprint(s);
  if (oldFingerprint === fingerprint) return "hit";

  const body = await readFile(absPath, "utf-8");
  const d = getMemoryDb();

  // INSERT or UPDATE — triggers handle FTS sync automatically
  d.prepare(`
    INSERT INTO memory_fts(path, scope, scope_id, type, body, fingerprint, last_indexed_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      scope=excluded.scope, scope_id=excluded.scope_id, type=excluded.type,
      body=excluded.body, fingerprint=excluded.fingerprint, last_indexed_at=excluded.last_indexed_at
  `).run(absPath, loc.scope, loc.scope_id, loc.type, body, fingerprint, Date.now());

  return "updated";
}

export async function reconcileMemory(): Promise<{ indexed: number; pruned: number }> {
  const d = getMemoryDb();
  const diskFiles = new Set(await walkMemoryDir(MEMORY_ROOT));

  const indexed = new Map<string, string>(
    (d.prepare("SELECT path, fingerprint FROM memory_fts").all() as any[])
      .map((r) => [r.path, r.fingerprint]),
  );

  // Prune dead rows (any path not on disk)
  let pruned = 0;
  for (const p of indexed.keys()) {
    if (!diskFiles.has(p)) {
      d.prepare("DELETE FROM memory_fts WHERE path = ?").run(p);
      pruned++;
    }
  }

  // Index/update disk files
  let indexedCount = 0;
  for (const absPath of diskFiles) {
    const loc = parsePath(absPath);
    if (!loc) continue;

    const result = await indexFromDisk(absPath, loc, indexed.get(absPath));
    if (result === "updated") indexedCount++;
  }

  return { indexed: indexedCount, pruned };
}
```

### 5. `src/core/tools/memory.ts` (~70 строк)

Tool executor для memory_search. Описание tool — из MiMo Code memory.txt (с адаптацией).

```typescript
import type { ToolResult } from "./shared.ts";
import { searchMemory } from "../memory/index.js";

const MEMORY_SEARCH_DESCRIPTION = [
  "Search session/project/global memory using BM25 over markdown",
  "bodies. Use this to recall content the agent or writer subagent",
  "persisted previously: project memory, session checkpoints, task",
  "narratives (under sessions/<id>/tasks/), project notes, global preferences.",
  "",
  "Memory layout: /memory/<scope>/<scope_id?>/<key>.md",
  "Scopes: global | projects | sessions",
  "",
  "QUERY GUIDELINES:",
  "- Queries are OR'd and BM25-ranked: a document matches if it contains ANY",
  "  query word, ordered by relevance (how many / how rare the matched words are).",
  "  Low-relevance common-word-only matches are dropped by a score floor.",
  "- Prefer 1-3 distinctive terms (function name, task ID, exact phrase from a",
  "  directive, a rare word from the snippet you want). Long lists of generic",
  "  words just add noise and bury the real hit.",
  "- Punctuation (`.`, `-`, `/`, `:`) is stripped during tokenization. Both query",
  "  and indexed body see only alphanumeric runs, so `T5.3` matches `T5.3`,",
  "  `T5_3`, or `T5 3`.",
  "",
  "A HIT IS AUTHORITATIVE. If search returns a result, trust it.",
  "",
  "WHEN SEARCH RETURNS 0 (escalate, do not give up):",
  "1. Retry with fewer / rarer terms.",
  "2. For a literal string the tokenizer splits (URL, port, path) —",
  "   Grep the memory dir directly; FTS can't match the punctuation form.",
  "3. For verbatim recall a summary may have glossed over — use the",
  "   history tool (raw conversation messages).",
  "Widen scope progressively: session -> project -> global -> history.",
  "",
  "Actions:",
  "- search: OR-joined BM25 query, optional scope/scope_id/type filters",
  "",
  "After search returns paths, use Read on the most relevant ones to load",
  "full content (snippets are truncated). Use Glob on `/memory/**/*.md` to",
  "inspect the tree if you need to find files by name pattern instead of body.",
].join("\n");

export function execMemorySearch(args: Record<string, unknown>): ToolResult {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return { content: "query is required", isError: true };

  const results = searchMemory({
    query,
    scope: typeof args.scope === "string" ? args.scope : undefined,
    scope_id: typeof args.scope_id === "string" ? args.scope_id : undefined,
    type: typeof args.type === "string" ? args.type : undefined,
    limit: typeof args.limit === "number" ? args.limit : 10,
  });

  if (results.length === 0) {
    return {
      content: [
        `No matches for "${query}".`,
        "",
        "0 results does NOT mean it was never recorded.",
        "Escalate before giving up:",
        "1. Retry with FEWER / more distinctive terms — queries are OR-joined and",
        "   ranked, so 1-2 rare words (an exact ID, function name, flag) beat a long",
        "   descriptive phrase. Drop generic words ('config', 'params', 'database').",
        "2. For a LITERAL string the tokenizer splits (URLs like postgres://..., ports",
        "   like 5433, paths) — Grep the memory dir directly; FTS can't see it.",
        "3. For VERBATIM recall of something a summary may have glossed over (exact",
        "   command, the user's precise wording) — use the history tool (raw",
        "   conversation), which keeps original messages.",
        "Widen scope progressively: session -> project -> global -> history.",
      ].join("\n"),
    };
  }

  const lines = [
    `Found ${results.length} match${results.length === 1 ? "" : "es"} (BM25-ranked, best first).`,
    `A hit here is authoritative — use it even if a parallel/sibling query returned nothing.`,
    `If you need the FULL body (snippets are truncated), Read the path.`,
    "",
  ];

  for (const r of results) {
    lines.push(`### ${r.path}`);
    lines.push(
      `Scope: ${r.scope}${r.scope_id ? `/${r.scope_id}` : ""}, Type: ${r.type}, Score: ${r.score.toFixed(3)}`,
    );
    lines.push(r.snippet);
    lines.push("");
  }

  return { content: lines.join("\n") };
}

export { MEMORY_SEARCH_DESCRIPTION };
```

### 6. Интеграция в `src/core/tools.ts`

Добавить импорт:
```typescript
import { execMemorySearch, MEMORY_SEARCH_DESCRIPTION } from "./tools/memory.ts";
```

Добавить tool definition в `getToolDefinitions()` (после plan tools):
```typescript
{
  type: "function",
  function: {
    name: "memory_search",
    description: MEMORY_SEARCH_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (BM25 over markdown bodies)" },
        scope: {
          type: "string",
          enum: ["global", "projects", "sessions"],
          description: "Filter by memory scope",
        },
        scope_id: {
          type: "string",
          description: "Filter by scope id (e.g., session id, project id hash)",
        },
        type: {
          type: "string",
          description: "Filter by memory type (memory, checkpoint, notes, progress, free)",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
},
```

Добавить case в `createToolExecutor()`:
```typescript
case "memory_search":
  return execMemorySearch(args);
```

### 7. Интеграция в `src/core/loop.ts`

В `runLoop()` — reconcile перед первым turn (один раз за сессию):

```typescript
// After client creation, before outer loop:
let memoryReconciled = false;
// ...
// In outer loop, before first LLM call:
if (!memoryReconciled) {
  try { await reconcileMemory(); } catch { /* non-fatal */ }
  memoryReconciled = true;
}
```

### 8. Интеграция в `src/core/startup.ts`

Ленивая инициализация через `getMemoryDb()` при первом вызове `searchMemory()`. Не нужно добавлять в `StartupResult`.

---

## Порядок реализации

| Шаг | Файл | ~Строк | Зависит от |
|-----|------|--------|------------|
| 1 | `src/core/memory/paths.ts` | 80 | — |
| 2 | `src/core/memory/fts-query.ts` | 30 | — |
| 3 | `src/core/memory/index.ts` | 120 | paths, fts-query |
| 4 | `src/core/memory/reconcile.ts` | 90 | paths, index |
| 5 | `src/core/tools/memory.ts` | 70 | index |
| 6 | `src/core/tools.ts` (+register) | 15 | tools/memory |
| 7 | `src/core/loop.ts` (+reconcile) | 10 | memory/reconcile |
| 8 | `test/memory.test.ts` | 150 | все выше |
| **Итого** | | **~565** | |

---

## Точное соответствие MiMo Code

| Компонент | MiMo Code (оригинал) | Cast (наш план) |
|-----------|----------------------|-----------------|
| Content table name | `memory_fts` | `memory_fts` — совпадает |
| FTS virtual table name | `memory_fts_idx` | `memory_fts_idx` — совпадает |
| FTS columns | `body` (external content) | `body` — совпадает |
| Tokenizer | `unicode61 remove_diacritics 1` | `unicode61 remove_diacritics 1` — совпадает |
| `content=` | `content='memory_fts'` | `content='memory_fts'` — совпадает |
| `content_rowid=` | `content_rowid='id'` | `content_rowid='id'` — совпадает |
| B-tree indexes | `(scope, scope_id)`, `(type)` | `(scope, scope_id)`, `(type)` — совпадает |
| Trigger INSERT | `INSERT INTO memory_fts_idx(rowid, body) VALUES (NEW.id, NEW.body)` | совпадает |
| Trigger DELETE | `INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', OLD.id, OLD.body)` | совпадает |
| Trigger UPDATE | delete OLD + insert NEW | совпадает |
| Query FROM | `FROM memory_fts_idx JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid` | совпадает |
| Query WHERE | `WHERE memory_fts_idx MATCH ?` | совпадает |
| snippet() args | `snippet(memory_fts_idx, 0, '<<', '>>', '...', 32)` | совпадает |
| bm25() args | `bm25(memory_fts_idx)` | совпадает |
| Score inversion | `-r.score` (lower=better → higher=better) | совпадает |
| Score floor | `topScore * 0.15`, first result always kept | совпадает |
| Over-fetch | `Math.min(limit * 3, 50)` | совпадает |
| OR separator | `" OR "` (space on both sides) | совпадает |
| Tokenizer regex | `/[\p{L}\p{N}_]+/gu` | совпадает |
| buildFtsQuery null | `if (tokens.length === 0) return null` | совпадает |
| Quote escaping | `t.replaceAll('"', "")` | совпадает |
| Path regex | `/\/memory\/(global\|projects\|sessions)(?:\/([^/]+))?\/(.+)\.md$/` | совпадает |
| Path traversal guard | `assertSafeComponent` (reject `..` and `/` prefix) | совпадает |
| buildPath structure | `[root, scope, scope_id?, key.md]` | совпадает |
| resolveProjectId | `sha256(absPath).digest("hex").slice(0, 12)` | совпадает |
| Fingerprint | `${stat.size}-${stat.mtimeMs}` | совпадает |
| Reconcile prune | DELETE WHERE path NOT IN diskFiles | совпадает |
| Reconcile index | INSERT...ON CONFLICT DO UPDATE | совпадает |
| FTS sync | Via triggers (auto on INSERT/UPDATE/DELETE) | совпадает |
| MemoryType patterns | `/^memory$/i`, `/^checkpoint$/`, `/^tasks\/[^/]+\/progress$/`, etc. | совпадает |
| Walk error handling | `.catch(() => [])` for ENOENT | совпадает |
| Tool description | Extensive QUERY GUIDELINES + escalation steps | совпадает |
| Zero-result message | "0 results does NOT mean it was never recorded" + 3 escalation steps | совпадает |
| Hit message | "A hit here is authoritative" + "Read the path for full content" | совпадает |

---

## Что НЕ берём из MiMo Code

| MiMo Feature | Почему не нужен |
|--------------|-----------------|
| Checkpoint-writer subagent | Compaction уже покрывает это |
| Session checkpoint.md | Compaction покрывает |
| Dream/distill subagents | Overkill для cast |
| CC (Claude Code) memory index | Cast не fork Claude Code |
| Memory reconcile on search | Lazy reconcile на старте sufficient |
| Score floor config | hardcoded 0.15 sufficient |
| Shell invocation style для memory | memory_search — JSON only |
| Memory path guard (write protection) | cast не имеет memory write tool |
| `Bun.file()` для чтения | cast на Node.js, используем `readFile` |
| `Database.use()` wrapper | cast на `node:sqlite`, используем прямой `db.prepare()` |
| Drizzle ORM | cast не использует ORM |

---

## Failure modes

| Failure | Impact | Mitigation |
|---------|--------|------------|
| `node:sqlite` experimental warning | Warning в stderr | Подавить через `--no-warning=ExperimentalWarning` или принять |
| Corrupted index.db | search падает | `DROP TABLE IF EXISTS` + recreate на init |
| Empty memory dir | search возвращает [] | Корректно — нет данных |
| Concurrent access | — | cast single-process, не проблема |
| FTS5 rebuild при изменении body | ~мс для <100 файлов | Reconcile делает diff по fingerprint, triggers обновляют FTS |
| Fingerprint collision (size+mtime одинаковы) | Пропуск обновления | Крайне маловероятно, accept risk |
| Path traversal (`../../etc/passwd`) | Попадание за пределы memory dir | `assertSafeComponent` отклоняет `..` и `/` prefix |
| Stale FTS tokens (trigger bug) | Запаздывание индекса | Триггеры используют 'delete' magic command (v6.1 fix) |

---

## Failure modes (под капотом MiMo Code)

| Failure | MiMo Approach | Cast Equivalent |
|---------|---------------|-----------------|
| Doom loop (same tool+args) | `stepSignature()` с stableStringify | cast: `JSON.stringify(args)` — хуже (reordered keys пропускаются) |
| Text loop (модель повторяет текст) | n-gram detection + recovery prompts | cast: нет |
| Empty step (пустой assistant turn) | `isEmptyStep()` + recovery | cast: `EMPTY_ASSISTANT_PLACEHOLDER` |
| Goal not reached | Independent judge model | cast: нет |

---

## Revisit triggers

- Если `node:sqlite` станет stable → убрать experimental warning suppression
- Если cast станет multi-process → нужен WAL mode или external SQLite
- Если memory файлы >1000 → добавить lazy reconcile (не на каждом старте)
- Если появится memory write tool → добавить permission gating (как MiMo)
- Если compaction начнёт писать checkpoint.md → интегрировать с reconcile

---

## Тестовый сценарий

```
1. cast запускается в проекте ~/myproject
2. Пользователь: "запомни что сервер работает на порту 5433"
3. Агент пишет в ~/.cast/memory/projects/<hash>/MEMORY.md:
   "Server runs on port 5433 with PostgreSQL"
4. cast завершается
5. cast запускается снова в ~/myproject
6. Пользователь: "какой порт у сервера?"
7. Агент вызывает memory_search({ query: "port server" })
8. Находит "5433" через BM25 search (score: -0.00000176)
9. Отвечает: "Сервер работает на порту 5433"
```

---

## Prompting architecture (из аудита MiMo Code)

### Принцип 1: Provider-specific system prompts

MiMo Code имеет **отдельный system prompt для каждого семейства моделей**:

```
prompt/anthropic.txt  — для Claude
prompt/gpt.txt        — для GPT
prompt/gemini.txt     — для Gemini
prompt/deepseek.txt   — для Deepseek
prompt/default.txt    — fallback
```

Каждый промпт адаптирован под поведение модели: Claude любит структуру, GPT — подробности, Gemini — краткость. **Cast уже делает это через personas** — каждый persona это по сути provider-specific prompt.

### Принцип 2: Memory section в system prompt

MiMo Code объясняет агенту систему памяти прямо в system prompt:

```
### Memory
Persistent file-based memory lives under ~/.claude/projects/<id>/memory/
with an index at MEMORY.md. Four types — user, feedback, project, reference
— each saved as a frontmatter-tagged markdown file. The auto-memory protocol
in your parent system prompt governs when to write, update, or recall; this
prompt does not override it.
```

Ключевой паттерн: **"The auto-memory protocol in your parent system prompt governs when to write"** — MiMo разделяет ГДЕ лежит память (в tool description) и КОГДА писать (в system prompt).

### Принцип 3: Tool description учит КАК искать

Memory tool description в MiMo — это не просто "search memory". Это **обучающий документ**:

```
QUERY GUIDELINES:
- Queries are OR'd and BM25-ranked
- Prefer 1-3 distinctive terms
- Punctuation is stripped during tokenization
- A HIT IS AUTHORITATIVE

WHEN SEARCH RETURNS 0 (escalate, do not give up):
1. Retry with fewer / rarer terms
2. For a literal string the tokenizer splits — Grep the memory dir directly
3. For verbatim recall — use the history tool
Widen scope progressively: session -> project -> global -> history
```

Это **предотвращает типичные ошибки** модели:放弃 после первого 0-result, использование слишком длинных запросов, попытка искать то что FTS5 не может найти.

### Принцип 4: Checkpoint writer — отдельный агент

MiMo выделяет **отдельного subagent** (checkpoint-writer) который:
- Пишет checkpoint.md (11 секций)
- Пишет MEMORY.md (4 секции)
- Имеет строгий path sandbox (только memory dir)
- Запускается автоматически при context threshold

Cast **не нуждается** в этом — compaction уже покрывает checkpoint. Но **структура MEMORY.md** из MiMo полезна:

```markdown
## Project context     — что за проект, его цель
## Rules              — жёсткие ограничения пользователя
## Architecture decisions — главные design choices с обоснованием
## Discovered durable knowledge — факты, которые переживают сессию
```

### Принцип 5: Memory path guard

MiMo запрещает агенту писать **за пределы memory dir** через专门ый guard:

```typescript
function assertAgentWriteSandbox(input) {
  // checkpoint-writer: только memory dir
  // dream/distill: memory dir + .mimocode/
  // main agent: может писать в MEMORY.md и notes.md
}
```

Cast: не нужен — агент и так пишет через `write`/`edit` тулы в обычные файлы.

### Принцип 6: Reconcile on search

MiMo делает reconcile **перед каждым search** (покрывает ручные правки):

```typescript
if (cfg.checkpoint?.memory_reconcile_on_search ?? true) {
  yield* reconcileMemory();
}
```

Cast: reconcile **один раз при старте** sufficient для single-process CLI.

---

## Промпты для cast

### Memory prompt block (отдельный суффикс, НЕ в persona)

Как в MiMo Code: memory — это **shared block** в system prompt, не дублируется в каждом persona.

Файл `prompts/memory.md`:

```markdown
### Persistent Memory

This project has persistent memory in `~/.cast/memory/`.
Facts, rules, and decisions written here survive across sessions.

Layout:
- `~/.cast/memory/global/MEMORY.md` — rules for ALL projects
- `~/.cast/memory/projects/<hash>/MEMORY.md` — project-specific facts
- `~/.cast/memory/projects/<hash>/NOTES.md` — agent scratch notes

When to WRITE to memory:
- User explicitly says "запомни", "remember", "note this"
- You discover a durable project fact (port, config, architecture decision)
- User states a rule that should persist ("always biome", "never delete features")

What to write:
- Exact values: ports, URLs, env vars, command flags — VERBATIM, not paraphrased
- Architecture decisions with rationale
- Do NOT write: temporary debugging, in-progress work, credentials

When to SEARCH memory:
- User asks about project config, ports, dependencies
- You need a fact from a previous session
- Before changes that might conflict with established conventions

Use `memory_search` tool. If 0 results — retry with fewer terms before giving up.
```

Интеграция в `buildSystemPrompt()` (project.ts):

```typescript
import { readRequiredPrompt, promptsDir } from "./prompts.ts";

const MEMORY_PROMPT = readRequiredPrompt(promptsDir, "memory.md");

// В buildSystemPrompt():
return [
  persona.systemPrompt,
  contextFilesSuffix,
  rulesSuffix,
  rulesLazySuffix,
  MEMORY_PROMPT,          // ← отдельный блок, один для всех persona
  skillsPromptSuffix,
  mcpPromptSuffix,
  stateBlock,
]
  .filter(Boolean)
  .join("");
```

**Почему НЕ в persona:**
- Memory — это knowledge store, не behavioral rules
- Persona governs behavior; memory governs what помнить
- Дублирование = divergence между persona
- MiMo Code делает так же: default.txt содержит "### Memory", agent prompts — нет

---

## Принципы промптинга из MiMo Code (чеклист для cast)

| Принцип | Пример в MiMo | Применение в cast |
|---------|---------------|-------------------|
| **Разделяй ГДЕ и КОГДА** | Memory section в system prompt; tool description учит КАК | System prompt: "when to write"; tool desc: "how to search" |
| **Учи модель искать** | QUERY GUIDALINES + zero-result escalation | MEMORY_SEARCH_DESCRIPTION в tool definition |
| **Доверяй результату** | "A HIT IS AUTHORITATIVE" | В tool description |
| **Верbatim для точных значений** | Checkpoint writer: "preserve the literal byte-for-byte" | System prompt: "write exact values, not paraphrased" |
| **Progressive scope** | "Widen scope: session → project → global → history" | В tool description |
| **Предотвращай типичные ошибки** | "0 results does NOT mean it was never recorded" | В zero-result response |
| **Структурируй memory** | 4 секции: context, rules, architecture, discovered | MEMORY.md template в system prompt |
| **Не перегружай** | Memory section — 5 строк в system prompt | Keep it concise, details in tool desc |

