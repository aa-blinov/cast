# CLI Reference

## Usage

```
cast [options] [prompt]
cast run [options] <message>    Non-interactive mode
    cast web [start|stop|status]    Web UI mode
    cast upgrade [version] [--force]  Self-update
```

TUI mode (Ink-based, multiline paste, image attachments) is the default. Non-TTY contexts (pipes, CI) are not supported — use `cast run` for scripting.

## Subcommands

### `cast` (default)

Launch the interactive TUI. Any text after the flags is sent as the first prompt.

```bash
cast                          # Launch interactively
cast "explain this project"   # Launch with an initial prompt
```

### `cast run`

Non-interactive mode: send one prompt, stream the response to stdout, exit. Designed for CI/CD, scripting, and piping.

```bash
cast run "what changed in the last commit"
cast run --format json "list all TODO comments"
cast run -c "continue the refactoring"
```

See [Non-Interactive Mode](non-interactive-mode.md) for output formats and JSON event types.

### `cast upgrade`

Re-run the installer to update cast. Only works for release installs (not `npm link` / dev mode).

```bash
cast upgrade              # Upgrade to latest
cast upgrade 0.3.0        # Upgrade to specific version
cast upgrade --force      # Reinstall even if same version
```

### `cast web`

Web UI mode: launches a browser-based control room for managing background agents. Runs alongside the TUI — same sessions, same core engine.

```bash
cast web                 # Start in background (daemon)
cast web start           # Same as above
cast web stop            # Stop the background server
cast web status          # Check if running
cast web --foreground    # Run inline (for dev/debug)
cast web --port 8080     # Custom port (default: 3117, or set CAST_WEB_PORT)
```

First run generates a password, printed to the terminal and saved in `~/.cast/settings.json`. Username is always `cast`.

Features:
- Create/switch/close sessions with different personas, running independently in parallel
- Token-by-token streaming, with reasoning and tool calls shown inline as they happen
- Tool call cards showing arguments and status
- Git diff viewer (file tree + unified diff) as a resizable side panel, auto-refreshing after each tool call
- Settings modal (gear icon) — model & reasoning, color theme, web tools toggle, bash confirmation mode, and management for MCP servers, skills, plugins, providers, and SSH hosts; shared with the TUI's `~/.cast/settings.json`
- Status popover (info icon) — persona, model, mode, token usage, and git branch for the active session
- Keyboard shortcuts — `Ctrl+B` (`⌘B` on Mac) toggles the sidebar, `Ctrl+Shift+D` / `N` / `L` toggle the diff panel / start a new session / clear context, `Ctrl+/` shows the full reference
- All slash commands, non-blocking ones work while agent runs
- Mobile/tablet/desktop responsive — sidebar and diff panel become touch-friendly slide-over drawers on narrow screens
- Auth via standard HTTP Basic Auth — the browser's own credential prompt, no custom login page

On Windows, prints the install command to run in a new terminal (can't self-replace running process files).

## Options

### Model Selection

| Flag | Short | Description |
|------|-------|-------------|
| `--model <model>` | `-m` | Model name (validated on startup against the provider) |
| `--reasoning <level>` | `-r` | Reasoning level: `off`, `low`, `medium`, `high`, `max` |
| `--persona <name>` | `-p` | Persona to use (see `/personas` for the list) |

```bash
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"
cast -p senior "review this PR"
```

### Session Management

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Resume the most recently updated session |
| `--resume` | | Pick which session to resume (numbered list) |
| `--resume=<id>` | | Resume a specific session by id |
| `--session <id>` | `-s` | Resume a specific session (alias for `--resume=<id>`) |

```bash
cast -c                           # Resume last session
cast --resume                     # Pick from a list
cast --resume=nd4k8f2x            # Resume by id
cast -s nd4k8f2x "keep working"   # Resume + initial prompt
```

### Permissions

| Flag | Description |
|------|-------------|
| `--bypass-permissions` | Skip confirmation for dangerous bash commands this run only |

See [Tools](tools.md#dangerous-command-gating) for the list of patterns that trigger confirmation.

### Skills and MCP

| Flag | Description |
|------|-------------|
| `--skill <path>` | Load an extra skill file or directory (repeatable) |
| `--no-skills` | Skip project/agents/global/plugin/builtin skill discovery |
| `--mcp <path>` | Load an extra MCP server config file (repeatable) |
| `--no-mcp` | Skip global/project MCP server discovery |

`--skill` and `--mcp` paths work even with `--no-skills` / `--no-mcp` — they're explicit additions, not discovery.

```bash
cast --skill ./my-skill.md
cast --no-skills --skill ~/.cast/skills/arxiv/SKILL.md
cast --mcp ./custom-mcp.json
```

### General

| Flag | Short | Description |
|------|-------|-------------|
| `--version` | `-v` | Show installed version |
| `--help` | `-h` | Show help text |

## `cast run` Flags

The `run` subcommand accepts a subset of the main flags:

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Continue the most recent session |
| `--session <id>` | `-s` | Continue a specific session |
| `--model <model>` | `-m` | Model to use |
| `--reasoning <level>` | `-r` | Reasoning level |
| `--persona <name>` | `-p` | Persona to use |
| `--format <default\|json>` | | Output format |
| `--bypass-permissions` | | Skip bash confirmation prompts |
| `--skill <path>` | | Load extra skill (repeatable) |
| `--no-skills` | | Skip project/agents/global/plugin/builtin skill discovery |
| `--mcp <path>` | | Load extra MCP config (repeatable) |
| `--no-mcp` | | Skip MCP discovery |

```bash
cast run --format json "list all test files"
cast run -m gpt-4o -r medium "explain the session module"
```
