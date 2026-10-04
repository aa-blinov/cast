# CLI Reference

## Usage

```
cast [options] [prompt]
cast run [options] <message>    Non-interactive mode
cast run --interactive [options]      Persistent JSONL session
cast web [start|stop|status]          Browser-based control room
cast server [start|stop|status]       Alias for cast web
cast upgrade [version] [--force]      Self-update
cast shell-init [zsh|bash|fish]       A shell function that puts the resume command in your history
cast requests <session> [n]           What the model was sent
cast lsp <operation> <file> [...]     Ask a language server, as the lsp tool does
```

TUI mode (full-screen, own scrolling, multiline paste, image attachments) is the default. Non-TTY contexts (pipes, CI) are not supported. Use `cast run` for scripting.

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

### `cast shell-init`

Prints a `cast` shell function (zsh, bash or fish; by default the one in `$SHELL`). When a `cast` session ends, the function adds `cast --resume=<id>` to the shell's history, so Up brings it back. A session with no turn adds `cast --continue` instead (the folder's latest session), and a folder with no history adds nothing. A child process cannot write its parent shell's history, which is why this is a function in the shell, not something `cast` does itself. `cast run`, `cast upgrade` and the other subcommands add nothing.

```bash
cast shell-init >> ~/.zshrc            # once; use ~/.bashrc for bash
eval "$(cast shell-init)"              # or on every start (slower: it starts cast each time)
```

At exit `cast` leaves the command in `~/.cast/last-resume` (`$CAST_HOME/last-resume` if set); the function reads it and removes it. The line `Resume this session: …` is still printed for terminals without the function.

### `cast requests`

Print the request log of a session: every request cast sent to the model, exactly as it went out (see [Sessions](sessions.md#request-log)).

```bash
cast requests <session-id>             # One line per request: purpose, messages, finish reason, tokens
cast requests <session-id> 3           # Request 3's body as JSON, byte for byte
cast requests <session-id> 3 --response  # ... and what the model answered
```

### `cast lsp`

Run one [`lsp` tool](tools.md#language-servers) query from the shell, in the current directory:

```bash
cast lsp findReferences src/math.ts 1 17     # line and character, 1-based
cast lsp workspaceSymbol src/math.ts total   # the file picks the server; the last word is the query
cast lsp diagnostics src/main.ts
```

### `cast web`

Web UI mode: launches a browser-based control room for managing background agents. The internal `cast server` daemon is the single writer for every session: both the browser and the TUI are thin clients of it over HTTP + SSE, so a session opened in either surface streams live (tokens, tool calls, status) to both. The TUI auto-spawns this daemon on launch unless one is already running or `CAST_NO_DAEMON=1` is set. `cast server` is a supported alias for scripts and integrations.

```bash
cast web                 # Start in background (daemon)
cast web start           # Same as above
cast web stop            # Stop the background server (SIGTERM → SIGKILL after 3s)
cast web status          # Check if running (auto-heals stale state)
cast web --foreground    # Run inline (for dev/debug)
cast web --port 8080     # Custom port (default: 1337, or set CAST_SERVER_PORT)
cast web --host 0.0.0.0  # Bind to all interfaces (reachable from network)
cast web --public        # Alias for --host 0.0.0.0
```

For local development, `npm run dev:web` runs the Web UI in the foreground. Pass server options after `--`, for example `npm run dev:web -- --port 8080`.

First run generates a password, printed to the terminal and saved in `~/.cast/settings.json`. Username is always `cast`.

Binding to a non-loopback address (`--host 0.0.0.0` or `--public`) exposes plain HTTP. Use it only on a trusted LAN: without HTTPS, a network observer can read the password and session. For remote access without a domain, keep the default loopback binding and use `ssh -L 1337:127.0.0.1:1337 user@host`.

**The address is remembered.** An address you choose with `--public`, `--host` or `--port` is saved in `~/.cast/settings.json` (`serverBind`). A daemon started later without those flags binds the same address: `cast server start`, the terminal screen when it has to start the daemon itself, and `cast upgrade` restarting it. Before this, an open `cast` window answered every `cast server stop` by starting a private daemon on a random port faster than you could start the public one, and `cast upgrade` could lose the public address the same way. If the remembered port is taken by something else, the terminal screen falls back to a private daemon instead of failing. To forget it: `cast server stop`, then `cast server start --port 0`.

Starting when another instance is already running prints an error and exits. `stop` gracefully shuts down open sessions (SIGTERM), escalating to SIGKILL after 3 seconds if the process doesn't exit. If the recorded process is already gone (crash, OOM, `kill -9`), `status` and `stop` detect the stale state, clean up, and report honestly.

Features:
- Create/switch/close sessions with different personas, running independently in parallel
- Modal for new sessions supports working directory selection, optional git-worktree isolation (`.cast/worktrees/<name>`), persona selection, and per-session model overrides
- The web session sidebar lists threads by date by default, with pinned threads in one **Pinned** list above everything; the **Project** switch groups them by working directory instead (see `docs/sessions.md`).
- Token-by-token streaming, with reasoning and tool calls shown inline as they happen
- Tool call cards showing arguments and status
- Git diff viewer (file tree + unified diff) as a resizable side panel, auto-refreshing after each tool call
- File reader popup with wrapped text/code and source-line numbers; Markdown, CSV/TSV, images, and PDFs use their dedicated previews
- Settings modal (gear icon): model & reasoning, color theme, web tools toggle, bash confirmation mode, Quick session persona, and management for MCP servers, skills, hooks, providers, and SSH hosts; shared with the TUI's `~/.cast/settings.json`
- Status popover (info icon): persona, model, mode, token usage, and git branch for the active session
- Keyboard shortcuts: `Ctrl+B` (`⌘B` on Mac) toggles the sidebar, `Ctrl+Shift+D` / `N` / `L` toggle the diff panel / start a new session / clear context, `Ctrl+/` shows the full reference
- Chat slash commands are available in the composer; provider, MCP, skills, hooks, and SSH are managed through Settings. Non-blocking commands work while an agent runs.
- Files tab: browse, search (`ignored` includes git-ignored paths), create files and folders, upload (button or drag and drop), move by dragging onto a folder, download (a folder as `.tar.gz`), rename and delete; Ctrl/Cmd-click selects several items
- Mobile/tablet/desktop responsive: sidebar and diff panel become touch-friendly slide-over drawers on narrow screens
- Themed sign-in screen with an HttpOnly, SameSite session cookie; repeated failed sign-ins are rate-limited

On Windows, prints the install command to run in a new terminal (can't self-replace running process files).

## Options

### Model Selection

| Flag | Short | Description |
|------|-------|-------------|
| `--model <model>` | `-m` | Model name (validated on startup against the provider) |
| `--reasoning <level>` | `-r` | Reasoning level: `off`, `low`, `medium`, `high`, `max` |
| `--persona <name>` | `-p` | Persona to use (use `/persona` to choose) |

```bash
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"
cast -p senior "review this PR"
```

### Session Management

| Flag | Short | Description |
|------|-------|-------------|
| `--continue` | `-c` | Resume the most recently updated session |
| `--resume` | | Pick which session to resume (numbered list) |
| `--resume <id>`, `--resume=<id>` | | Resume a specific session by id |
| `--session <id>` | `-s` | Resume a specific session (alias for `--resume=<id>`) |
| `--worktree <name>` | `-w` | Run in an isolated git worktree created at `.cast/worktrees/<name>` |

```bash
cast -c                           # Resume last session
cast --resume                     # Pick from a list
cast --resume nd4k8f2x            # Resume by id (or --resume=nd4k8f2x)
cast -s nd4k8f2x "keep working"   # Resume + initial prompt
cast -w feature-x                 # Run in an isolated git worktree
```

### Permissions

| Flag | Description |
|------|-------------|
| `--bypass-permissions` | Skip every confirmation this run only (dangerous commands, `ask` rules, paths outside the project); deny rules still apply. `--dangerously-skip-permissions` is the same flag, spelled as in Claude Code |

See [Tools](tools.md#dangerous-command-gating) for the list of patterns that trigger confirmation.

### Skills and MCP

| Flag | Description |
|------|-------------|
| `--skill <directory>` | Load an extra skill package directory (repeatable) |
| `--no-skills` | Skip project/agents/global/builtin skill discovery |
| `--mcp <path>` | Load an extra MCP server config file (repeatable) |
| `--no-mcp` | Skip global/project MCP server discovery |

`--skill` and `--mcp` paths work even with `--no-skills` / `--no-mcp`: they're explicit additions, not discovery.

```bash
cast --skill ./my-skill
cast --no-skills --skill ~/.cast/skills/arxiv
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
| `--bypass-permissions` | | Skip confirmation prompts (alias `--dangerously-skip-permissions`) |
| `--keep-background` | | Leave background tasks this run started running after it exits |
| `--skill <directory>` | | Load an extra skill package directory (repeatable). **Not applied under the daemon**, see below |
| `--no-skills` | | Skip project/agents/global/builtin skill discovery |
| `--mcp <path>` | | Load extra MCP config (repeatable). **Not applied under the daemon**, see below |
| `--no-mcp` | | Skip MCP discovery |

`cast run` executes inside the daemon, and `--skill`/`--mcp` load from a path
*there*: the daemon does not receive them, so the run says so on stderr and
continues without them. Install into `~/.cast/skills` / `~/.cast/mcp.json`, or
run with `CAST_NO_DAEMON=1`. Every other flag above is applied to that run's
own session only, so a second client on the same daemon is unaffected.

```bash
cast run --format json "list all test files"
cast run -m gpt-4o -r medium "explain the session module"
```
