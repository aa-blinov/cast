# Interactive Commands

All commands are typed at the TUI prompt, prefixed with `/`. Unknown slash commands are submitted to the agent as regular text (useful for paths starting with `/`).

## Session Management

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (autosaves current if non-empty) |
| `/continue` | Resume the most recent session (like `cast -c`, but mid-session) |
| `/fork` | Create a new session from the current safe context and switch to it |
| `/worktree <name>` | Switch current session into an isolated git worktree (`list`, `remove <name>`) |
| `/sessions` | Session picker with type-to-filter search (by message text, project path, or id); switch or delete |
| `/clear` | Clear conversation context (and save the cleared state) |
| `/compact` | Force context compaction now (auto-triggers near the limit) |
| `/dream` | Verify the recent project trajectory and consolidate durable project memory |
| `/distill` | Verify repeated work and package high-confidence workflows as a skill, persona, or command |
| `/undo` | Undo the last turn: restore files from the most recent checkpoint and drop the last user message (and everything after it) |
| `/copy` | Copy last assistant response to clipboard |
| `/current` | Show all status bar data (even disabled segments) |
| `/quit`, `/exit` | Save and exit |

`/undo` requires a checkpoint from the previous turn. In a Git workspace, every file is restored to its pre-turn tree without changing the user's Git index; files created during the turn are removed, while files that were untracked before the turn are restored. Outside Git, Cast restores files changed through its `write` and `edit` tools from shadow backups. Arbitrary changes made through `bash` or an MCP tool in a non-Git workspace cannot be reversed. `/undo` is refused while the agent is running (use `/abort` first) and is a no-op if there is nothing to undo.

`/fork` leaves the original session unchanged and starts an independent new session with the context currently sent to the model. It deliberately does not restore compacted-out history, copy checkpoints or pending pickers, or create a Git worktree: both sessions use the same working directory unless you switch one with `/worktree`.

## Model and Provider

| Command | Description |
|---------|-------------|
| `/model` | Open model picker (shows current model) |
| `/model <name>` | Switch to a specific model (validated) |
| `/subagent-model` | Open model picker for sub-agents |
| `/subagent-model <name>` | Switch sub-agent model |
| `/subagent-model-provider [name\|off]` | Show/change the saved provider used for the sub-agent model |
| `/plan-model [name\|off]` | Show/change the model used in plan mode |
| `/plan-model-provider [name\|off]` | Show/change the saved provider used for the plan model |
| `/reasoning` | Change reasoning level (opens picker if model supports it) |
| `/reasoning-display` (`/rd`) | Toggle reasoning blocks in the transcript — off by default since reasoning models stream a lot of auxiliary thinking that clutters the chat |
| `/reasoning-format` | Select the reasoning request protocol for the active provider |
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
| `/hooks` | List lifecycle hooks; also `enable`/`disable <id>` and `help` |
| `/reload` | Re-scan skills, rules, MCP servers, personas, and context files for cwd |

Bare `/skills` / `/mcp` / `/plugin` = multi-select toggle. `list` is read-only. `uninstall` always confirms (picker or typed). See [Skills](skills.md), [MCP](mcp-servers.md), [Plugins](plugins.md).

### Hot-reload vs `/reload`

You never need to quit cast or start a new session for these changes. The current chat continues.

| Change | Apply how |
|--------|-----------|
| `/skills` / `/mcp` / `/plugin` toggle, `enable` / `disable` | Automatic (hot-reload) |
| `/plugin install` / `uninstall`, `/skills uninstall`, `/mcp uninstall` | Automatic |
| `/plugin marketplace remove` (drops installed packs) | Automatic (skills reload) |
| New/edited files on disk: skills, `mcp.json`, rules, personas, context files (including `npx skills add`) | `/reload` refreshes the current resource catalog; persona overrides created in chat are picked up automatically on the next user message |

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

## Autonomous and Self-Verification

| Command | Description |
|---------|-------------|
| `/goal <description>` | Work autonomously toward a goal until it's done — bounded, never-ask |
| `/review` | Ask the agent to review and verify its own work |

**`/goal <description>`** runs one autonomous turn that keeps iterating (tools → verify → fix → repeat) until the goal is met, without yielding back to ask for permission. At most one clarifying question (via the `question` tool) if the goal is genuinely ambiguous. The run is bounded to **25 model calls** so it can't loop forever on unproductive tool calls — the model is nudged near the cap and a warning fires if it's hit. Use it for start-to-finish tasks: "fix the tests", "set up the project and make the first commit", "implement X and verify it runs". Works in the TUI and the web composer.

**`/review`** asks the agent to verify its own most recent work: identify what changed (git diff / touched files), find and run the project's test and lint commands, and report honestly what was verified and what remains open — it never claims a check it didn't actually run.

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

Token usage and context size are shown automatically in the TUI status bar (prompt tokens in, completion tokens out, prompt-cache hit %, cost, context percentage, tokens/second, and sub-agent tokens).

Use `/statusbar` to toggle individual segments on/off and reorder them — useful on narrow terminals where the full bar overflows. Segments can be moved between the left and right sides of the bar with ←/→, and reordered within each side with j/k. Default: persona, mode, model (left) and elapsed (right); enable others via `/statusbar`.

| Command | Description |
|---------|-------------|
| `/current` | All status bar data: model, context, tokens in/out with cache %, cost, sub-agent tokens, repo, session |

## Configuration

| Command | Description |
|---------|-------------|
| `/permissions` | Open permission mode picker |
| `/permissions default` | Switch to gated mode (confirm dangerous commands) |
| `/permissions bypass` | Switch to bypass mode (no confirmation) |
| `/web` | Toggle web tools (web_search, web_fetch) on/off |
| `/web-search-provider` | Switch the `web_search` backend between DuckDuckGo (free, rate-limited), Tavily (API key, 1000 free/month), and Brave Search (API key) |
| `/web-fetch-provider` | Switch `web_fetch` between Jina Reader and direct local fetch |
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
