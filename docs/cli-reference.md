# CLI Reference

## Usage

```
cast [options] [prompt]
cast run [options] <message>    Non-interactive mode
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
| `--no-skills` | Skip global/project skill discovery |
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
| `--no-skills` | | Skip skill discovery |
| `--mcp <path>` | | Load extra MCP config (repeatable) |
| `--no-mcp` | | Skip MCP discovery |

```bash
cast run --format json "list all test files"
cast run -m gpt-4o -r medium "explain the session module"
```
