# Sessions

Every conversation is automatically saved and can be resumed later.

## Session Storage

Sessions are stored in a single SQLite database at `~/.cast/sessions/sessions.db` — one row per session (metadata) and one row per message. Every message is kept forever: compaction flags older messages as no longer part of the model's context instead of deleting them, so the full conversation is always there to look back on even in a session that's been compacted many times over. What's sent to the model is only the still-in-context rows; what you see when reopening a session (`/sessions`, `/continue`, `-c`, or the web UI) is everything, regardless of that flag.

Sessions saved by older versions of cast (individual `.json`/`.jsonl` files under `~/.cast/sessions/<encoded-cwd>/`) are imported into the database automatically on first run after upgrading — the original files are left on disk untouched.

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

### Interactive

```
/sessions                  # Opens session picker
/continue                  # Resume the most recent session
```

The `/sessions` picker shows each session's project, first message, last-updated time, and message count — and filters as you type. The search matches the project path, session id, and **every user/assistant message in the thread**: substring matches rank first (earlier = higher), then in-order subsequence matches (so minor typos still hit). `Backspace` edits the query, `Esc` closes, `Enter` resumes the highlighted session. Deleting goes through the `Delete a session` row at the bottom (find it by typing its name).

`/continue` is the quick path: it finds the most recently updated session that isn't the current one and switches to it — autosaving the current session first if it has messages. If there's no other session to resume, it shows a notice. This is the in-session equivalent of `cast -c`.

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

## Usage Tracking

```
/usage
```

Shows cumulative token and cost usage for the current session, including breakdown by cache hits, cache writes, uncached tokens, and sub-agent tokens.
