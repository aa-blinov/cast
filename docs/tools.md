# Tools

The agent has access to a set of built-in tools (some gated by persona, mode, or configuration — see each section below) plus optional MCP server tools. Multiple tools run in parallel within a single turn via `Promise.all`.

## File System Tools

### `read`

Read file contents. Supports text files and images (jpg, jpeg, png, gif, webp, bmp). Images are sent directly to vision-capable models.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path (relative or absolute) |
| `offset` | No | Line number to start from (1-indexed) |
| `limit` | No | Maximum lines to read |

Output is truncated to 2000 lines or 128KB. Images are automatically downscaled to fit within model vision limits; only rejected if truly huge (25MB+). Each line is prefixed with its line number (`N: content`) — copy the exact text (not the number) when calling `edit`.

### `write`

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `content` | Yes | Content to write |

The reply is not a byte count — it shows what actually changed, so a from-memory rewrite that reproduced stale content is caught immediately:

- **Overwrite** → a line diff vs the previous content (common prefix/suffix trimmed, `-`/`+` blocks, capped at 80 lines). A trailing-newline-only difference is reported as a `Note:` instead of polluting the diff.
- **New file** → `Created … (N lines)`.
- **Identical content** → says so explicitly.
- **Consecutive identical lines** in the written file (the classic symptom of a botched edit being "fixed" by a rewrite) → a `Warning:` naming the duplicated lines. The same warning fires on `edit`.

### `edit`

Edit a file by replacing an exact block of literal text (`oldString`) with new text (`newString`) — no anchors, no line numbers, just the real text of the file.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filePath` | Yes | File path |
| `oldString` | Yes | Exact literal text to replace, copied verbatim (whitespace/indentation included) from a recent `read`. Empty string creates a new file. |
| `newString` | Yes | Replacement text. Must differ from `oldString`. |
| `replaceAll` | No | Replace every occurrence instead of requiring exactly one match (default: `false`) |

`oldString` must match the file's actual content — the tool tries an exact match first, then falls back through a chain of increasingly fuzzy matchers (line-trimmed, block-anchored with similarity scoring, whitespace-normalized, indentation-flexible, escape-normalized, …) so minor formatting drift between what the model remembers and what's on disk doesn't always cause a hard failure. It still fails if:

- **Not found** — no matcher's candidate appears in the file. Re-`read` and retry with the exact current text.
- **Multiple matches** — `oldString` isn't unique and `replaceAll` wasn't set. Add more surrounding context to `oldString` to disambiguate, or pass `replaceAll: true` if every occurrence should change.
- **Disproportionate match** — the best fuzzy match is far larger than what was searched for; refused rather than risk replacing the wrong block.

A successful edit replies with a diff of what actually changed (common prefix/suffix trimmed, `-`/`+` blocks, capped at 80 lines) — check it before issuing the next edit. `oldString: ""` on a path that doesn't exist creates the file with `newString` as its content (prefer `write` for that).

## Search Tools

### `glob`

Search for files by glob pattern.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | Yes | Glob pattern (e.g. `*.ts`, `**/*.json`, `src/**/*.spec.ts`) |
| `path` | No | Directory to search (default: cwd) |
| `limit` | No | Maximum results (default: 1000) |

### `grep`

Search file contents by regex pattern.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | Yes | Regex or literal string |
| `path` | No | Directory or file to search (default: cwd) |
| `glob` | No | Filter by glob (e.g. `*.ts`) |
| `ignoreCase` | No | Case-insensitive search |
| `literal` | No | Treat pattern as literal string |
| `context` | No | Lines before/after each match |
| `limit` | No | Maximum matches (default: 100) |

Output is plain `<relPath>:<line>:<content>`, same shape as ripgrep's own default output.

### `ls`

List directory contents with file type, size, and name.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | No | Directory to list (default: cwd) |
| `limit` | No | Maximum entries (default: 500) |

## Shell Tool

### `bash`

Execute a bash command in the current working directory.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `command` | Yes | Bash command to execute |
| `timeout` | No | Foreground grace/timeout in seconds (default: 180); an explicit background task uses it as its kill timeout |

Output is truncated to the last 2000 lines or 128KB (whichever is hit first).

For finite long-running commands (docker build, npm install, large test suites), increase the timeout:

```
bash(command="npm run build", timeout=600)
```

### Background execution

Managed background execution is available in the TUI and web UI. It is not available in `cast run` or subagents, where `bash` keeps the normal blocking path.

Pass `run_in_background: true` on the same `bash` call to get a task id immediately:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `run_in_background` | No | Start the command in the background and return immediately with a task id instead of waiting for it to finish |

The call returns immediately with a task id (`bg-N`). Unlike a normal foreground `bash` call, an explicit background task has **no default kill timeout** — it is meant for open-ended work (dev servers, watchers, long builds) and keeps running until it exits on its own or is stopped. Pass `timeout` on the same call if the task itself should be force-killed after N seconds.

Foreground calls are also protected from commands that never finish. Known server/watcher patterns are promoted to the managed background registry immediately. Any other foreground command that is still running after its automatic grace period (at most 60 seconds, adjusted to the requested timeout) is promoted to the same registry instead of being killed or restarted. The command keeps its existing PTY/process, and the response then contains its `bg-N` task id. Commands that finish before promotion return their normal stdout/stderr.

Completion is delivered automatically as a system reminder once the process exits, even if the agent has moved on to something else in the meantime. Two more tools manage a task while it's running:

| Tool | Parameter | Required | Description |
|------|-----------|----------|-------------|
| `bash_output` | `task_id` | Yes | Task id returned by `bash`, either explicitly or after automatic promotion |
| | `wait` | No | Seconds to block waiting for the task to finish before returning (0–60, default: 0) |
| `bash_kill` | `task_id` | Yes | Task id returned by `bash` to terminate early |

Background tasks are session-scoped: they stay pollable and killable across every later turn until the session itself closes, at which point anything still running is killed.

#### Windows

A bare `bash` from PATH on Windows usually resolves to the WSL shim (`System32\bash.exe`), which loses piped output and can't see the Windows toolchain. cast therefore locates a native Git Bash, in this order:

1. `CAST_BASH` environment variable — used verbatim, overrides everything
2. The `GitForWindows` registry key (`HKCU`, then `HKLM`) — covers installs on any drive
3. Known install paths: `%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git` (no-admin install), scoop
4. Derivation from `git.exe` on PATH (portable installs)
5. Fallback to PATH `bash` — with a warning at startup and in the first tool result, since this is likely the WSL shim

The system prompt tells the model the platform and that commands run via Git Bash (POSIX syntax), so it won't generate PowerShell.

## SSH Tool

### `ssh`

Execute one command on a remote host via SSH. Only available when SSH hosts are configured.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `host` | Yes | Host name key from configured SSH hosts |
| `command` | Yes | Remote command to execute |
| `timeout` | No | Timeout in seconds (default: 180) |

Output is combined stdout+stderr, truncated to the last 2000 lines or 128KB.

### Configuration

SSH hosts are configured in `~/.cast/ssh.json` (global) or `.cast/ssh.json` (project):

```json
{
  "hosts": {
    "myserver": { "host": "192.168.1.10", "username": "deploy", "port": 22, "keyPath": "~/.ssh/id_ed25519" },
    "staging": { "host": "staging.example.com", "username": "admin", "password": "secret123" },
    "prod": { "host": "prod.example.com", "username": "root", "dangerousCommands": "bypass" }
  }
}
```

### Authentication

- **Key-based** (`keyPath`): Uses `ssh -i <keyPath>`. Key file must have `600` or stricter permissions.
- **Password-based** (`password`): Requires `sshpass` on PATH. Password is passed via `SSHPASS` env var (not CLI arg).
- When both `keyPath` and `password` are set, key takes priority.
- `~/.ssh/config` keys are also picked up automatically by ssh-agent.

### Connection Reuse

SSH connections are reused via ControlMaster (`ControlPersist=3600`). The first call to a host creates a master connection; subsequent calls reuse it through a Unix socket. This is transparent — no session state needed.

### Dangerous Commands

By default, the same safety check as bash applies (blocks `sudo`, `rm -rf`, etc.). Set `"dangerousCommands": "bypass"` per-host to skip the check for hosts where sudo is expected.

### Trust Gating

Project `.cast/ssh.json` requires trust (same as MCP servers and skills). The first time you use a project with SSH hosts configured, you'll be asked to trust the project.

## Web Tools

Web tools are disabled by default. Enable them with `/web` (persists to settings.json). When disabled, the tools are not advertised to the model — it doesn't know they exist.

### `web_search`

Searches via DuckDuckGo's HTML endpoint by default — no API key required, but DDG
rate-limits scraping to roughly 4 requests per IP before serving a CAPTCHA. If you hit
that limit, switch the backend with `/web-search-provider` (TUI) or the **Tools** tab in
`cast server`'s settings — no restart needed, it takes effect on the next `web_search` call:

- [Tavily](https://app.tavily.com) — an AI-search aggregator with a recurring 1000
  requests/month free tier, no card required.
- [Brave Search](https://api-dashboard.search.brave.com) — Brave's own general web
  index, a more direct DDG replacement.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query |
| `maxResults` | No | Maximum results (default: 10) |
| `region` | No | Region code (default: `wt-wt`) — DDG backend only |
| `time` | No | Time filter: `d` (day), `w` (week), `m` (month), `y` (year) — DDG backend only |

### `web_fetch`

Fetch a web page and return clean markdown via Jina Reader. Handles JS rendering, PDFs, and content extraction.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | URL to fetch |
| `maxChars` | No | Maximum characters (default: 12,000) |

## Task Tool

### `task`

Delegate a task to a sub-agent with an isolated context. The sub-agent runs independently — its intermediate tool calls don't appear in the main context. Only the final result is returned.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `assignment` | Yes | Complete, self-contained task description |
| `subagent` | No | Sub-agent name (`explore`, `review`, or `worker`; default `worker`) |

The `task` tool is only available when the current persona has `subagents: true` (e.g. the `coder-with-subagents` persona).

Use for:
- Parallel exploration (multiple sub-agents searching different parts of the codebase)
- Isolating complex research that would pollute the main context
- Delegating well-defined subtasks

## Plan Tools

Mode-specific tools are deliberately narrow: `plan_done` is available only in plan mode; `todo_write` is available only in build mode. `question` is available in both modes and persists until the user answers it, including across TUI/web restarts. See [Plan Mode](plan-mode.md) for the write and bash gates.

The plan file is authored and read with the ordinary `write`/`edit`/`read`
tools above — no separate plan-write/plan-edit/plan-read tool. In plan mode
`write`/`edit` are restricted to a `.md` file directly inside the session's
plans directory; `read`ing that file makes it the active plan.

| Tool | Mode | Description |
|------|------|-------------|
| `plan_done` | Plan | Signal that the plan is ready for review |
| `question` | Plan or build | Ask one to five multiple-choice questions and end the turn until the user answers |
| `todo_write` | Build | Maintain the task list; approved plan checkboxes are projected into it |

### `todo_write`

In Build mode, the agent uses `todo_write` to track multi-step execution as an externalized checklist:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `todos` | Yes | Array of todo items: `{ content: string, status: "pending"|"in_progress"|"completed"|"cancelled", priority: "high"|"medium"|"low", planStep?: string }` |

Key mechanics:
- **State isolation**: The todo list is stored in a dedicated `todos` field on `SessionState` (outside the `messages` array). It is never lost during context compaction.
- **System prompt injection**: The task list is automatically re-injected into the system prompt on every turn so the model maintains focus across long tool sequences.
- **Open work gate**: Only one task can be `in_progress` at a time. The harness prevents turn completion if tasks remain `in_progress` without being marked `completed` or `cancelled`.

## Subagent System

The `task` tool delegates work to isolated sub-agents. Each sub-agent has:

- **Own system prompt** — loaded from `prompts/subagents/` (`worker`, `explore`, `review`)
- **Isolated context** — the parent agent sees only the final result, not intermediate tool calls
- **Built-in tools** — by default the full builtin set except `task` (sub-agents can't delegate further). Frontmatter `tools:` on the subagent file can allowlist builtins (exact names or `*`-globs); MCP tools are not filtered by that list. Built-in `explore` / `review` allowlist read/search/bash only (no `write`/`edit`)
- **AGENTS.md** — injected into the child system prompt by default (`agentsMd: true`); set `agentsMd: false` in the subagent frontmatter to skip
- **Optional model override** — `/subagent-model` sets a different model for sub-agents

| Name | Role |
|------|------|
| `worker` | Default catch-all (edits, mixed work, or unclear fit) |
| `explore` | Read-oriented mapping/research |
| `review` | Independent validation; reports findings, does not patch |

Sub-agent tokens are tracked separately in usage reporting (`/usage` status bar shows `sub` count).

The `task` tool is only available when the current persona has `subagents: true` (e.g. `coder-with-subagents`). Other personas can't see or invoke it.

Subagent frontmatter example (`prompts/subagents/explore.md`):

```markdown
---
name: explore
label: Explore
description: Read-only codebase exploration
tools: [read, grep, glob, ls, bash]
agentsMd: true
---

You explore the codebase and report findings. You cannot edit files.
```

## Doom Loop Detection

If the agent calls the same tool with identical arguments 3 times consecutively, the tool is blocked and the model receives an error:

```
Doom loop detected: tool "bash" was called 3 times consecutively with the same
arguments. You MUST try a completely different approach.
```

The counter resets when:
- A different tool call breaks the streak
- A steering or follow-up message is injected

This prevents the agent from getting stuck retrying the same failing operation.

## Vision Support

Images can be attached to messages and are sent directly to vision-capable models.

**Attach**: `Ctrl+G` opens a file picker. Supported formats: jpg, jpeg, png, gif, webp, bmp. Large images are automatically downscaled to fit; only rejected if truly huge (25MB+).

**Read tool**: When the `read` tool opens an image file, the image is sent as a separate user message alongside the tool result text.

**Fallback**: If the model doesn't support images (404 or vision error), cast strips image messages and retries with a warning: "Model doesn't support images — sending file path only".

## MCP Server Tools

Tools from connected MCP servers appear alongside the built-in ones. They're named `mcp_<server>_<tool>` (e.g. `mcp_context7_resolve-library-id`).

See [MCP Servers](mcp-servers.md) for configuration.

## Dangerous Command Gating

Bash commands matching known-dangerous patterns require confirmation before execution (unless `--bypass-permissions` is set or `/permissions bypass` is active).

Gated patterns include:

- `rm -rf` / `rm -r` with force flags
- `sudo`
- `git push --force` / `git push -f`
- `git reset --hard`
- `git clean -fd`
- Piping remote scripts into a shell (`curl | bash`)
- `chmod 777`
- `mkfs`, `dd`, writing to block devices
- Fork bombs
- `shutdown`, `reboot`, `poweroff`
- `npm publish`
- `killall`, `pkill`, `kill -9 -1`
- `git checkout .` / `git restore .`
- `rsync --delete`
- `find -delete`
- `xargs rm`
- `crontab -r`
- `iptables -F`
- Decoding base64 into a shell

File tools (`read`, `write`, `edit`) are never gated — they're trivially reversible via git.
