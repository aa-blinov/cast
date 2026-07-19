# Interactive Commands

All commands are typed at the TUI prompt, prefixed with `/`. Unknown slash commands are submitted to the agent as regular text (useful for paths starting with `/`).

## Session Management

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (autosaves current if non-empty) |
| `/continue` | Resume the most recent session (like `cast -c`, but mid-session) |
| `/sessions` | Session picker with type-to-filter search (by message text, project path, or id); switch or delete |
| `/clear` | Clear conversation context (and save the cleared state) |
| `/compact` | Force context compaction now (auto-triggers near the limit) |
| `/copy` | Copy last assistant response to clipboard |
| `/current` | Show all status bar data (even disabled segments) |
| `/quit`, `/exit` | Save and exit |

## Model and Provider

| Command | Description |
|---------|-------------|
| `/model` | Open model picker (shows current model) |
| `/model <name>` | Switch to a specific model (validated) |
| `/subagent-model` | Open model picker for sub-agents |
| `/subagent-model <name>` | Switch sub-agent model |
| `/reasoning` | Change reasoning level (opens picker if model supports it) |
| `/provider` | Open provider picker (switch, add, or delete providers) |
| `/provider add` | Add a new provider (name → URL → key wizard) |
| `/provider delete` | Delete a provider |
| `/provider <name>` | Switch to a named provider |

## Persona

| Command | Description |
|---------|-------------|
| `/persona` | Open persona picker |
| `/persona <name>` | Switch to a specific persona |

See [Personas](personas.md) for the full list.

## Skills and MCP

| Command | Description |
|---------|-------------|
| `/skills` | Toggle skills on/off (multi-select). Also: `list`, `enable`/`disable`, `uninstall`, `help` |
| `/skill:<name> [args]` | Force-load and run a skill by name |
| `/plugin` | Toggle installed plugins. Palette also has install / list / enable / uninstall / marketplace / help |
| `/mcp` | Toggle MCP servers on/off. Also: `list`, `enable`/`disable`, `uninstall`, `help` |
| `/reload` | Re-scan skills, rules, MCP servers, and personas for cwd |

Bare `/skills` / `/mcp` / `/plugin` = multi-select toggle. `list` is read-only. `uninstall` always confirms (picker or typed). See [Skills](skills.md), [MCP](mcp-servers.md), [Plugins](plugins.md).

### Hot-reload vs `/reload`

You never need to quit cast or start a new session for these changes. The current chat continues.

| Change | Apply how |
|--------|-----------|
| `/skills` / `/mcp` / `/plugin` toggle, `enable` / `disable` | Automatic (hot-reload) |
| `/plugin install` / `uninstall`, `/skills uninstall`, `/mcp uninstall` | Automatic |
| `/plugin marketplace remove` (drops installed packs) | Automatic (skills reload) |
| New/edited files on disk: skills, `mcp.json`, rules, personas, context files (including `npx skills add`) | `/reload` in the same session |

`/reload` only re-scans cwd resources — it does **not** reset the conversation.

## Rules

| Command | Description |
|---------|-------------|
| `/rules` | List loaded rules with their apply mode, globs, and scope |
| `/rule:<name>` | Invoke a rule by name (loads its full content into context) |

See [Rules](rules.md) for rule types and creation.

## Plan Mode

| Command | Description |
|---------|-------------|
| `/plan` | Enter plan mode (explore and plan only, no code changes) |
| `/build` | Exit plan mode, restore full toolset |
| `/plan-model [name\|off]` | Show/change the model used while plan mode is active |

See [Plan Mode](plan-mode.md) for the full workflow.

## Steering

These commands work while the agent is running:

| Command | Short | Description |
|---------|-------|-------------|
| `/steer <message>` | `/s` | Inject a message into the running turn |
| `/queue <message>` | `/q` | Queue a message for after the current turn |
| `/queue-reset` | `/qr` | Clear the message queue |
| `/abort`, `/stop` | | Stop current agent run |

**`/steer`** interrupts the current turn with new context — the message is injected immediately into the conversation, and the agent sees it on the next tool-call iteration. Useful for correcting course mid-execution.

**`/queue`** saves a message to run after the agent finishes its current turn. The message becomes a new turn automatically.

If nothing is running, both `/steer` and `/queue` submit the message as a normal prompt.

**`/abort`** stops the current run and clears both the steering and follow-up queues — anything queued before the abort is discarded.

Both steering and follow-up messages reset the doom loop counter — repeating a failing command after user guidance is treated as a new attempt, not a loop.

## Context and Usage

Token usage and context size are shown automatically in the TUI status bar (prompt tokens in, completion tokens out, context percentage, tokens/second, and sub-agent tokens).

Use `/statusbar` to toggle individual segments on/off and reorder them — useful on narrow terminals where the full bar overflows. Segments can be moved between the left and right sides of the bar with ←/→, and reordered within each side with j/k. Default: persona, mode, model (left) and elapsed (right); enable others via `/statusbar`.

| Command | Description |
|---------|-------------|
| `/usage` | Show cumulative session token/cost usage (prompt, completion, cache hits, sub-agent tokens) |

## Configuration

| Command | Description |
|---------|-------------|
| `/permissions` | Open permission mode picker |
| `/permissions default` | Switch to gated mode (confirm dangerous commands) |
| `/permissions bypass` | Switch to bypass mode (no confirmation) |
| `/web` | Toggle web tools (web_search, web_fetch) on/off |
| `/statusbar` | Toggle and reorder status bar segments (multi-select picker) |
| `/theme` | Open theme picker |
| `/theme <id>` | Switch to a specific theme |

## Utility

| Command | Description |
|---------|-------------|
| `/repo` | Show cwd, git branch, dirty state, remote, and HEAD |
| `/keys` | List all keybindings |
| `/help` | Show the command list |
| `/ssh` | Manage SSH hosts — list, add, remove (persists to `~/.cast/ssh.json`) |

## Keybindings

| Action | Keys |
|--------|------|
| Cursor up/down/left/right | ↑ / ↓ / ← / → |
| Word left/right | Alt+← / Alt+→ (or Ctrl+← / Ctrl+→) |
| Line start/end | Home / End (or Ctrl+A / Ctrl+E) |
| Delete char | Backspace / Delete |
| Delete word | Ctrl+W / Alt+Backspace |
| Delete to line start | Ctrl+U |
| Delete to line end | Ctrl+K |
| New line | Shift+Enter / Ctrl+J / Alt+Enter |
| Submit | Enter |
| Stop turn / clear input | Esc |
| Exit (2× to confirm) | Ctrl+C |
| Attach image | Ctrl+G |
| Autocomplete | Tab |

**Esc** stops the current turn while generating; clears the input otherwise.

**Ctrl+C** — press twice within 2s to exit. Does not stop a turn — use Esc for that.

## During a Running Agent

While the agent is executing, only these commands are accepted:

- `/steer` / `/s` — inject context
- `/queue` / `/q` — queue follow-up
- `/queue-reset` / `/qr` — clear queue
- `/abort` / `/stop` — stop the run

All other input is rejected with a notice. Use Esc to stop the current turn (clears input when idle).
