# Memory

## What is memory?

Cast is a coding agent: it reads code, edits files, runs commands, and talks to
an LLM. By default an agent forgets everything the moment a conversation ends.
**Memory is what lets Cast keep useful knowledge about your project across
sessions** — so the next time you open Cast in the same project, it already
knows the decisions you made, the rules you set, and the problems it solved.

Think of it as a **notebook** the agent keeps for your project:

- On every session it jots down what it was doing, what it learned, and what
  still needs to happen.
- When a new session starts (or after a long conversation is compacted), it
  reads the notebook instead of asking you to re-explain everything.

Memory is *durable* (it survives restarts) and *scoped* (per project, per
session, or global). It is never the source of truth for your code — it is a
memory aid. When the current code contradicts a remembered fact, trust the
code.

## How it works: files + a search index

Memory has two layers:

| Layer | What it is | Example |
|-------|-----------|---------|
| **The files** | Human- and agent-readable markdown documents — the *source of truth*. | `~/.cast/memory/projects/<id>/MEMORY.md` |
| **The search index** | A SQLite full-text index derived from those files, for fast lookup. | `~/.cast/sessions/sessions.db` |

The files are what the agent edits (with normal file tools, like a person would
open a document). The SQLite index is just a copy the search tool can query
fast — it is rebuilt from the files automatically, never edited by hand.

## What gets remembered

| Artifact | File | Purpose |
|----------|------|---------|
| Project memory | `~/.cast/memory/projects/<id>/MEMORY.md` | Durable facts, rules, and architecture decisions shared by every session in the project |
| Session checkpoint | `~/.cast/memory/sessions/<session-id>/checkpoint.md` | A handoff for the *next* turn of this session: what you asked, what the agent was doing, what to do next |
| Scratch notes | `~/.cast/memory/sessions/<session-id>/notes.md` | Loose observations and quotes that don't fit elsewhere |
| Task progress | `~/.cast/memory/sessions/<session-id>/tasks/<task-id>/progress.md` | Per-task logs for delegated sub-agents |
| Spillover | `~/.cast/memory/projects/<id>/MEMORY-<topic>.md` | Sections that outgrew `MEMORY.md` and were moved aside |
| Claude Code memory | `~/.claude/projects/<slug>/memory/*.md` | Memory written by Claude Code for the same project (optional, `memoryCcIndex`) |

Example layout:

```
~/.cast/memory/
├── projects/
│   └── a1b2c3d4e5f60718/          # one directory per project (hash of its path)
│       ├── MEMORY.md              # durable project knowledge
│       ├── MEMORY-tests.md        # spillover topic
│       └── manifest.json          # revision bookkeeping
├── sessions/
│   └── 9f2e…/                     # one directory per session
│       ├── checkpoint.md
│       ├── notes.md
│       └── tasks/
│           └── t_1/progress.md
└── global/
    └── MEMORY.md                  # cross-project rules and preferences
```

## How memory gets written

Three things write memory:

1. **The checkpoint writer.** While a conversation grows, Cast keeps a copy of
   the transcript in its context window. When the used context crosses a
   **threshold** — a percentage of the model's window — Cast quietly launches a
   background agent that updates `checkpoint.md` and `MEMORY.md`. Default
   thresholds: 20/40/60/80% for windows up to 200K tokens, 10% steps up to
   500K, 5% steps above. Each threshold fires once per session, and thresholds
   are clamped to stay below the window minus a safety buffer (`checkpointReserved`,
   default 13K tokens) so the writer always has room to finish. This is why a
   checkpoint is almost always fresh when a long conversation needs to be
   compacted.
2. **Dream** (`/dream`, or automatically with `memoryDreamAuto`). Periodically
   reviews the recent conversation history, keeps only durable facts, merges
   duplicates, and removes stale entries from `MEMORY.md`. Default: every 7
   days.
3. **Distill** (`/distill`, or `memoryDistillAuto`). Looks for workflows you did
   repeatedly and packages them as reusable skills/personas/commands. Default:
   every 30 days.

Writing is **best-effort**: if the model call fails, the conversation is
unaffected and Cast reports a non-fatal warning. Memory writing can be switched
off entirely while reading stays available.

## How memory gets read

There are two ways memory reaches the agent:

1. **Automatically, after compaction.** When a conversation grows too large,
   Cast summarizes the old part (compaction) and injects the durable memory —
   project `MEMORY.md`, the session checkpoint, notes, and task progress — as
   context for the continuation. That's how a compacted session "remembers".
2. **On demand, with the `memory` tool.** The agent can search memory mid-
   conversation. File-backed results return a file path plus a snippet; the
   agent reads the file when it needs the full body.

### The `memory` tool

```
query      — 1–3 distinctive terms (a function name, provider, task id, concept)
scope      — projects (default) | sessions | cc | global
scope_id   — optional project id, session id, or cc slug for the chosen scope
type       — optional entry type (rule, fix, checkpoint, notes, progress, …)
limit      — max results (default 10)
```

Scopes explained:

- `projects` (default) — the current project's `MEMORY.md` facts, spillover
  files, and this project's session files.
- `sessions` — checkpoint/notes/task files (optionally one session via
  `scope_id`).
- `cc` — Claude Code memory (requires `memoryCcIndex`).
- `global` — cross-project `MEMORY.md`.

## Commands

| Command | What it does |
|---------|--------------|
| `/memory on` / `/memory off` | Enable/disable durable memory (reading and writing) |
| `/memory write on` / `/memory write off` | Toggle background writing; reading stays available when off |
| `/memory budget <tokens>` | Token budget for automatically injected memory context |
| `/memory floor <0..1>` | Relative BM25 score floor for search (default `0.15`; `0` keeps all) |
| `/memory reconcile on/off` | Re-sync memory files into the search index before searching |
| `/memory checkpoint fork on/off` | Checkpoint writers reuse the parent prompt prefix (cache reuse) |
| `/memory dream on/off` | Toggle automatic dream consolidation |
| `/memory dream interval <days>` | Days between dream runs (default 7) |
| `/memory distill on/off` | Toggle automatic distill |
| `/memory distill interval <days>` | Days between distill runs (default 30) |
| `/memory runs` | List automatic background memory runs |
| `/memory cancel <run-id>` | Cancel a background run |
| `/dream` | Run memory consolidation now |
| `/distill` | Package repeated workflows into reusable assets now |

## Configuration

All memory settings live in `~/.cast/settings.json`. The most relevant:

| Setting | Default | Meaning |
|---------|---------|---------|
| `memoryEnabled` | `true` | Master switch for memory |
| `memoryWriteEnabled` | `true` | Allow background writing (checkpoint/dream/distill) |
| `memoryPromptBudget` | `4096` | Token budget for injected memory context |
| `memorySearchScoreFloor` | `0.15` | Relative score floor for search results |
| `memoryReconcileOnSearch` | `true` | Reconcile memory files before search |
| `memoryCcIndex` | `false` | Index Claude Code memory (`~/.claude/projects/*/memory`) |
| `memoryDreamAuto` | `false` | Auto dream on a new top-level session |
| `memoryDreamIntervalDays` | `7` | Dream interval |
| `memoryDistillAuto` | `false` | Auto distill |
| `memoryDistillIntervalDays` | `30` | Distill interval |
| `checkpointFork` | `false` | Checkpoint writers use the full parent prefix |
| `checkpointThresholds` | window-based | Checkpoint trigger percentages (e.g. `[20, 40, 60, 80]`) |
| `checkpointReserved` | `13000` | Safety buffer: thresholds clamp to `window − reserved` |

## What is NOT memory

**Session history** (`session_history` tool) is raw conversation: previous
messages, verbatim. Use it when you need the exact wording of something said
earlier. Memory is the *distilled* version — durable facts, not transcripts.
They are deliberately separate: history is evidence, memory is conclusions.

Memory is also **not** your code, your git history, or your filesystem — it is
Cast's own notes about them.

## Common questions

**Can I read/edit the memory myself?** Yes. The files are plain markdown under
`~/.cast/memory/`. Edit them by hand — the search index picks up the changes on
the next search (or run `/memory reconcile`). The Web UI also shows memory in
the Memory sidebar.

**Is my memory shared between projects?** No. Project memory is scoped to one
project (identified by its path). Only `global/MEMORY.md` is cross-project.

**Does the agent always see all memory?** No. Memory is injected only when it
matters: automatically after compaction, and on demand via the `memory` tool.
In ordinary turns the agent gets a short reminder that memory exists, not the
whole file — that would waste context.

**Will deleting `~/.cast/memory/` break anything?** It clears memory only; the
search index is rebuilt from whatever files remain. Your sessions, code, and
config are unaffected.
