# Hooks

Shell commands, HTTP callbacks, MCP tool calls, or one-shot model prompts that fire at agent lifecycle events. Config shape and response contract match Claude Code's official protocol (`code.claude.com/docs/en/hooks`) closely enough that a real-world `hooks.json` — including ones shipped inside installed Claude Code plugins — loads and runs unmodified for everything listed below.

## Events

| Event | Fires | Blocking? |
|-------|-------|-----------|
| `SessionStart` | A session starts (fresh or resumed) | No |
| `UserPromptSubmit` | You submit a prompt | **Yes** — can reject the prompt outright |
| `UserPromptExpansion` | A `/skill-name` or `/rule:name` invocation expands into its prompt content | No |
| `PreToolUse` | Before a tool runs | **Yes** — can deny the call, or rewrite its arguments |
| `PermissionRequest` | The bash tool is about to ask for interactive confirmation | **Yes** — can approve/deny before the real prompt shows |
| `PermissionDenied` | A bash confirmation was denied (by a hook or by the user) | No |
| `PostToolUse` | After a tool completes successfully | No (but can rewrite the result) |
| `PostToolUseFailure` | After a tool completes with an error | No (but can rewrite the result) |
| `PostToolBatch` | After a batch of parallel tool calls in one turn | No |
| `SubagentStart` | A `task` subagent starts | No |
| `SubagentStop` | A subagent's turn ends | No (see Scope below) |
| `TaskCreated` | A new item is added via the `todo_write` tool | No |
| `TaskCompleted` | A todo item's status becomes `completed` | No |
| `PreCompact` | Automatic context compaction is about to run | No |
| `PostCompact` | Automatic context compaction completes | No |
| `InstructionsLoaded` | AGENTS.md/CLAUDE.md and always-apply rules load for a session | No |
| `Stop` | The agent would end its turn | **Yes** — can keep it going |
| `StopFailure` | A turn ends because of an API error | No — observation only |

"Blocking" means the hook can change what happens next. Every other event is passive — its exit code/output never changes the run, only what gets logged, or (for `UserPromptSubmit`) appended to the prompt as extra context when it *doesn't* block.

## Hook types

Each entry in a matcher group's `hooks` array is one of:

```json
{ "type": "command", "command": "scripts/check.sh", "timeout": 10 }
{ "type": "http", "url": "https://hooks.example.com/event", "timeout": 15 }
{ "type": "mcp_tool", "server": "guard", "tool": "check_command", "input": { "cmd": "${tool_input.command}" } }
{ "type": "prompt", "prompt": "Is this safe? ${tool_input.command}\nRespond yes/no.", "model": "gpt-4.1" }
```

- **`command`** (default `type`) — a shell command. Relative paths resolve against the cwd the hook runs for.
- **`http`** — POSTs the event envelope as the JSON body; the response body is read the same way stdout is.
- **`mcp_tool`** — calls an already-connected MCP server's tool (`server`/`tool` unqualified names) and interprets its result the same way as a command hook's stdout. No-ops (fails open) if that server/tool isn't connected.
- **`prompt`** — a short, tool-free, capped (200 token) model completion. A response starting with "yes" (case-insensitive) blocks, with the full response as the reason — this is cast's documented convention for the ambiguous "respond yes/no" pattern in the official docs, since the exact interpretation isn't otherwise specified. No-ops if the caller didn't have model/config access at that point in the run (see Scope).

`input`/`prompt` support `${field.path}` interpolation against the event's JSON payload (e.g. `${tool_input.command}`, `${cwd}`). Unresolvable paths are left as the literal placeholder.

`timeout` defaults to 30s, except `Stop`/`SubagentStop` which default to 600s (they commonly run a build or test suite).

## Config

Three sources, merged (a group from each applies — they don't override each other):

- `~/.cast/hooks.json` — global, always applies
- `.cast/hooks.json` — project-local, **trust-gated** the same as `.cast/mcp.json`: only read for a trusted project, since a hook is an arbitrary shell command
- `<installed plugin root>/hooks/hooks.json` — Claude Code's real convention for plugin-contributed hooks (falls back to a bare `<root>/hooks.json` too). Always applies — installing a plugin is already an explicit trust decision.

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "command": "scripts/check-command.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "^(write|edit)$", "hooks": [{ "command": "scripts/lint-changed.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "scripts/check-todos-done.sh", "timeout": 300 }] }
    ]
  }
}
```

A bare `{ "PreToolUse": [...] }` (no wrapping `"hooks"` key) works too. Unrecognized event names are skipped rather than erroring, so a hooks file shared with another tool's config still loads.

**Matcher**, per event's natural target:

| Event | Matches against |
|-------|-----------------|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | Tool name |
| `SubagentStart`, `SubagentStop` | Subagent persona name |
| `UserPromptExpansion` | The skill or rule name being invoked |
| Everything else | Ignored — matches everything |

## Writing a hook

The hook receives one JSON object on **stdin** (or as the HTTP/`mcp_tool` payload):

```json
{ "hook_event_name": "PreToolUse", "cwd": "/path/to/project", "session_id": "…", "tool_name": "bash", "tool_input": { "command": "rm -rf build" } }
```

`PostToolUse`/`PostToolUseFailure` payloads add `tool_response` (the tool's result content).

### Response contract

- Exit **2**, or `{"decision":"block","reason":"..."}` on stdout — blocks.
- `{"hookSpecificOutput":{"additionalContext":"..."}}` — same "keep going" effect as a block, without being logged as an error.
- **`PreToolUse` only** — `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"...","updatedInput":{...}}}`:
  - `permissionDecision: "deny"` blocks, same as `decision:"block"` (with `permissionDecisionReason` as the reason).
  - `updatedInput` replaces the tool call's arguments with whatever object you provide, before it runs — works whether or not the call is also allowed/denied.
  - `permissionDecision: "ask"`/`"defer"` are accepted but resolved as `allow` — cast has no interactive mid-turn prompt to actually honor them (see Scope) — a warning is surfaced instead.
- **`PostToolUse`/`PostToolUseFailure` only** — `{"hookSpecificOutput":{"updatedToolOutput":"..."}}` replaces the tool's result content outright, instead of the block-appends-feedback behavior.
- **`Stop`/`SubagentStop` only** — `{"continue":false,"stopReason":"..."}` force-ends the turn/run right now, overriding a block from another hook in the same run.
- Any other non-zero exit is a non-blocking failure — the hook is ignored and the run continues normally. A hook that never responds is killed after its `timeout`.

A `Stop` block can't loop forever: after 8 continuations in one turn (matching the official cap), the gate is overridden and the turn ends regardless.

### Environment variables (`command` hooks)

| Variable | Value |
|----------|-------|
| `CAST_HOOK_EVENT` | The event name, e.g. `PreToolUse` |
| `CAST_SESSION_ID` | The current session id |
| `CAST_WORKSPACE_ROOT` | The cwd the hook is running for |
| `CAST_PLUGIN_ROOT` / `CAST_PLUGIN_DATA` | Plugin install dir / writable per-plugin data dir (plugin-contributed hooks only) |
| `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` | Aliases for the two above — real plugin scripts (e.g. `anthropics/claude-plugins-official`'s "hookify") reference `${CLAUDE_PLUGIN_ROOT}` directly |

Reserved `CAST_*`/`CLAUDE_PLUGIN_*` keys in a hook's own `env` field are silently stripped — the runner always injects the real values.

## Managing hooks

`/hooks` lists every merged hook (global/project/plugin) with a stable id, its event, matcher, and enabled/disabled state. `/hooks enable <id>` / `/hooks disable <id>` toggles one, `/hooks help` shows a cheat sheet. State is per-user (`~/.cast/settings.json`'s `disabledHooks`), takes effect on the very next message (no restart), and survives edits to unrelated hooks in the same file since the id is derived from the hook's own content. The web UI has the same thing under **Settings → Hooks**.

## Plugins

An installed plugin can ship its own `<plugin root>/hooks/hooks.json` (same shape as above, no wrapping `"hooks"` key needed) — this is the same location Claude Code plugins already use, verified against real plugins like `anthropics/claude-plugins-official`'s "hookify" and "ralph-loop". Enabled plugins' hook files are merged in automatically — no separate registration step, matching how plugin skills already work.

## Scope — what's implemented vs. not

This is a **compatible subset** of Claude Code's protocol, not a byte-for-byte clone — built from the official public documentation, deliberately never from any leaked/decompiled source. Everything in the tables above works as described. What's out of scope, and why:

**Events cast has no infrastructure to fire at all** (not missing wiring — the underlying subsystem doesn't exist):
- `Setup` — no CLI init/maintenance-mode concept.
- `TeammateIdle` — no persistent "teammate" background agents.
- `ConfigChange`, `FileChanged` — no filesystem watcher anywhere in cast.
- `WorktreeCreate`/`WorktreeRemove` — cast doesn't manage git worktrees.
- `Elicitation`/`ElicitationResult` — cast's MCP client doesn't implement the MCP elicitation capability.
- `MessageDisplay` — text streams incrementally token-by-token; there's no single "a message displayed" moment to fire on without either firing once per token (useless) or reinventing the turn-boundary logic `Stop` already covers.
- `CwdChanged` — cast has no "change the cwd of a live session" operation (no `cd` tool, no in-place directory switch); switching to a *different* session entirely is a distinct concept, not a cwd change on the same one, so it isn't a good-faith fit for this event either.

**Accepted as input but resolved as a fixed choice, not truly honored**, because cast has no interactive mid-turn escalation path a hook can suspend the run for:
- `PreToolUse`'s and `PermissionRequest`'s `ask`/`defer` permission decisions both resolve as `allow` (with a warning).

**Not implemented for architectural reasons**:
- The `agent` hook type (spawn a subagent to verify) — `task.ts` (the subagent executor) already imports this module for `HooksFile`; importing it back for the `agent` type would create a real circular module dependency. Use `prompt` (a one-shot completion) or `mcp_tool` instead.

**Scope limitations worth knowing about**:
- `PreCompact`/`PostCompact` only fire around **automatic** compaction (the threshold/overflow triggers inside the agent loop) — not the manual `/compact` command.
- `SubagentStart`/`SubagentStop` are a *separate*, observation-only "a subagent started/finished" signal for logging — a subagent's own turn-ending decision is governed by its own recursive `Stop` handling (hooks are inherited from the parent), not by `SubagentStop`. `SubagentStop` here can't itself block/continue a subagent's turn the way the official `Stop`-style decision control can.
- `prompt`-type hooks need model/provider config, which not every event has in scope (e.g. `SessionStart`) — they no-op (fail open) rather than error when it's unavailable.

Hooks apply to the main agent and are inherited by subagents (`task` tool) — a `PreToolUse` gate on `bash` applies whether `bash` is called by the main agent or a subagent it spawned.
