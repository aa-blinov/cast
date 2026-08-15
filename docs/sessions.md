# Sessions

Every conversation is automatically saved and can be resumed later.

## Session Storage

Sessions are stored in a single SQLite database at `~/.cast/sessions/sessions.db` — one row per session (metadata) and one row per message. Every message is kept forever: compaction flags older messages as no longer part of the model's context instead of deleting them, so the full conversation is always there to look back on even in a session that's been compacted many times over. What's sent to the model is only the still-in-context rows; what you see when reopening a session (`/sessions`, `/continue`, `-c`, or the web UI) is everything, regardless of that flag.

Sessions saved by older versions of cast (individual `.json`/`.jsonl` files under `~/.cast/sessions/<encoded-cwd>/`) are imported into the database automatically on first run after upgrading — the original files are left on disk untouched.

## Project Memory

Cast uses a two-layer memory layout. The authoritative artifacts are files under `~/.cast/memory/`: project knowledge in `projects/<project-id>/MEMORY.md`, session handoffs in `sessions/<session-id>/checkpoint.md`, scratch notes in `notes.md`, and delegated task progress under `tasks/<task-id>/progress.md`. SQLite keeps a scoped FTS5 mirror derived from those files for fast retrieval, and the raw session trajectory remains the evidence source.

When a session approaches the context threshold, a checkpoint-writer fork updates the handoff files with normal file tools. `/dream` periodically consolidates durable knowledge from the trajectory into the project file, and `/distill` packages repeated workflows as reusable assets. These agents use absolute paths, are isolated from the user-facing turn, and share a per-project SQLite lease; one writer runs per session and at most one newer pending checkpoint request is retained. Memory work is bounded and best-effort; the main turn never waits for it.

Ordinary turns receive only a short reminder that durable memory is available; the full memory context is loaded after a checkpoint rebuild, where it becomes part of the durable continuation. The `memory` tool can search the same project scope explicitly on demand:

```json
{"query":"native reasoning tool-call"}
```

Memory writing is best-effort: if the writer provider call fails or times out, the conversation remains successful and Cast reports a non-fatal warning. Existing memory stays available through retrieval. After the checkpoint writer or a hand edit changes `MEMORY.md`, the file is reconciled into the SQLite FTS mirror and an atomic manifest records the file hash and revision.

Memory can be disabled globally with `/memory off` in the TUI or Settings → Memory in the Web UI. Background writing can be disabled independently with `/memory write off`; existing memory remains readable and searchable. The prompt budget, relative BM25 score floor, and reconcile-before-search behavior are configurable with `/memory budget`, `/memory floor`, and `/memory reconcile`. All settings are stored in `~/.cast/settings.json` and shared by both clients. Disabling memory does not delete existing project-memory rows.

When the project needs maintenance, `/dream` verifies the last seven days of raw project trajectory against the memory files and consolidates only durable knowledge. `/distill` inspects the last thirty days and existing assets, requires repeated evidence, and materializes high-confidence skills, personas, or commands under the project `.cast` directory; low-confidence candidates remain reviewable in SQLite. Both commands require an idle agent, use the same global memory switch, and leave the conversation intact if the provider call fails.

Automatic dream and distill runs are separate persistent background sessions linked to their parent conversation. They have their own messages, events, status, cancellation, terminal event, and recovery descriptor without adding maintenance traffic to the conversation transcript. Use `/memory runs` to inspect them and `/memory cancel <run-id>` to cancel an active run; the Web UI exposes the same operations through its `/memory` command bridge.

## Session History Search

`session_history` is deliberately separate from `memory`. It searches raw user, assistant, and tool messages from earlier sessions in the current project through the SQLite full-text index. Use it when the exact earlier discussion is needed; use `memory` for distilled durable facts. Search results include the source session and message sequence so the agent can distinguish evidence from a reusable project rule.

Memory retrieval, file reconciliation, and maintenance are recorded as durable session events. All active project-memory operations use a renewable cross-process lease in SQLite. The in-process checkpoint queue provides newest-wins behavior within a session; the SQLite lease prevents another daemon or TUI process from writing the same project's memory concurrently.

## Session State

Each session tracks:

- **Messages** — full conversation history
- **Model** — which model was used
- **Mode** — plan or build (restored on resume)
- **Usage** — cumulative token/cost metrics:
  - `promptTokens`, `completionTokens`, `totalTokens`
  - `cost`
  - `cacheReadTokens`, `cacheWriteTokens`, `uncachedTokens`
  - `subagentTokens` (subset of total, tracked separately)
- **Timestamps** — created and updated

## Resuming Sessions

### CLI

```bash
cast -c                    # Resume most recent session
cast --resume              # Pick from a numbered list
cast --resume=nd4k8f2x     # Resume by session id
cast -s nd4k8f2x           # Same (alias)
```

When resuming a session from a different project directory, cast automatically switches to that project's `cwd` and reloads its skills, rules, and MCP servers.

Sessions remember which provider their model belongs to. If you've switched providers since, resume falls back to your currently configured model (with a notice) instead of sending requests to a model the new provider doesn't have.

### Git Worktrees

You can run or switch a session inside an isolated git worktree:
- **CLI**: `cast -w <name>` / `--worktree <name>`
- **TUI**: `/worktree <name>`
- **Web UI**: In the New Session modal, check **Run in an isolated git worktree** and specify a name (defaults to `tree-XXXX`).

When enabled, cast creates (or reuses) a git worktree at `.cast/worktrees/<name>` on a branch named `cast-<name>`. The session's `cwd` switches to the worktree path, so all tools (`bash`, `read`, `write`, `edit`) operate inside the worktree while leaving your main checkout untouched. The worktree path is saved in the session state (`SessionState.cwd`), so resuming the session with `-c` or `--resume` automatically keeps working inside that worktree.

### Interactive

```
/sessions                  # Opens session picker
/continue                  # Resume the most recent session
/fork                      # Branch the current safe context into a new session
/worktree <name>           # Switch current session to a git worktree
```

The `/sessions` picker shows each session's project, first message, last-updated time, and message count — and filters as you type. The search matches the project path, session id, and **every user/assistant message in the thread**: substring matches rank first (earlier = higher), then in-order subsequence matches (so minor typos still hit). `Backspace` edits the query, `Esc` closes, `Enter` resumes the highlighted session. Deleting goes through the `Delete a session` row at the bottom (find it by typing its name).

`/continue` is the quick path: it finds the most recently updated session that isn't the current one and switches to it — autosaving the current session first if it has messages. If there's no other session to resume, it shows a notice. This is the in-session equivalent of `cast -c`.

`/fork` creates a new session and switches to it, preserving only the context that is currently safe to send to the model. The source session is not changed. Compacted-out history, pending questions and plan approvals, undo checkpoints, and usage counters are not copied. A fork shares the same working directory; use `/worktree` afterwards when file isolation is needed.

### Web UI Sidebar

The Web UI groups sessions by their working directory. Quick sessions created with the `new` action use a dedicated `Sandbox` group; project sessions are grouped by the final directory name rather than the full path. Groups are ordered by latest activity. Within each group, pinned sessions come first, followed by running sessions and then the remaining sessions ordered by `updatedAt`. Pinning stays local to the current directory group, and hovering a group name reveals the full path. Search results remain a flat relevance-ranked list. Use the `…` menu on an idle session and choose **Fork** to branch it; running sessions cannot be forked.

## Creating New Sessions

```
/new                       # Start fresh (autosaves current if non-empty)
```

A new session starts in build mode — plan mode is per-task state, not a sticky preference.

## Context Compaction

When the conversation grows too long, cast automatically summarizes older messages to keep the context window useful.

### When It Triggers

Compaction triggers when the last API response's `promptTokens` exceeds:

```
(contextWindow - maxResponseTokens) × compactionThreshold
```

Default: `(128,000 - 8,192) × 0.75 = ~90,000 tokens`

### How It Works

1. Messages are split: ~60% old, ~40% recent
2. The split point snaps to a turn boundary (a `user` message) so tool calls and results stay together
3. Old messages are summarized by the LLM
4. File paths from read/write/edit operations are extracted deterministically and appended to the summary
5. The summary replaces the old messages as a system message in what gets sent to the model — the originals stay on disk (see Session Storage above) and are always visible when you reopen the session

If this isn't the first compaction, the previous summary is passed to the LLM as update-in-place context — the running summary improves over time rather than starting from scratch each round.

### Resilience

If the LLM summarization fails (network error, provider outage), messages are left **untouched** — not pruned. The caller sees `compacted: false` with an error, so the transcript isn't lost. The next turn retries compaction automatically.

### Context Overflow

If the provider returns a context overflow error mid-turn, cast automatically compacts and retries — once per turn. If compaction itself fails, the original error surfaces.

### Plan Mode Compaction

During plan mode, compaction preserves exploration findings that aren't yet written into the plan file: exact file paths, symbol names, observed behaviors, and open questions. The plan file's own content is excluded (it lives on disk and is re-injected automatically).

### Commands

| Command | Description |
|---------|-------------|
| `/compact` | Force compaction now |
| `/clear` | Clear all context (and save the cleared state) |
| `/undo` | Restore the latest checkpoint and remove the last turn |

## Usage Tracking

```
/usage
```

Shows cumulative token and cost usage for the current session, including breakdown by cache hits, cache writes, uncached tokens, and sub-agent tokens.
