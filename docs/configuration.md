# Configuration

## Settings File

User settings are persisted to `~/.cast/settings.json`. This file is loaded on startup and saved after changes (model switch, reasoning change, persona change, etc.).

### Settings Schema

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Last used model |
| `modelProvider` | string | Saved-provider name for `model` (falls back to the active provider) |
| `subagentModel` | string | Model for sub-agents (falls back to `model`) |
| `subagentModelProvider` | string | Saved-provider name for `subagentModel` |
| `planModel` | string | Model used while plan mode is active (falls back to `model`) |
| `planModelProvider` | string | Saved-provider name for `planModel` |
| `reasoningLevel` | string | Last used reasoning level |
| `persona` | string | Last used persona name |
| `providerUrl` | string | Active provider endpoint URL |
| `apiKey` | string | Active provider API key |
| `providers` | Provider[] | Saved providers (`name`, `url`, `apiKey`, optional `reasoningFormat`); use `/provider` to manage |
| `cwd` | string | Last working directory |
| `permissionMode` | `"default"` \| `"bypass"` | Bash confirmation mode |
| `permissions` | `{ allow?, ask?, deny? }` | Per-tool permission rules (see [Permission Rules](#permission-rules)) |
| `projectTrust` | Record<string, boolean> | Per-project trust decisions |
| `theme` | string | Active color theme id |
| `webTools` | boolean | Whether web tools are enabled (default: `false`; use `/web` to enable) |
| `autoFormat` | boolean | Run the project's configured formatter after each `write`/`edit` (default: `true`; see [Auto-format](tools.md#auto-format)) |
| `lsp` | boolean | Language servers: the `lsp` tool and errors reported after each `write`/`edit` (default: `true`; see [Language servers](tools.md#language-servers)) |
| `lspAutoInstall` | boolean | Install npm-distributed language servers into `~/.cast/lsp` on first use (default: `true`) |
| `lspServers` | object | Custom language servers, or overrides of built-in ones by id: `command`, `extensions`, `env`, `initialization`, `disabled` |
| `notifications` | boolean | TUI: a terminal notification and bell when a turn ends or waits for approval while the terminal is unfocused (default: `true`) |
| `scratchpad` | boolean | A scratchpad folder for each session (default: `true`): temporary files the agent makes go to `~/.cast/scratch/<session id>` instead of the project or `/tmp`; see [Scratchpad](sessions.md#scratchpad) |
| `memoryEnabled` | boolean | Whether durable project memory, retrieval, and the Web UI Memory tab are enabled (default: `true`) |
| `memoryWriteEnabled` | boolean | Whether checkpoint writing, dream, and distill may update memory (default: `true`; reading remains available when this is `false`) |
| `memoryPromptBudget` | integer | Maximum estimated tokens reserved for memory context inserted during checkpoint rebuild (256–16384, default: `4096`) |
| `memorySearchScoreFloor` | number | Relative BM25 floor for dropping weak common-word matches (0–1, default: `0.15`; `0` keeps all matches) |
| `memoryReconcileOnSearch` | boolean | Reconcile changed project `MEMORY.md` files before SQLite search (default: `true`) |
| `memoryCcIndex` | boolean | Index Claude Code memory files (`~/.claude/projects/*/memory`) into search (default: `false`) |
| `memoryDreamAuto` | boolean | Run dream automatically on a new top-level session (default: `false`; requires memory writing) |
| `memoryDreamIntervalDays` | integer | Minimum days between automatic dream runs (default: `7`; `0` runs on every new session) |
| `memoryDistillAuto` | boolean | Run distill automatically on a new top-level session (default: `false`; requires memory writing) |
| `memoryDistillIntervalDays` | integer | Minimum days between automatic distill runs (default: `30`; `0` runs on every new session) |
| `checkpointFork` | boolean | Preserve the parent prompt prefix for checkpoint writers to reuse provider prefix cache (default: `false`; disabled uses only the post-checkpoint delta) |
| `checkpointThresholds` | number[] | Checkpoint writer trigger points as percentages of the context window (default depends on the window: 4 × 20% up to 200K, 9 × 10% up to 500K, 18 × 5% above; a writer fires once per crossed threshold) |
| `checkpointReserved` | integer | Token safety buffer kept at the end of the window; thresholds are clamped to `window - reserved` (default: `13000`) |
| `checkpointPushCaps` | object | Per-section token caps for the rebuild context: `{ checkpoint?, memory?, notes?, global?, tasks? }` (defaults: 11000/10000/6000/6000/2000) |
| `contextWindow` | integer | Override the model's context window in tokens (8000–2000000). Unset (default) uses the model catalog's value for the active model. Set it only when the catalog is wrong for your endpoint |
| `maxResponseTokens` | integer | Tokens reserved for the model's own reply, subtracted from the window when deciding when to compact (1000–200000, default: `32000`). Capped at half `contextWindow` so a small-window model still gets a usable input budget |
| `compactionThreshold` | number | Fraction of the usable input budget that triggers automatic compaction (0.05–0.95, default: `0.75`). The budget is `contextWindow` minus the reply reserve, and the reserve is capped at half the window, so a 32k model reserves 16k rather than the full default 32k. When the system prompt and tools alone exceed the trigger, compaction cannot help: it then backs off (waiting for the context to grow a margin past where it landed) and says so once, instead of running before every call |
| `maxToolOutputLines` | integer | Line cap on a single tool result before it is truncated (100–100000, default: `2000`) |
| `maxToolOutputBytes` | integer | Byte cap on a single tool result before it is truncated (4096–8388608, default: `131072`). Applies to MCP tool results too. A `bash` result shows the model at most 32000 characters (its start and end) and a `read` at most 50KB, unless you set this yourself |
| `maxTurnIterations` | integer | Safety cap on model calls in a single turn, the backstop against a runaway loop (10–10000, default: `500`). Raise it for long autonomous runs; the turn stops with a warning when it is hit, and the work done so far is already persisted |
| `showReasoning` | boolean | Whether reasoning blocks are displayed in the transcript (default: `false`, in the TUI and the web UI alike), toggled with `/reasoning-display` (`/rd`) or the web Settings > Appearance switch, and persisted |
| `retryMaxWaitSeconds` | integer | Longest single wait a provider's own `Retry-After` may buy (30–86400, default: `3600`). A 429 that says "come back in 20 minutes" is telling the truth about its window; the guessed exponential backoff stays capped at 30s regardless |
| `retryQuotaWaitSeconds` | integer | How long to keep waiting for an exhausted quota to reset (0–604800, default: `0` = off). Off, a quota/billing error fails the turn at once, since credit does not return on its own. Set it when the key's limit is a *window* (daily tokens, hourly requests) and an unattended run should sit through it: cast then re-tests the quota on a 30s→5min backoff (or exactly when `Retry-After` says) until the budget is spent. Esc cancels the wait |
| `searchProvider` | `"ddg"` \| `"tavily"` \| `"brave"` | `web_search` backend (default: `"ddg"`); use `/web-search-provider` to change |
| `tavilyApiKey` | string | API key for the Tavily backend, from https://app.tavily.com |
| `braveApiKey` | string | API key for the Brave Search backend, from https://api-dashboard.search.brave.com |
| `webFetchProvider` | `"jina"` \| `"local"` | `web_fetch` backend (default: `"jina"`); use `/web-fetch-provider` to change |
| `disabledMcpServers` | string[] | MCP server names disabled via `/mcp` toggle |
| `mcpToolTimeoutSeconds` | integer | How long an MCP tool call may take before it fails, clamped to 5–3600. Unset uses the MCP SDK's own 60s default; raise it for a slow-but-legitimate tool (a browser step, a heavy query). Read per call, so a change applies without reconnecting |
| `disabledSkills` | string[] | Skill names disabled via `/skills` toggle |
| `disabledSkillSources` | string[] | Whole skill sources switched off: `builtin`, `cast`, `agents`, `claude` (see [Skills](skills.md#turning-sources-off)) |
| `disabledHooks` | string[] | Content-derived hook group ids disabled via `/hooks` |
| `statusBar` | object | Status bar segment config (`visible`, `order`, `sides`); use `/statusbar` to configure |
| `header` | object | Parts of the top row of the TUI (`visible`, `order`; ids `persona`, `model`, `version`, `folder`); use `/header` to configure |
| `serverToken` | string | Password generated for the server daemon on first start |
| `webPassword` | string | Deprecated predecessor of `serverToken`; read and migrated for compatibility |
| `quickSessionPersona` | string | Persona selected by the web UI's Quick session action |
| `updatedAt` | string | Auto-updated timestamp |

Settings are written atomically (temp file + rename) to prevent corruption from crashes mid-write.

## `cast run` and background tasks

Background tasks live in the daemon, not in the client. A `cast run` that
created its own session now stops the tasks it started when it exits, and says
which ones. The TUI has always done the same on exit. A run that attached to
an existing session (`--continue` / `--session`) leaves them alone: those tasks
belong to whoever started them. `--keep-background` opts out for the
deliberate "start the dev server and leave it running" case, and then the run
names what it is leaving behind instead. Under `--format json` this is a
`background_tasks_killed` or `background_tasks_running` event.

## The Project Root

Rules, project memory, and project-scoped history search are all keyed on the
project root: the nearest ancestor directory containing `.git`, or (when there
is no checkout) the topmost one containing `.cast/`. A nested checkout (a
submodule, a vendored copy) is its own project, since its own `.git` says so,
while a subdirectory's `.cast/rules` stays what it is documented to be: rules
scoped to that subtree, not a project of its own.

The home directory is never a project root, whatever it contains: `~/.cast` is
the global configuration directory, and a dotfiles repository in `$HOME` would
otherwise make everything under it one project sharing one memory.

`/reload` re-reads the root, so `git init` mid-session takes effect.

## Context files (AGENTS.md / CLAUDE.md)

`AGENTS.md` (or `CLAUDE.md`) is read from the working directory and every
ancestor, and its content goes into the system prompt of **every** request.
Each file is capped at 64KB (the same ceiling rules use), with a note in
place of the rest, so a generated or dumped-into file cannot quietly cost a
million tokens per request. Keep these files short and let the agent read the
details on demand.

## Session store maintenance

`~/.cast/sessions/sessions.db` holds every session's messages and events.
Sessions, events and background runs are pruned on a retention policy, but
SQLite never shrinks the file on its own: the freed space stays claimed. At
open, cast reclaims it when it is worth the write lock: at least 64MB of free
pages *and* a fifth of the file. The rebuilt database is then checkpointed out
of the write-ahead log, without which the space is only moved. A VACUUM in
WAL mode writes the whole database into the log. Measured on a real store:
547MB became 324MB in about 2.5 seconds, and the log says so when it happens.
Below either threshold nothing runs.

## Project Memory

> See [Memory](memory.md) for a complete guide to what memory is, where the
> files live, and how it is written and read. This section covers the settings.

Durable project memory is enabled by default. It is one global setting shared by the TUI and Web UI:

- TUI: use `/memory`, or `/memory on` / `/memory off`.
- Web UI: open Settings → Memory and switch the toggle.

When disabled, Cast does not advertise the `memory` tool, retrieve memory into prompts, or run the background memory writer. The Web UI also removes Memory from the right sidebar. Existing records remain in SQLite and become available again if memory is re-enabled.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Path to the bash executable the `bash` tool spawns (overrides auto-detection; useful for msys2 or non-standard Git Bash installs on Windows) |
| `CAST_VERSION` | Pin install version (installer only) |
| `CAST_SERVER_PORT` | Override server daemon port (default: `1337`) |
| `CAST_SERVER_HOST` | Override server daemon bind address (default: `127.0.0.1`) |
| `CAST_SESSIONS_DB` | Override SQLite session database path |

Provider URL and API key are configured **only** via `~/.cast/settings.json` (first-run prompt, or `/provider` in-session). cast does not read `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` environment variables or a project `.env`, so editing those changes nothing.

## .cast/ Directory Structure

```
~/.cast/
  settings.json         # User settings
  AGENTS.md             # Global context file (optional)
  mcp.json              # Global MCP server config
  sessions/sessions.db  # SQLite session database (legacy JSON files are imported once)
  skills/               # Global skills
  rules/                # Global rules
  personas/             # Global personas

~/.agents/skills/          # skills.sh universal global
~/.config/agents/skills/   # Compatible universal-global location

<project>/.cast/
  plans/<session-id>/   # Session plan files
  skills/               # Project-local skills
  rules/                # Project-local rules
  personas/             # Project-local personas
  mcp.json              # Project-local MCP config
  hooks.json            # Project-local hooks
  ssh.json              # Project-local SSH hosts

<project>/.agents/skills/  # skills.sh universal project (npx skills add -a universal)
```

## Project Trust

A single trust decision gates all project-local resources: skills (`.cast/skills/` and `.agents/skills/`), MCP servers, context files, personas, rules, hooks, and `.cast/ssh.json`. cast asks once per project; the decision is saved in `settings.json` under `projectTrust`.

Global resources (`~/.cast/`, `~/.agents/skills/`, `~/.config/agents/skills/`) always load without a trust check: you put them there yourself.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Dangerous bash commands require confirmation |
| `bypass` | All bash commands run without confirmation |

Change with:
- `--bypass-permissions` flag, or `--dangerously-skip-permissions` as in Claude Code (this run only)
- `/permissions` command (persists to settings)
- `/permissions default` or `/permissions bypass` (direct set)

See [Tools](tools.md#dangerous-command-gating) for the list of dangerous patterns.

## Permission Rules

`permissions` in `~/.cast/settings.json` decides per tool call whether to run it, ask first, or refuse:

```json
{
  "permissions": {
    "allow": ["bash(npm test*)", "bash(git status)", "write(docs/**)"],
    "ask": ["bash(git push*)", "write(package.json)", "mcp_github_*"],
    "deny": ["bash(git push --force*)", "write(.env*)", "edit(/etc/**)"],
    "approved": ["bash(rm -rf build)"]
  }
}
```

A rule is a tool name, or a tool name with a pattern in parentheses. The pattern is matched against the call's subject:

| Tool | Subject |
|------|---------|
| `bash`, `ssh` | the command |
| `read`, `write`, `edit`, `ls`, `glob`, `grep` | the path, relative to the project when it is inside it, absolute otherwise |
| `web_fetch` | the URL (`"ask": ["web_fetch"]` asks before every fetch; `"deny": ["web_fetch(*://*.example.com/*)"]` refuses a site) |

In a command pattern `*` matches anything, spaces included. In a path pattern `*` stays within one directory and `**` crosses them. Tool names take `*` too, so `mcp_github_*` covers every tool of that MCP server. A rule with a pattern never matches a tool without a subject.

- **deny** beats **approved**, which beats **ask**, which beats **allow**, regardless of order, so a broad allow can't cancel a deny. A denied call is not run, and the model is told to ask you instead of working around it. Deny applies in `bypass` mode too.
- **ask** shows the same prompt as a dangerous command: in the TUI, in the web UI, or in an ACP editor. With nobody to ask (`bypass` mode) the call runs. `cast run` without a terminal refuses it.
- **allow** answers the dangerous-command prompt ahead of time: `bash(rm -rf build)` runs without asking.

**Always allow** in the prompt appends an exact rule for that call to `approved`, for example `bash(rm -rf build)` or `write(src/a.ts)`. `approved` outranks `ask`, so the rule that asked doesn't ask about that call again, and a `deny` still wins over it. Wildcard characters in the saved subject match only one character, so the saved rule never grows beyond the call you approved. Delete an entry from `approved` to be asked again. **Outside the project, file tools ask first.** A `read`, `write`, `edit`, `ls`, `glob` or `grep` that reaches a path outside the session's directory and its project root is asked about, like an `ask` rule; symlinks are followed, so a link inside the project can't lead out unnoticed. Reads may reach what cast itself hands the agent without asking: saved tool output (`~/.cast/tool-output`), uploaded files (`~/.cast/inputs`) and the loaded skills' own files. Control it with `external_directory(<glob>)` rules on the absolute path (a leading `~/` is your home directory, in every path rule):

```json
{ "permissions": { "allow": ["external_directory(/data/**)"], "deny": ["external_directory(/etc/**)", "external_directory(~/.ssh/**)"] } }
```

**Always allow** on that prompt saves `external_directory(<that directory>/**)`. A tool's own allow rule that covers the path (`write(/tmp/**)`) counts as the answer too. In bypass mode nothing is asked, and a deny still applies. `bash` is not checked: a shell command's paths can't be known before it runs, so guard those with `bash(...)` rules.

**A prompt outlives the process that asked.** While a confirmation waits, it is also kept in the session. If cast stops before you answer (you quit a local TUI, or the daemon stops), the next TUI or browser that opens the session shows the same prompt, marked with how long ago it was asked. Approving it starts a turn that tells the agent the call was approved and lets exactly that call through without asking again; the agent re-runs the step if it is still needed. Blocking it, or sending a new message instead, drops it. A reloaded page or a reattached TUI gets a prompt that is still live the same way, and a prompt answered in one client closes in the others. Questions and plan approvals are saved in the session and come back the same way.

Rules are per tool: `deny: ["write(.env*)"]` doesn't stop `bash` from writing the same file, so pair it with a `bash` rule when that matters. Rules are read on every call and apply at once. Subagents follow the same rules. In an ACP editor, "Allow for this session" is kept for the session only and isn't saved.

## Provider Configuration

On first run, cast asks for your provider URL and API key. Both are saved to `~/.cast/settings.json`.

You can save multiple providers and switch between them:

| Command | Action |
|---------|--------|
| `/provider` | Open picker: switch between saved providers |
| `/provider add` | Add a new provider (name → URL → key wizard) |
| `/provider delete` | Remove a saved provider |
| `/provider <name>` | Switch to a named provider directly |

Providers are stored in the `providers` array in settings.json. The active provider's URL and key are also saved in the top-level `providerUrl` / `apiKey` fields for startup.

Supported providers: anything that speaks the OpenAI API. Common URLs:

| Provider | URL |
|----------|-----|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Ollama | `http://localhost:11434/v1` |
