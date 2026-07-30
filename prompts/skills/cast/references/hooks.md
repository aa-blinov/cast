Hooks are shell commands, HTTP callbacks, MCP tool calls, or model prompts that fire at agent lifecycle events. Config shape matches Claude Code's protocol — real `hooks.json` files from Claude Code plugins load unmodified.

**Locations** (merged, all apply):

1. `~/.cast/hooks.json` — global, always applies
2. `.cast/hooks.json` — project (trust-gated, same as mcp.json)
3. `<plugin root>/hooks/hooks.json` — plugin-contributed (auto-merged on install)

**File format:**

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "command": "scripts/check.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "command": "scripts/lint.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "scripts/verify.sh", "timeout": 300 }] }
    ]
  }
}
```

A bare `{ "PreToolUse": [...] }` (no wrapping `"hooks"` key) works too. Unrecognized event names are skipped, so a hooks file shared with another tool still loads.

**Key events:**

| Event | Fires | Can block? |
|-------|-------|-----------|
| `SessionStart` | Session starts | No |
| `UserPromptSubmit` | User submits a prompt | Yes |
| `PreToolUse` | Before tool runs | Yes — can deny or rewrite args |
| `PostToolUse` | After tool succeeds | No (can rewrite result) |
| `PermissionRequest` | Bash confirmation dialog | Yes — can approve/deny |
| `Stop` | Agent would end turn | Yes — can keep it going |
| `SubagentStart`/`SubagentStop` | Subagent lifecycle | No |
| `PreCompact`/`PostCompact` | Context compaction | No |

**Hook types:** `command` (shell, default), `http` (POST), `mcp_tool` (call MCP tool), `prompt` (one-shot model completion with `{"ok":true/false}` output).

**Response contract:** exit 2 or `{"decision":"block"}` blocks. `{"hookSpecificOutput":{"updatedInput":{...}}}` rewrites tool args. `{"hookSpecificOutput":{"additionalContext":"..."}}` appends context without blocking. `{"continue":false}` force-stops the turn.

**Matcher:** regex tested against tool name (for tool events), subagent name (for SubagentStart/Stop), or ignored for events with no natural target. Case-insensitive. Supports pipe-separated exact matches (`Write|Edit`).

**Env vars** (command hooks): `CAST_HOOK_EVENT`, `CAST_SESSION_ID`, `CAST_WORKSPACE_ROOT`, `CAST_PLUGIN_ROOT`/`CAST_PLUGIN_DATA` (plugin hooks only). Reserved keys in hook's own `env` field are stripped.

**Commands:**

```
/hooks                           # list all hooks with stable ids
/hooks enable <id>               # enable a hook
/hooks disable <id>              # disable a hook
/hooks help                      # cheat sheet
```

State persists in `~/.cast/settings.json` (`disabledHooks`). Takes effect on the next message, no restart.

**Example — create a hook:**

```bash
mkdir -p ~/.cast
cat > ~/.cast/hooks.json << 'EOF'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "command": "echo 'Checking: $CAST_HOOK_EVENT' 1>&2" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "echo 'Turn ending'" }] }
    ]
  }
}
EOF
```

Full documentation: `docs/hooks.md`.
