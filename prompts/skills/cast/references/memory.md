# Memory

Cast's durable project memory. A **notebook** the agent keeps for the project:
facts, decisions, rules, and problems solved that survive across sessions and
past compaction. It is a memory *aid*, never the source of truth — when a
remembered fact contradicts the code, trust the code.

## Files + search index

Two layers:

| Layer | What it is | Example |
|-------|-----------|---------|
| The files | Human- and agent-readable markdown — the source of truth | `~/.cast/memory/projects/<id>/MEMORY.md` |
| The search index | SQLite FTS copy for fast lookup, rebuilt from the files | `~/.cast/sessions/sessions.db` |

Artifacts:

| Artifact | File | Purpose |
|----------|------|---------|
| Project memory | `~/.cast/memory/projects/<id>/MEMORY.md` | Durable facts, rules, architecture decisions (per project, shared by all sessions) |
| Session checkpoint | `~/.cast/memory/sessions/<id>/checkpoint.md` | Handoff for the next turn: what was asked, what was being done, what's next |
| Scratch notes | `~/.cast/memory/sessions/<id>/notes.md` | Loose observations and quotes |
| Task progress | `~/.cast/memory/sessions/<id>/tasks/<task-id>/progress.md` | Per-task logs for sub-agents |
| Spillover | `~/.cast/memory/projects/<id>/MEMORY-<topic>.md` | Sections that outgrew `MEMORY.md` |
| Claude Code memory | `~/.claude/projects/<slug>/memory/*.md` | Optional (`memoryCcIndex`) |
| Global | `~/.cast/memory/global/MEMORY.md` | Cross-project rules and preferences |

## How memory is written

1. **Checkpoint writer** — fires when used context crosses a threshold
   (percent of the model window; defaults 20/40/60/80% up to 200K, 10% steps
   to 500K, 5% above). Thresholds clamp to `window − checkpointReserved`
   (default 13K tokens). Updates `checkpoint.md` and `MEMORY.md`.
2. **Dream** (`/dream` or `memoryDreamAuto`) — consolidates: keeps durable
   facts, merges duplicates, drops stale entries. Default every 7 days.
3. **Distill** (`/distill` or `memoryDistillAuto`) — packages repeated
   workflows into reusable skills/personas/commands. Default every 30 days.

Writing is best-effort and non-fatal. `memoryWriteEnabled off` keeps reading
available and stops all background writing.

## How memory is read

- **After compaction** — cast injects project `MEMORY.md`, checkpoint, notes,
  and task progress as context for the continuation.
- **On demand** — via the `memory` tool: `query` (1–3 distinctive terms),
  `scope` (`projects` default | `sessions` | `cc` | `global`), optional
  `scope_id`, `type`, `limit`. File-backed results return a path + snippet;
  read the file for the full body.

## `/memory` commands

| Command | What it does |
|---------|--------------|
| `/memory on|off` | Master switch (reading + writing) |
| `/memory write on|off` | Background writing only; reading stays |
| `/memory budget <tokens>` | Token budget for injected memory context (default 4096) |
| `/memory floor <0..1>` | Relative search score floor (default 0.15) |
| `/memory reconcile on|off` | Re-sync memory files into the index before search |
| `/memory checkpoint fork on|off` | Checkpoint writers reuse the parent prompt prefix |
| `/memory checkpoint thresholds <pct,..|default>` | Checkpoint trigger percentages |
| `/memory checkpoint reserved <tokens>` | Safety buffer (default 13000) |
| `/memory checkpoint caps <k=v,..|default>` | Per-section rebuild token caps (checkpoint/memory/notes/global/tasks) |
| `/memory dream on|off` / `/memory dream interval <days>` | Auto dream (default 7) |
| `/memory distill on|off` / `/memory distill interval <days>` | Auto distill (default 30) |
| `/memory runs` / `/memory cancel <run-id>` | Background run management |
| `/dream` / `/distill` | Run consolidation / packaging now |

Settings live in `~/.cast/settings.json`: `memoryEnabled` (true), `memoryWriteEnabled` (true),
`memoryPromptBudget` (4096), `memorySearchScoreFloor` (0.15), `memoryReconcileOnSearch` (true),
`memoryCcIndex` (false), `memoryDreamAuto`/`memoryDistillAuto` (false),
`memoryDreamIntervalDays` (7), `memoryDistillIntervalDays` (30), `checkpointFork` (false),
`checkpointThresholds` (window-based), `checkpointReserved` (13000), `checkpointPushCaps`.

## Answering user questions

- "Does cast remember X / my project?" — Explain memory is durable per project
  in `~/.cast/memory/`, survives restarts and compaction. Search it with the
  `memory` tool to show what cast actually knows about the topic.
- "What does cast remember about <topic>?" — Run `memory` tool (scope
  `projects`), then read the matching files and summarize.
- "Where is my memory stored?" — Point at `~/.cast/memory/` (files are plain
  markdown, editable by hand; the index picks up changes on next search or
  `/memory reconcile`).
- "Is memory shared between projects?" — No; project memory is scoped to the
  project path. Only `global/MEMORY.md` is cross-project.
- "Does the agent always see all memory?" — No; injected only after compaction
  or via the `memory` tool to save context.
- "Turn memory off / make cast stop writing" — `/memory off` (everything) or
  `/memory write off` (reading stays). Re-enable with `on`.
- "Why did cast forget X?" — Memory is a memory aid, not a transcript. Session
  history (`session_history` tool) has the verbatim conversation; memory holds
  the distilled version. Check whether the memory file has the fact and whether
  writing is enabled (`/memory` shows `memoryEnabled`/`memoryWriteEnabled`).
- "My memory seems wrong / stale." — Suggest running `/dream` to consolidate,
  `/memory reconcile` to re-sync the index, or edit the files under
  `~/.cast/memory/` directly.
