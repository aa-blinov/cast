# Sessions

Every conversation is automatically saved and can be resumed later.

## Session Storage

Sessions are stored as JSON files in `~/.cast/sessions/`:

```
~/.cast/sessions/
  --Users-me-my-project--/
    nd4k8f2x.json
    m2p9ab3c.json
  --Users-me-other-project--/
    q7r1ts5v.json
```

Sessions are grouped by the project directory (`cwd`) they were created in. The directory name is an encoded version of the absolute path.

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

### Interactive

```
/sessions                  # Opens session picker
```

The picker shows sessions with their id, message count, model, and last-updated time. Type `d<N>` to delete a session.

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
5. The summary replaces the old messages as a system message

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
