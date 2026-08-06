# CLI Reference

## Usage

```
cast [options] [prompt]
cast run [options] <message>    Non-interactive mode
cast run --interactive [options] Persistent JSONL session
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

`cast run --interactive` keeps one real session open over JSONL. It is suited
to eval runners and programmatic clients that must react to `question` and
plan-review state between agent turns.

### `cast upgrade`

Re-run the installer to update cast. Only works for release installs (not `npm link` / dev mode).

```bash
cast upgrade              # Upgrade to latest
cast upgrade 0.3.0        # Upgrade to specific version
cast upgrade --force      # Reinstall even if same version
```

### `cast web`

Web UI mode: launches a browser-based control room for managing background agents. The `cast web` daemon is the single writer for every session — both the browser and the TUI are thin clients of it over HTTP + SSE, so a session opened in either surface streams live (tokens, tool calls, status) to both. The TUI auto-spawns this daemon on launch unless one is already running or `CAST_NO_DAEMON=1` is set.

```bash
cast web                 # Start in background (daemon)
cast web start           # Same as above
cast web stop            # Stop the background server (SIGTERM → SIGKILL after 3s)
cast web status          # Check if running (auto-heals stale state)
cast web --foreground    # Run inline (for dev/debug)
cast web --port 8080     # Custom port (default: 1337, or set CAST_WEB_PORT)
cast web --host 0.0.0.0  # Bind to all interfaces (reachable from network)
cast web --public        # Alias for --host 0.0.0.0
```

First run generates a password, printed to the terminal and saved in `~/.cast/settings.json`. Username is always `cast`.

Binding to a non-loopback address (`--host 0.0.0.0` or `--public`) exposes plain HTTP. Use it only on a trusted LAN: without HTTPS, a network observer can read the password and session. For remote access without a domain, keep the default loopback binding and use `ssh -L 1337:127.0.0.1:1337 user@host`.

Starting when another instance is already running prints an error and exits. `stop` gracefully shuts down open sessions (SIGTERM), escalating to SIGKILL after 3 seconds if the process doesn't exit. If the recorded process is already gone (crash, OOM, `kill -9`), `status` and `stop` detect the stale state, clean up, and report honestly.

Features:
- Create/switch/close sessions with different personas, running independently in parallel
- Modal for new sessions supports working directory selection, optional git-worktree isolation (`.cast/worktrees/<name>`), persona selection, and per-session model overrides
- Session sidebar groups threads by working directory: Quick sessions use a `Sandbox` group, while project sessions use the directory name rather than the full path. Groups are ordered by latest activity; pinned and running threads stay at the top of their own group. Hover a group name to see its full path.
- Token-by-token streaming, with reasoning and tool calls shown inline as they happen
- Tool call cards showing arguments and status
- Git diff viewer (file tree + unified diff) as a resizable side panel, auto-refreshing after each tool call
- File reader popup with wrapped text/code and source-line numbers; Markdown, CSV/TSV, images, and PDFs use their dedicated previews
- Settings modal (gear icon) — model & reasoning, color theme, web tools toggle, bash confirmation mode, Quick session persona, and management for MCP servers, skills, plugins, hooks, providers, and SSH hosts; shared with the TUI's `~/.cast/settings.json`
- Status popover (info icon) — persona, model, mode, token usage, and git branch for the active session
- Keyboard shortcuts — `Ctrl+B` (`⌘B` on Mac) toggles the sidebar, `Ctrl+Shift+D` / `N` / `L` toggle the diff panel / start a new session / clear context, `Ctrl+/` shows the full reference
- Chat slash commands are available in the composer; provider, MCP, skills, plugins, hooks, and SSH are managed through Settings. Non-blocking commands work while an agent runs.
- Mobile/tablet/desktop responsive — sidebar and diff panel become touch-friendly slide-over drawers on narrow screens
- Themed sign-in screen with an HttpOnly, SameSite session cookie; repeated failed sign-ins are rate-limited

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
| `--worktree <name>` | `-w` | Run in an isolated git worktree created at `.cast/worktrees/<name>` |

```bash
cast -c                           # Resume last session
cast --resume                     # Pick from a list
cast --resume=nd4k8f2x            # Resume by id
cast -s nd4k8f2x "keep working"   # Resume + initial prompt
cast -w feature-x                 # Run in an isolated git worktree
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
| `--worktree <name>` | `-w` | Run in an isolated git worktree |
| `--model <model>` | `-m` | Model to use |
| `--reasoning <level>` | `-r` | Reasoning level |
| `--persona <name>` | `-p` | Persona to use |
| `--format <default\|json>` | | Output format |
| `--interactive` | | Persistent JSONL session protocol; no positional message |
| `--bypass-permissions` | | Skip bash confirmation prompts |
| `--skill <path>` | | Load extra skill (repeatable) |
| `--no-skills` | | Skip project/agents/global/plugin/builtin skill discovery |
| `--mcp <path>` | | Load extra MCP config (repeatable) |
| `--no-mcp` | | Skip MCP discovery |

```bash
cast run --format json "list all test files"
cast run -m gpt-4o -r medium "explain the session module"
```
