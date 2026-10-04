# Tools

The agent has access to a set of built-in tools (some gated by persona, mode, or configuration; see each section below) plus optional MCP server tools. Multiple tools run in parallel within a single turn via `Promise.all`.

## File System Tools

### `read`

Read file contents. Supports text files and images (jpg, jpeg, png, gif, webp, bmp). Images are sent directly to vision-capable models.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path (relative or absolute) |
| `offset` | No | Line number to start from (1-indexed) |
| `limit` | No | Maximum lines to read |

Output is truncated to 2000 lines or 50KB, and the result says which `offset` to continue from. A line longer than 2000 characters (a minified bundle, a JSON dump) is cut, with its full length noted. Images are automatically downscaled to fit within model vision limits; only rejected if truly huge (25MB+). Each line is prefixed with its line number (`N: content`). Copy the exact text (not the number) when calling `edit`.

### `write`

Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | File path |
| `content` | Yes | Content to write |

The reply is not a byte count: it shows what actually changed, so a from-memory rewrite that reproduced stale content is caught immediately:

- **Overwrite** → a line diff vs the previous content (common prefix/suffix trimmed, `-`/`+` blocks, capped at 80 lines). A trailing-newline-only difference is reported as a `Note:` instead of polluting the diff.
- **New file** → `Created … (N lines)`.
- **Identical content** → says so explicitly.
- **Consecutive identical lines** in the written file (the classic symptom of a botched edit being "fixed" by a rewrite) → a `Warning:` naming the duplicated lines. The same warning fires on `edit`.

### `edit`

Edit a file by replacing an exact block of literal text (`oldString`) with new text (`newString`): no anchors, no line numbers, just the real text of the file.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `filePath` | Yes | File path |
| `oldString` | Yes | Exact literal text to replace, copied verbatim (whitespace/indentation included) from a recent `read`. Empty string creates a new file. |
| `newString` | Yes | Replacement text. Must differ from `oldString`. |
| `replaceAll` | No | Replace every occurrence instead of requiring exactly one match (default: `false`) |

`oldString` must match the file's actual content. The tool tries an exact match first, then falls back through a chain of increasingly fuzzy matchers (line-trimmed, block-anchored with similarity scoring, whitespace-normalized, indentation-flexible, escape-normalized, …) so minor formatting drift between what the model remembers and what's on disk doesn't always cause a hard failure. It still fails if:

- **Not found**: no matcher's candidate appears in the file. Re-`read` and retry with the exact current text.
- **Multiple matches**: `oldString` isn't unique and `replaceAll` wasn't set. Add more surrounding context to `oldString` to disambiguate, or pass `replaceAll: true` if every occurrence should change.
- **Disproportionate match**: the best fuzzy match is far larger than what was searched for; refused rather than risk replacing the wrong block.

A successful edit replies with a diff of what actually changed (common prefix/suffix trimmed, `-`/`+` blocks, capped at 80 lines). Check it before issuing the next edit. `oldString: ""` on a path that doesn't exist creates the file with `newString` as its content (prefer `write` for that).

### Auto-format

After a successful `write` or `edit`, cast runs the project's own formatter on that file, the way an editor formats on save. The formatter is found by walking up from the file to the repository root:

| Formatter | Used for | Needs |
|-----------|----------|-------|
| biome | `.js` `.ts` `.jsx` `.tsx` `.json` `.css` and their variants | `biome.json`/`biome.jsonc` and `node_modules/.bin/biome` |
| prettier | the same plus `.md` `.html` `.yaml` `.scss` `.vue` and others | a `.prettierrc*`/`prettier.config.*` or a `prettier` key in `package.json`, and `node_modules/.bin/prettier` |
| ruff | `.py` `.pyi` | `ruff.toml`, `.ruff.toml` or `[tool.ruff]` in `pyproject.toml`, and `ruff` in `.venv/bin` or on `PATH` |
| gofmt | `.go` | `gofmt` on `PATH` |

Only an installed formatter runs; cast never downloads one. When the file changes, the tool result says so and asks the model to read the file again before its next edit. A formatter that fails, for example on a syntax error, leaves the file as written. Plan files are not formatted. Set `autoFormat: false` in `~/.cast/settings.json` to turn it off. For a type check after each edit, see the recipe in [Hooks](hooks.md#recipe-type-check-after-each-edit).

### Language servers

After a `write` or `edit`, cast hands the file to the project's language server and waits for its verdict, at most 5 seconds (usually milliseconds). The errors it finds are added to the tool result, so the model fixes them in the same turn without running a build:

```
LSP errors introduced by this change, please fix:
<diagnostics file="src/math.ts">
ERROR [2:2] Type 'string' is not assignable to type 'number'. (ts 2322)
</diagnostics>

This change broke other files:
<diagnostics file="src/main.ts">
ERROR [3:31] Argument of type 'number' is not assignable to parameter of type 'string'. (ts 2345)
</diagnostics>
```

Only errors are reported, 20 per file. Errors that were already in the file before the change are counted, not listed (`(2 errors were already in src/math.ts before this change.)`), so the model fixes what it broke rather than chasing old problems; the first time a file is seen, all of its errors are listed. Other open files are reported when the change gave them new errors, up to 5.

The `lsp` tool asks the same servers directly. Positions are 1-based, as `read` shows them; results are `path:line:col` with the line of code:

| Operation | What it returns |
|-----------|-----------------|
| `goToDefinition`, `goToTypeDefinition`, `goToImplementation` | where the symbol at the cursor is defined |
| `findReferences` | every use, including the declaration, grouped by file (100 at most) |
| `hover` | its type and documentation |
| `documentSymbol` | the file's outline with line ranges |
| `workspaceSymbol` | symbols matching `query` across the project (50 at most) |
| `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls` | who calls the function at the cursor, and what it calls |
| `diagnostics` | the compiler's errors and warnings for the file, without a build |

A server starts the first time a file needs it, one per project root, and is shared by every session; one idle for 10 minutes is stopped. Servers run without the credentials in cast's environment (API keys, tokens), and are not handed files over 4MB. Reading a file starts its server in the background. A server that crashes is restarted, twice at most. The web UI's Status window (the ⓘ button) lists the running servers; in the TUI, turn on the Language servers segment in `/statusbar` to see them (`lsp typescript`). `/lsp` shows which servers run and why others don't; `cast lsp <operation> <file> [line character | query]` asks one from the shell.

| Language | Server | Found |
|----------|--------|-------|
| TypeScript, JavaScript | TypeScript 7's own (`tsc --lsp`), or typescript-language-server with the project's TypeScript 5 | project, or installed |
| Python | basedpyright or pyright, with the project's `.venv`/`venv`/`$VIRTUAL_ENV` | `PATH`, or installed |
| Vue, Svelte, Astro, Bash, YAML, JSON, CSS, HTML, PHP (intelephense), Dockerfile, Prisma | their npm language servers | project, `PATH`, or installed |
| Go | gopls | `PATH`, `~/go/bin`, or `go install` |
| C/C++, Rust, Lua, Zig, LaTeX, Typst | clangd, rust-analyzer, lua-language-server, zls, texlab, tinymist | `PATH`, or downloaded |
| ESLint, oxlint, Biome | the project's own linter as a server (its config and plugins apply) | when the project has it |
| Deno, Ruby, C#, F#, Java, Kotlin, Swift, Elixir, Dart, OCaml, Haskell, Gleam, Clojure, Nix, Julia, Terraform | deno, ruby-lsp/rubocop, roslyn/csharp-ls, fsautocomplete, jdtls, kotlin-lsp, sourcekit-lsp, elixir-ls, dart, ocamllsp, haskell-language-server, gleam, clojure-lsp, nixd, julia, terraform-ls | `PATH` |

"Installed" means cast installs the npm package into `~/.cast/lsp` on first use (`npm install --ignore-scripts`, no install hooks run); "downloaded" means the server's latest GitHub release for your OS and CPU, into `~/.cast/lsp/bin`. Turn that off with `lspAutoInstall: false`, and language servers altogether with `lsp: false` (or `CAST_LSP=off` for one run, as in CI). Add a server, or change a built-in one, in `lspServers`:

```json
{
  "lspServers": {
    "pyright": { "disabled": true },
    "my-dsl": { "command": ["my-dsl-lsp", "--stdio"], "extensions": [".dsl"], "initialization": { "strict": true } }
  }
}
```

A built-in override may set `command`, `extensions`, `env` or `initialization` (sent as `initializationOptions` and answered to `workspace/configuration`) and keeps the rest. The tool is read-only: it is allowed in plan mode and to the explore and review subagents, and a path outside the project asks first like any file tool.

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
| `timeout` | No | Foreground grace/timeout in **milliseconds** (default: 180000, max: 3600000); an explicit background task uses it as its kill timeout. A value under 1000 is read as seconds and converted, with a warning. Nothing legitimately asks for a sub-second deadline |

Long output shows the model its start and end, 32000 characters at most, with the cut marked in the middle. When it is cut, the whole output is saved under `~/.cast/tool-output/` and the result names the file, so the agent can `read` or `grep` the part it missed instead of running the command again. Saved files are kept for 7 days, and one file stops growing at 64MB. `bash_output` and background tasks point at the same file.

For finite long-running commands (docker build, npm install, large test suites), increase the timeout:

```
bash(command="npm run build", timeout=600000)
```

### Background execution

Managed background execution is available in the TUI and web UI. It is not available in `cast run` or subagents, where `bash` keeps the normal blocking path.

Pass `run_in_background: true` on the same `bash` call to get a task id immediately:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `run_in_background` | No | Start the command in the background and return immediately with a task id instead of waiting for it to finish |

The call returns immediately with a task id (`bg-N`). Unlike a normal foreground `bash` call, an explicit background task has **no default kill timeout**: it is meant for open-ended work (dev servers, watchers, long builds) and keeps running until it exits on its own or is stopped. Pass `timeout` on the same call if the task itself should be force-killed after N milliseconds.

Foreground calls are also protected from commands that never finish. Known server/watcher patterns are promoted to the managed background registry immediately. Any other foreground command that is still running after its automatic grace period (at most 60 seconds, adjusted to the requested timeout) is promoted to the same registry instead of being killed or restarted. The command keeps its existing PTY/process, and the response then contains its `bg-N` task id. Commands that finish before promotion return their normal stdout/stderr.

Completion is delivered automatically as a system reminder once the process exits, even if the agent has moved on to something else in the meantime. Two more tools manage a task while it's running:

| Tool | Parameter | Required | Description |
|------|-----------|----------|-------------|
| `bash_output` | `task_id` | Yes | Task id returned by `bash`, either explicitly or after automatic promotion |
| | `wait` | No | Milliseconds to block waiting for the task to finish before returning (0–60000, default: 0); a value under 1000 is read as seconds |
| `bash_kill` | `task_id` | Yes | Task id returned by `bash` to terminate early |

Background tasks are session-scoped: they stay pollable and killable across every later turn until the session itself closes, at which point anything still running is killed.

#### Windows

A bare `bash` from PATH on Windows usually resolves to the WSL shim (`System32\bash.exe`), which loses piped output and can't see the Windows toolchain. cast therefore locates a native Git Bash, in this order:

1. `CAST_BASH` environment variable: used verbatim, overrides everything
2. The `GitForWindows` registry key (`HKCU`, then `HKLM`): covers installs on any drive
3. Known install paths: `%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git` (no-admin install), scoop
4. Derivation from `git.exe` on PATH (portable installs)
5. Fallback to PATH `bash`, with a warning at startup and in the first tool result, since this is likely the WSL shim

The system prompt tells the model the platform and that commands run via Git Bash (POSIX syntax), so it won't generate PowerShell.

## SSH Tool

### `ssh`

Execute one command on a remote host via SSH. Only available when SSH hosts are configured.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `host` | Yes | Host name key from configured SSH hosts |
| `command` | Yes | Remote command to execute |
| `timeout` | No | Timeout in **milliseconds** (default: 180000), read the same way as `bash`'s |

Output is combined stdout+stderr, cut the same way as `bash`: start and end, 32000 characters at most. A cut output is saved to a local file the same way as for `bash`.

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

SSH connections are reused via ControlMaster (`ControlPersist=3600`). The first call to a host creates a master connection; subsequent calls reuse it through a Unix socket. This is transparent: no session state needed.

### Dangerous Commands

By default, the same safety check as bash applies (blocks `sudo`, `rm -rf`, etc.). Set `"dangerousCommands": "bypass"` per-host to skip the check for hosts where sudo is expected.

### Trust Gating

Project `.cast/ssh.json` requires trust (same as MCP servers and skills). The first time you use a project with SSH hosts configured, you'll be asked to trust the project.

## Web Tools

Web tools are disabled by default. Enable them with `/web` (persists to settings.json). When disabled, the tools are not advertised to the model: it doesn't know they exist.

### `web_search`

Searches via DuckDuckGo's HTML endpoint by default. No API key required, but DDG
rate-limits scraping to roughly 4 requests per IP before serving a CAPTCHA. If you hit
that limit, switch the backend with `/web-search-provider` (TUI) or the **Tools** tab in
`cast server`'s settings (no restart needed, it takes effect on the next `web_search` call):

- [Tavily](https://app.tavily.com): an AI-search aggregator with a recurring 1000
  requests/month free tier, no card required.
- [Brave Search](https://api-dashboard.search.brave.com): Brave's own general web
  index, a more direct DDG replacement.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query |
| `maxResults` | No | Maximum results (default: 10) |
| `region` | No | Region code like `us-en`, `ru-ru`, or `wt-wt` for none (default). DDG backend only; any other value is refused, not ignored |
| `time` | No | Time filter: `d` (day), `w` (week), `m` (month), `y` (year). DDG backend only; any other value is refused |

A request gets 20 seconds; a backend that never answers fails with `<backend> did not answer within 20s` instead of holding the turn until Esc. DuckDuckGo's ads (laid out like results, linked through a `duckduckgo.com/y.js` redirect) are left out. A page from DuckDuckGo that is neither results nor its own "no results" page (a bot check worded differently, a changed layout) is an error and is not remembered; a real "no results" is cached for ten minutes with the other answers.

### `web_fetch`

Fetch a web page and return it as markdown, plain text or raw HTML. Two backends, switched with `/web-fetch-provider`:

| Backend | What it does |
|---------|--------------|
| `jina` (default) | Jina Reader (`r.jina.ai`) fetches the page from its own servers: handles JS rendering and PDFs, always returns markdown. **Jina sees every URL you fetch this way**, so cast refuses to send it what a third party has no business with: a private or internal address (loopback, RFC1918, link-local, an IPv4 address written inside an IPv6 one, and the like), a host that resolves to one, and a URL with a login in it (`https://user:password@host/`). The refusal says so and nothing is sent |
| `local` | This process fetches the page itself: no third party sees the URL. HTML is converted locally; a Cloudflare challenge is retried once; the response is capped at 5MB; images and binaries are refused. It refuses private and internal addresses too, on every redirect hop and on every address the name resolves to, and connects only to the addresses it checked |

| Parameter | Required | Description |
|-----------|----------|-------------|
| `url` | Yes | URL to fetch (http or https) |
| `maxChars` | No | Maximum characters (default: 12,000, at most 200,000) |
| `format` | No | `markdown` (default), `text` or `html`. `local` backend only; Jina always returns markdown |

A page that answers an error status is an error result, not content: with Jina, which reports a target's 404 or 403 as a successful answer carrying only a warning, cast reads the warning and says `answered HTTP 404`, showing the start of the error page for reference. Other Jina notes (a page "maybe not yet fully loaded") follow the content as `[Reader note: ...]`. Jina's free tier is rate-limited; a 429 says so and suggests `local`. A response is read up to 5MB.

### Untrusted content

What a search returns and what a page says is data from the internet. The tool descriptions tell the model to use it as information, never as instructions, and never to send your files, secrets or conversation to a URL because a page asks. To keep the agent to hosts you choose, add a rule on the URL (see [Permission Rules](configuration.md#permission-rules)): `"ask": ["web_fetch"]` asks before every fetch, `"deny": ["web_fetch(*://*.example.com/*)"]` refuses one site.

## Worktree Tool

### `worktree`

Works in an isolated git worktree: a second checkout of the repository on its own branch, so what the agent changes does not touch your files or your branch. It is the agent's way to do what `/worktree <name>` does for you, and it is offered where a daemon records the move (the web UI, the terminal attached to the daemon, `cast run`), not in plan mode, not to a subagent, not in the in-process ACP bridge (the editor owns the folder there) and not in the terminal's no-daemon fallback (`CAST_NO_DAEMON=1`; use `/worktree` there). It asks before creating, where a write asks.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | `enter`, `exit` or `list` |
| `name` | For `enter` | A short slug such as `feature-x` |

- `enter` creates the worktree (or reuses it) at `.cast/worktrees/<name>` on branch `cast-<name>`, fires the `WorktreeCreate` hook (which can cancel it) and moves the session into it: from the next tool call relative paths, `bash` and the permission rules work there, the session's working directory is saved (a later message continues in the worktree), the next turn's prompt is built for it and the `CwdChanged` hook fires.
- `exit` goes back to the main checkout and keeps the worktree and its branch.
- `list` shows the repository's worktrees and which one the agent is in.

The agent is told to use it when you ask for a worktree or an isolated copy to try something in, not on its own, and not to make one with `git worktree add` in `bash` (that one would not be tracked and the agent would not be working in it). Removing a worktree stays yours: `/worktree remove <name>`. It is called alone, not in a message with other tool calls, since the calls after it run in the new directory.

## Task Tool

### `task`

Delegate a task to a sub-agent with an isolated context. The sub-agent runs independently: its intermediate tool calls don't appear in the main context. Only the final result is returned.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `description` | No | Short title (3-5 words) shown to the user |
| `assignment` | Yes | Complete, self-contained task description, including what the report must contain |
| `subagent` | No | Sub-agent name (`explore`, `review`, `worker`, or a custom one; default `worker`) |
| `task_id` | No | Continue an earlier sub-agent of this session instead of starting a new one |
| `background` | No | TUI and web: return at once; the report arrives as a message when it is done |

Several `task` calls in one response run in parallel (up to 4 per session). See [Sub-agents](subagents.md) for child sessions, `/agents`, custom sub-agents and `readOnly`.

The `task` tool is only available when the current persona has `subagents: true` (e.g. the `coder-with-subagents` persona).

Use for:
- Parallel exploration (multiple sub-agents searching different parts of the codebase)
- Isolating complex research that would pollute the main context
- Delegating well-defined subtasks

## Review Tool

`review_report` exists only while a `/code-review` is open in the session. It takes the findings and checks every one against the files before they reach the user.

| Argument | Required | Description |
|----------|----------|-------------|
| `findings` | Yes | Array of `{path, line, quote, issue}`. An empty array is a valid answer: it means the change is clean |
| ↳ `path` | Yes | Path as it appears in the review scope |
| ↳ `line` | Yes | Line number after the change |
| ↳ `quote` | No | The line's exact text. This is what makes the position checkable; without it only the line's existence is verified |
| ↳ `issue` | Yes | The concrete failure, in a sentence or two |

Each finding comes back with a verdict: **ok**, **relocated** (the quoted code was found elsewhere in the file and the line was corrected), **outside the change** (kept, but the line is context rather than diff), or **dropped** (the quoted code is not in the file, or the file is outside the scope). The summary the user reads is written from the verdicts, not from the model's own list.

## Plan Tools

Mode-specific tools are deliberately narrow: `plan_done` is available only in plan mode; `todo_write` is available only in build mode. `question` is available in both modes and persists until the user answers it, including across TUI/web restarts. See [Plan Mode](plan-mode.md) for the write and bash gates.

The plan file is authored and read with the ordinary `write`/`edit`/`read`
tools above: no separate plan-write/plan-edit/plan-read tool. In plan mode
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

- **Own system prompt**: loaded from `prompts/subagents/` (`worker`, `explore`, `review`)
- **Isolated context**: the parent agent sees only the final result, not intermediate tool calls
- **Built-in tools**: by default the full builtin set except `task` (sub-agents can't delegate further). Frontmatter `tools:` on the subagent file can allowlist builtins (exact names or `*`-globs); MCP tools are not filtered by that list. Built-in `explore` / `review` allowlist read/search/bash only (no `write`/`edit`)
- **AGENTS.md**: injected into the child system prompt by default (`agentsMd: true`); set `agentsMd: false` in the subagent frontmatter to skip
- **Optional model override**: `/subagent-model` sets a different model for sub-agents

| Name | Role |
|------|------|
| `worker` | Default catch-all (edits, mixed work, or unclear fit) |
| `explore` | Read-oriented mapping/research |
| `review` | Independent validation; reports findings, does not patch |

Sub-agent tokens are tracked separately in usage reporting (the status bar `sub` count).

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

File tools (`read`, `write`, `edit`) are never gated: they're trivially reversible via git.
