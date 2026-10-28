# cast

A role-based terminal agent harness. Seven built-in personas change the agent's judgment while the tool surface stays familiar, and one engine serves the terminal, the browser and a script. It talks to any OpenAI-compatible endpoint, including one running on your own hardware.

![cast](assets/cast-banner.svg)

[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![CI](https://github.com/aa-blinov/cast/actions/workflows/ci.yml/badge.svg)](https://github.com/aa-blinov/cast/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/aa-blinov/cast)](https://github.com/aa-blinov/cast/releases/latest)

---

## Quick start

Node.js 22.12 or newer is the only runtime requirement.

```bash
# macOS and Linux
curl -fsSL https://aa-blinov.github.io/cast/install | bash

# Windows, PowerShell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
```

On macOS and Linux the installer unpacks a release archive into `~/.cast/install` and symlinks `bin/cast` onto your `PATH` at `~/.local/bin`. On Windows it unpacks into the `.cast\install` folder in your home directory and adds its `bin` directory to your user `PATH`. The archive carries the bundle and its runtime dependencies, so there is no `npm install` at runtime. Sandbox sessions also need platform tools; see [sandbox setup](docs/sessions.md#sandbox-processes). Both installers open port 1337 in the firewall, since that is where the web server listens.

```bash
cast                                   # open the terminal screen
cast "explain what this project does"  # open it with a first prompt
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"
cast -c                                # resume the most recent session
```

The first launch asks for a persona, then a provider URL and an API key, then a model and a reasoning level. They all go to `~/.cast/settings.json`. There is no account and no `.env` file.

| Platform | Release archive |
| --- | --- |
| macOS x64, macOS arm64 | `cast-<version>-darwin-x64.tar.gz`, `cast-<version>-darwin-arm64.tar.gz` |
| Linux x64, Linux arm64 | `cast-<version>-linux-x64.tar.gz`, `cast-<version>-linux-arm64.tar.gz` |
| Windows x64, Windows arm64 | `cast-<version>-win32-x64.zip`, `cast-<version>-win32-arm64.zip` |

Pin a version by putting `CAST_VERSION` in front of the install command, and upgrade later with `cast upgrade`:

```bash
CAST_VERSION=0.59.1 curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

## What it does

- **Seven personas, one tool surface.** `senior` (the default), `coder-with-subagents`, `analyst`, `pm`, `qa`, `researcher` and `assistant` change what the agent investigates, what it prioritizes and what it treats as finished. A persona is a markdown file with frontmatter, and the allowlists in it (`tools`, `skills`, `mcp`, `subagents`, `subagentTypes`) are enforced at runtime rather than described in the prompt. Only `coder-with-subagents` turns on delegation.
- **Real tools.** `bash`, `read`, `write`, `edit`, `glob`, `grep`, `ls`, `task`, `ssh`, `web_search`, `web_fetch`, and more: `memory`, `session_history`, `lsp`, `bash_output`, `bash_kill`, `todo_write`, `plan_done`, `question`, `review_report`, `goal_update`, `skill`, `skill_install`, `worktree`, `persona_create`. The calls on the parallel-safe list (`glob`, `grep`, `ls`, `lsp`, `memory`, `session_history`, `web_search`, `web_fetch`, `bash_output`) run concurrently inside one assistant message; the shells, writes, `task` calls and MCP calls run in call order, so a mutation cannot race a sibling. The agent has the filesystem, the shell, SSH and the web. Image files (jpg, png, gif, webp) go straight to a vision-capable model. The web tools are off until you turn them on with `/web`, which persists to the settings.
- **Your own model.** OpenRouter, OpenAI, Ollama (`http://localhost:11434/v1`), vLLM, LiteLLM, Azure OpenAI, or any endpoint that speaks the OpenAI chat completions API. The provider URL and the key live in `~/.cast/settings.json`. No account, no telemetry, no cloud dependency.
- **A terminal screen that owns its scrolling.** A full-screen interface on [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui): the wheel, the trackpad, PageUp, PageDown and search move through the transcript, and a repaint does not drag it back to the bottom. Multiline paste, image attachments, a subagent viewer. It fits a phone and a wide monitor alike. See [The Terminal Screen](docs/terminal-ui.md) for the tour.
- **A browser control room.** `cast web` serves the same sessions over HTTP and SSE, with token-by-token streaming, a diff viewer, background agents, a files tab and chat commands with account and project controls in Settings. `cast server` is the same command for daemon-oriented scripts and integrations.
- **Sessions that survive.** Every conversation is saved to SQLite at `~/.cast/sessions/sessions.db`. Resume with `--continue`, pick one with `--resume`, switch mid-session with `/sessions`, fork a thread with `/fork`, and take back a turn with `/undo` or `/rewind`.
- **Memory across sessions.** Durable project memory under `~/.cast/memory/`, with a SQLite full-text index derived from those files. A checkpoint writer updates the handoff files when a session nears the context threshold.
- **Plan mode.** `/plan` turns the agent read-only. It explores, writes a plan with `- [ ]` checklists into `<project>/.cast/plans/<session-id>/`, and calls `plan_done`. You then keep refining, implement in the current context, or implement in a clean one. `/build` hands the plan back to the implementation turn. An approved plan is re-read into the build-mode context across compaction and restarts, and its checklist is projected into the task list.
- **Context compaction.** When the conversation gets too long, the agent summarizes the older messages, which keeps the window useful without losing the details that matter.
- **Reasoning levels.** The reasoning control combines the provider's own model metadata with the configured provider dialect. Supported providers expose either `off` and `on` or effort levels such as `low`, `medium` and `high`; `--reasoning`, `/reasoning` and `/reasoning-format` set them, and the last one is for an endpoint that needs an explicit protocol.
- **Rules, skills and MCP servers.** Project rules in `.cast/rules/*.md`, in a Cursor-compatible format with four modes: always (injected every turn), auto (attached when matching files enter the context), lazy (the model reads it on demand) and manual (through `@mention` or `/rule:name`). Nested `.cast/rules/` directories scope the rules to that subtree. Skills come from `~/.cast/skills/` and `.cast/skills/`, plus the skills.sh universal paths (`.agents/skills/`, `~/.agents/skills/`, `~/.config/agents/skills/`), and follow the [Agent Skills spec](https://agentskills.io). MCP servers connect over stdio or streamable HTTP in the common `mcpServers` JSON shape, and their tools appear beside the built-in ones as `mcp_<server>_<tool>`.
- **Project context files.** Drop an `AGENTS.md` or `CLAUDE.md` in the repository root and cast injects it into the system prompt. Every ancestor directory up to `/` is walked, so org-wide guidelines in a parent folder apply to everything beneath it. The file in the working directory itself is trust-gated; files above load without a prompt. No special syntax and no config.

### Personas

| Persona | What it does |
|---------|-------------|
| `senior` (default) | Lazy senior dev: root-cause fixes, deletion over addition, verify-then-commit |
| `coder-with-subagents` | Delegates work to sub-agents through the `task` tool for parallel exploration |
| `analyst` | Product, analytical and project work: hypotheses, decisions, requirements, priorities and plans |
| `pm` | Turns settled decisions into project plans, milestones, dependencies and actionable tasks |
| `qa` | Functional review: requirements, regressions, scenarios and actionable findings |
| `researcher` | Source-backed investigations with searches, cross-checks and citations |
| `assistant` | Everyday help, planning, writing and quick lookups; uses tools when a task needs them |

Add your own in `~/.cast/personas/` (global) or `.cast/personas/` (project), or ask the agent in chat to build one. The constructor sets behaviour, built-in tools, skills, MCP servers, sub-agents and `agentsMd`, and it shows the proposed change before writing. Editing the active persona leaves the current turn alone; the override applies on the next message, and `/reload` is not needed.

Capability scoping is opt-in. The shipped personas keep the common tool, skill and MCP surface so that changing a role does not quietly remove a workflow, and a persona without an allowlist keeps every tool. Define allowlists on a custom persona when least privilege or a smaller prompt surface matters, for example a documentation-only role that cannot call shell or database tools. See [Personas](docs/personas.md) and [Persona Research](docs/persona-research.md).

## Interactive commands

| Command | Description |
|---------|-------------|
| Any text | Send a prompt to the agent |
| `/model [name]` | Show/change model |
| `/subagent-model [name]` | Show/change sub-agent model |
| `/plan-model [name\|off]` | Show/change the plan-mode model |
| `/plan-model-provider [name\|off]` | Set the provider for the plan-mode model |
| `/plan` | Enter plan mode (explore + plan only) |
| `/build` | Exit plan mode, restore full toolset |
| `/reasoning` | Change reasoning level |
| `/reasoning-format` | Select the provider reasoning protocol |
| `/persona [name]` | Show/change persona |
| `/provider` | Change provider endpoint and API key |
| `/permissions [default\|bypass]` | Show/change bash confirmation mode |
| `/web` | Toggle web tools (web_search, web_fetch) |
| `/web-fetch-provider` | Select Jina Reader or direct local fetch |
| `/sessions` | List/switch/delete saved sessions |
| `/fork` | Branch into a new session: the whole context, or from before one of your messages (web UI: also through an agent's answer) |
| `/undo` | Undo the last turn: put the files back and remove the turn from the conversation |
| `/rewind` | Rewind to before a chosen message: the files, the conversation, or both |
| `/skills` | List loaded skills |
| `/skill:name [args]` | Force-load and run a skill |
| `/mcp` | Toggle MCP servers on/off |
| `/hooks` | List and enable/disable lifecycle hooks |
| `/reload` | Re-scan skills, rules, MCP, and personas for cwd |
| `/rules` | List loaded rules |
| `/rule:name` | Invoke a rule by name |
| `/steer <msg>` | Inject message while agent is working |
| `/s <msg>` | Alias for `/steer` |
| `/queue <msg>` | Queue message for after agent stops |
| `/q <msg>` | Alias for `/queue` |
| `/queue-reset` | Clear the message queue |
| `/qr` | Alias for `/queue-reset` |
| `/abort`, `/stop` | Stop current agent run |
| `/compact` | Force context compaction |
| `/new` | Start a new session (autosaves current) |
| `/copy` | Copy last assistant response to clipboard |
| `/current` | Show all status bar data |
| `/clear` | Clear conversation context |
| `/ssh` | Manage SSH hosts (list, add, remove) |
| `/statusbar` | Toggle and reorder status bar segments |
| `/theme` | Change color theme |
| `/usage` | Show session token/cost usage |
| `/repo` | Show cwd and git branch |
| `/quit`, `/exit` | Save and exit |
| `/keys` | List all keybindings |
| `/help` | Show this command list |

The palette in the terminal lists every command, including the ones this table leaves out. [Interactive Commands](docs/interactive-commands.md) has the full reference.

## Command line

```
cast [options] [prompt]
  cast run [options] <message>   Non-interactive mode (stream to stdout, exit)
  cast run --interactive         Persistent JSONL session for programmatic clients
  cast web [start|stop|status]   Browser-based control room
  cast server [start|stop|status]  Alias for cast web
  cast upgrade [version] [--force]
                                Re-run installer to update
  cast shell-init [zsh|bash|fish]
                                A shell function that puts the resume command in your history
  cast requests <session> [n]   What the model was sent
  cast lsp <operation> <file> [...]  Ask a language server, as the lsp tool does

Options:
  -m, --model <model>        Model name
  -r, --reasoning <level>    off / low / medium / high / max
  -p, --persona <name>       Persona to use
  -c, --continue             Resume most recent session
  --resume                   Pick which session to resume (numbered list)
  --resume=<id>              Resume specific session by id
  -s, --session <id>         Resume specific session (alias for --resume=<id>)
  -w, --worktree <name>      Run in an isolated git worktree
  --bypass-permissions       Skip confirmations (alias --dangerously-skip-permissions)
  --skill <path>             Load extra skill (repeatable)
  --no-skills                Skip project/agents/global/plugin/builtin skill discovery
  --mcp <path>               Load extra MCP config (repeatable)
  --no-mcp                   Skip global/project MCP server discovery
  -v, --version              Show version
  -h, --help                 Show help

run subcommand:
  --format <default|json>    Output format
  --interactive              Persistent JSONL session protocol
  --keep-background          Leave background tasks running after the run exits
  (also accepts: -m, -r, -p, -c, -s, -w, --bypass-permissions, --skill, --mcp)
```

[CLI Reference](docs/cli-reference.md) has every flag and subcommand.

## How it works

One engine, three ways in. `runAgentLoop` in `src/core/loop.ts` is the only place a turn happens.

```
TUI  -+
      +- HTTP + SSE -> cast server daemon -> runAgentLoop -> LLM, tools, MCP
Web  -+
```

The daemon owns `runAgentLoop` for every session and is the only writer to the session store. The terminal screen starts one on loopback when none is alive, then talks to it over the same REST and SSE surface the browser uses. A session open in both places streams live tokens, tool calls and status to both, and an abort from either stops the turn for both.

Inside a turn the loop streams the model's answer, dispatches the tool calls it asks for, appends the results and calls the model again. The calls on the parallel-safe list run concurrently inside one assistant message; the shells, writes, `task` calls and MCP calls run in call order, so a mutation cannot race a sibling. When the history passes the compaction threshold the older turns are summarized, and the split snaps to turn boundaries so a tool call and its result stay together.

Every state change is an event. The daemon turns events into SSE messages, and the terminal screen, the browser and `cast run` all render that one stream rather than re-deriving the state themselves.

| Guide | What it covers |
| --- | --- |
| [Architecture](docs/architecture.md) | The source layout and the design decisions behind it. |
| [Infrastructure](docs/infrastructure.md) | The daemon, the clients, the lifecycle and the auth. |
| [The Terminal Screen](docs/terminal-ui.md) | Reading, typing, scrolling and choosing in the TUI. |
| [The Web UI](docs/web-ux.md) | The browser client: surfaces, flows and responsive rules. |
| [Tools](docs/tools.md) | Every built-in tool, its parameters and its limits. |
| [Personas](docs/personas.md) | The seven built-in personas and how to write your own. |
| [Rules](docs/rules.md) | The four rule modes and the nested layout. |
| [Skills](docs/skills.md) | The Agent Skills spec and where skills load from. |
| [MCP Servers](docs/mcp-servers.md) | Configuring local and remote MCP servers. |
| [Sessions](docs/sessions.md) | Storage, resume, the request log and the scratchpad. |
| [Memory](docs/memory.md) | The memory files, the search index and the commands. |
| [Plan Mode](docs/plan-mode.md) | The read-only gate and the plan files. |
| [Configuration](docs/configuration.md) | Every setting, the environment variables and the permissions. |
| [API v1](docs/api.md) | The daemon's HTTP and SSE contract and the OpenAPI document. |
| [All guides](docs/index.md) | The full index. |

## Configuration

User settings live in `~/.cast/settings.json`. They are loaded at startup and written atomically, so a crash mid-write cannot corrupt the file.

| Setting | Default | What it does |
| --- | --- | --- |
| `model`, `modelProvider` | from the first run | The model and the saved provider it belongs to. |
| `persona` | `senior` | The persona a new session starts with. |
| `providerUrl`, `apiKey` | from the first run | The active endpoint and its key. |
| `providers` | none | Saved providers: `name`, `url`, `apiKey`, optional `reasoningFormat`. |
| `reasoningLevel` | `off` | The reasoning effort. |
| `contextWindow` | `128000`, or the model catalog's value | The window used for budgeting. |
| `maxResponseTokens` | `32000` | Tokens held back for the model's own reply. |
| `compactionThreshold` | `0.75` | The fraction of the usable budget that triggers a compaction. |
| `maxTurnIterations` | `500` | The safety cap on model calls in one turn. |
| `maxToolOutputLines` | `2000` | The line cap on a single tool result. |
| `maxToolOutputBytes` | `131072` | The byte cap on a single tool result. |
| `webTools` | `false` | Whether `web_search` and `web_fetch` are advertised. |
| `autoFormat` | `true` | Run the project's formatter after each `write` or `edit`. |
| `lsp` | `true` | Report language server errors after each write. |
| `lspAutoInstall` | `true` | Install npm language servers into `~/.cast/lsp` on first use. |
| `notifications` | `true` | A terminal notification and a bell when a turn ends. |
| `scratchpad` | `true` | Give each session a scratch folder for temporary files. |
| `memoryEnabled` | `true` | Durable project memory and its retrieval. |
| `permissions` | none | Per-tool `allow`, `ask`, `deny` and `approved` rules. |
| `projectTrust` | none | The trust decision per project. |
| `serverToken` | generated | The password the web UI asks for. |

The environment variables:

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Bash executable for the `bash` tool (Windows: non-standard Git Bash / msys2) |
| `CAST_VERSION` | Pin install version (installer) |
| `CAST_SERVER_PORT` | Server daemon port (default `1337`) |
| `CAST_SERVER_HOST` | Server daemon bind address (default `127.0.0.1`; use `0.0.0.0` or `--public` for LAN) |
| `CAST_SESSIONS_DB` | Override SQLite session database path |
| `CAST_NO_DAEMON` | Run the loop in the terminal process instead of the daemon |

Provider credentials live only in the settings file. cast does not read `PROVIDER_BASE_URL`, `PROVIDER_API_KEY` or a project `.env`, so editing those changes nothing.

The files on disk:

```
~/.cast/
  settings.json         # User settings
  sessions/sessions.db  # The session store
  memory/               # Durable project memory
  scratch/<session id>/ # A scratch folder per session
  skills/  rules/  personas/  mcp.json

<project>/.cast/
  plans/<session-id>/   # Session plan files
  skills/  rules/  personas/
  mcp.json  hooks.json  ssh.json
```

### The web server

```bash
cast web                 # Start (default 127.0.0.1:1337)
cast web --port 8080     # Start on a different port
cast web --public        # Bind 0.0.0.0 so it is reachable from other machines
cast web status          # Check whether it is running
cast web stop            # Stop it
```

On first start cast generates a password, prints it in the terminal and saves it as `serverToken` in `~/.cast/settings.json`. The login name is always `cast`. The server serves its own themed sign-in screen and keeps the session in an HttpOnly, SameSite cookie; API responses are never cached.

The `--public` flag exposes plain HTTP. It is suitable only for a trusted LAN, and it cannot protect the password or the session from a network observer. For remote access without a domain or HTTPS, keep cast on its default loopback address and use an SSH tunnel: `ssh -L 1337:127.0.0.1:1337 user@host`.

The daemon records its bound address, a local-only TUI token and a per-process identity in `~/.cast/server.json`. A TUI on the same machine connects to `127.0.0.1` even when the daemon uses `--public`, and the token is accepted only from a loopback socket. Idle sessions without an attached client are released from daemon memory after five minutes and are reloaded from the session store when they are opened again.

`cast upgrade` verifies the daemon identity before restarting it and preserves its host and port. A foreground daemon is left running: restart that one by hand after the upgrade, so its terminal-owned work is never interrupted automatically.

## Development

```bash
npm install --ignore-scripts  # install
npm start                     # run from source through tsx
npm run check                 # tsc --noEmit and biome check src/ test/
npm test                      # the vitest suite
npm run build                 # bundle into dist/index.js with esbuild
npm run format                # biome format --write
npm run coverage              # vitest with v8 coverage
npm run coverage:check        # the per-file coverage floor
npm run e2e:plan              # a plan-mode smoke test in tmux, against a real provider
```

`npm install --ignore-scripts` skips the `prepare` hook, which installs the git hooks. Run `npm run hooks:install` when you want them. The suite is 243 vitest files, named after the module they cover, and it never makes a real provider call: the tests use a fake `baseURL` and `apiKey`. The exception is `test/mcp.test.ts`, which spawns a local test fixture server.

| Path | What it holds |
| --- | --- |
| `src/core/` | The engine: the agent loop, the tools, the LLM client, sessions, config, MCP, skills, personas. |
| `src/core/acp/` | The JSON-RPC bridge for the Agent Client Protocol. |
| `src/ui/` | The behaviour the terminal front end shares with the web server. |
| `src/ui-pi/` | The pi-tui front end: transcript, editor, modals, status row. |
| `src/server/` | The daemon, the REST and SSE bridge, the browser client. |
| `src/pickers/` | The onboarding pickers for model, persona and reasoning. |
| `prompts/` | The system prompts, the persona files, the compaction templates. |
| `test/` | The vitest suite. |
| `evals/` | The behaviour eval runner and the committed scoreboard data. |
| `scripts/` | The build, the documentation site, the end-to-end scripts. |
| `docs/` | The guides, one per subject. |

## License

MIT, © 2026 aa-blinov. See [LICENSE](LICENSE).
