# cast

A role-based terminal agent harness. 18 built-in personas — senior dev, QA, DBA, security reviewer, PM, tech writer, and more — same tools, different judgment. Runs on any OpenAI-compatible model, including the one on your own hardware.

<p align="center"><img src="assets/cast-banner.svg" alt="cast" width="440"></p>

## Why cast?

**A cast, not a coder.** 18 built-in personas swap the agent's role without changing its tools. Senior dev for root-cause fixes, QA for edge cases, DBA for schema design, PM for specs, appsec for threat modeling — same tools, different judgment. Add your own with a single markdown file.

**Real tools, real work.** It reads files, writes code, runs shell commands, searches your codebase — and does it all in parallel. Delegates sub-tasks to isolated sub-agents. Rules, skills, and MCP servers extend capabilities without touching the codebase.

**Runs where your code runs.** vLLM, Ollama, your own inference server, or any OpenAI-compatible API. No account, no telemetry, no cloud dependency.

**Ink TUI.** A proper terminal interface with multiline paste, image attachments, smooth animations.
**Web UI.** `cast web` launches a browser-based control room — background agents, token-by-token streaming, diff viewer, and chat commands with account/project controls in Settings. Same sessions as the TUI.

## Why personas, not just prompts

Point a generic coding agent and a role-specific one at the same file, and they look for different things. An `appsec` persona flags injection risks; a `dba` persona flags missing indexes and normalization. A `qa` persona treats an untested edge case as unfinished work, while a `pm` persona treats an unwritten spec as unfinished work.

Personas in cast are not cosmetic text skins. Each persona is defined by markdown frontmatter (`~/.cast/personas/*.md` or `.cast/personas/*.md`) that can constrain available built-in tools (`tools`), skills (`skills`), MCP servers (`mcp`), and sub-agent delegation (`subagents`, `subagentTypes`).

Scoping capabilities per role prevents context bloat and instruction clutter during routine tasks. A technical writer or assistant persona does not need database tools, heavy shell mutation primitives, specialized skills, or external MCP server definitions flooding its system prompt. Narrowing the tool, skill, MCP, and subagent surface keeps the context window focused on the active role, reducing attention decay and preventing accidental or misrouted invocations.

For empirical research on role prompting and tool-agent behavior, see [docs/persona-research.md](docs/persona-research.md).

## Install

macOS / Linux:

```bash
curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

Windows (PowerShell):

```powershell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
```

Requires Node.js 22+. Self-contained bundle — no npm packages needed at runtime.

Pin a version: `CAST_VERSION=0.1.0 curl ... | bash`
Upgrade later: `cast upgrade`

## Quick Start

```bash
# Launch — prompts for provider URL + API key on first run, remembers after
cast

# One-shot prompt
cast "explain what this project does"

# Specific model + reasoning
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"

# Resume last session
cast -c
```

## What it can do

### Built-in tools

`bash` `read` `write` `edit` `glob` `grep` `ls` `task` `ssh` `web_search` `web_fetch` — the agent has full filesystem, shell, SSH remote, and web access. Multiple tools run in parallel. The `task` tool delegates work to isolated sub-agents (with their own persona and context) and returns only the final result. Image files (jpg/png/gif/webp) are sent directly to vision-capable models. Web tools are off by default — toggle with `/web` (persists to settings).

### Rules

Project-specific instructions in `.cast/rules/*.md` — Cursor-compatible format with four modes: always (injected every turn), auto (attached when matching files enter context), lazy (model reads on demand), and manual (via `@mention` or `/rule:name`). Nested `.cast/rules/` directories in subdirectories scope rules to that subtree.

### Project Context Files

Drop an `AGENTS.md` or `CLAUDE.md` in your repo root — cast picks it up automatically and injects it into the system prompt. Walks every ancestor directory up to `/`, so org-wide guidelines in a parent folder apply to all projects beneath it. The file in `cwd` itself is trust-gated; files above load without prompting. No special syntax, no config — just the file.

### Skills

Self-contained instruction packages loaded on demand from `~/.cast/skills/` / `.cast/skills/`, plus skills.sh universal paths (`.agents/skills/`, `~/.agents/skills/`, and the compatible `~/.config/agents/skills/`). Follows the [Agent Skills spec](https://agentskills.io). The agent sees what's available and loads the right one automatically.

### MCP Servers

Connect any [Model Context Protocol](https://modelcontextprotocol.io) server — local (stdio) or remote (streamable HTTP). Uses the common `mcpServers` JSON config shape. Their tools appear alongside the built-in ones.

### Personas

Swap the agent's role — and optionally which built-in tools that role may use:

| Persona | What it does |
|---------|-------------|
| `senior` (default) | Lazy senior dev — root-cause fixes, deletion over addition |
| `coder-with-subagents` | Delegates work to sub-agents via the `task` tool for parallel exploration |
| `analyst` | Stakeholder interviews, requirements synthesis, gap analysis |
| `architect` | System design — trade-off analysis, ADR drafts, dependency choice |
| `pm` | Product strategy, specs, prioritization |
| `product` | Product ops — release notes, feature flags, rollout strategy |
| `qa` | Functional testing — features, edge cases, regressions |
| `qa-nfr` | Non-functional — performance, security, reliability |
| `dba` | Database — schema design, migrations, query optimization |
| `devops` | CI/CD, IaC, containers, Kubernetes, deployments |
| `sre` | Site reliability — on-call, SLOs, incident response, capacity |
| `sysadmin` | Operations — diagnoses systems, manages services |
| `appsec` | Application security — threat modeling, secure code review |
| `tech-writer` | Documentation — READMEs, guides, API references, changelogs |
| `marketer` | Positioning, copy, go-to-market |
| `fiction-writer` | Creative fiction, prose, literary craft |

Add your own in `~/.cast/personas/` (global) or `.cast/personas/` (project).

### Plan mode

Plan mode is user-owned: `/plan` switches the agent to read-only exploration, and `/build` returns to implementation. The agent writes execution-spec plans with `- [ ]` checklists to `<project>/.cast/plans/<session-id>/`. Once it calls `plan_done`, choose to keep refining, implement in the current context, or implement in a clean model context while retaining the visible thread. An approved plan is re-read into build-mode context across compaction and restarts; its checklist is projected into the task list. Each phase can run its own model — see `/plan-model`.

### Context compaction

When the conversation gets too long, the agent automatically summarizes older messages — keeps the context window useful without losing important details.

### Reasoning levels

Reasoning controls combine provider model metadata with the configured provider dialect. Supported providers expose either `off`/`on` or effort levels such as `low`/`medium`/`high`; configure them with `--reasoning`, `/reasoning`, and `/reasoning-format` when an endpoint needs an explicit protocol.

### Sessions

Every conversation auto-saves. Resume with `--continue`, pick from a list with `--resume`, or switch mid-session with `/sessions`.

### Web UI

`cast web` launches a browser-based control room — same sessions as the TUI, with a diff viewer, background agents, and token-by-token streaming. The file reader previews text and code with wrapped lines and source-line numbers; Markdown, tables, images, and PDFs keep their document-specific previews. The TUI is still the default for local interactive use; the Web UI is the answer when you want to share a session, keep one running in the background, or drive cast from a browser/phone. `cast server` remains an alias for scripts and integrations.

```bash
# Start (default 127.0.0.1:1337)
cast web

# Start on a different port
cast web --port 8080

# Bind 0.0.0.0 so it's reachable from other machines on the network
cast web --public

# Lifecycle
cast web status
cast web stop
```

For local development, run the browser UI in the foreground with `npm run dev:web`. Pass server options after `--`, for example `npm run dev:web -- --port 8080`.

On first start, cast auto-generates a password and saves it to `serverToken` in `~/.cast/settings.json`. The login is always `cast`. Cast serves its own themed sign-in screen and keeps the resulting session in an HttpOnly, SameSite cookie; API responses are never cached. The password is shown in the terminal on first run so you can copy it; after that, look it up in `~/.cast/settings.json`.

The `--public` flag exposes plain HTTP. It is suitable only for a trusted LAN; it cannot protect the password or session from a network observer. For remote access without a domain or HTTPS, keep Cast on its default loopback address and use an SSH tunnel: `ssh -L 1337:127.0.0.1:1337 user@host`. Do not expose it directly on a public address.

The daemon records its bound address, a local-only TUI token, and a per-process identity in `~/.cast/server.json`. A TUI on the same machine connects to `127.0.0.1` even when the daemon uses `--public`; the token is accepted only from a loopback socket. Idle sessions without an attached client are released from daemon memory after five minutes and are lazily reloaded from the session store when opened again.

Env vars: `CAST_SERVER_PORT` (default `1337`), `CAST_SERVER_HOST` (default `127.0.0.1`).

## Interactive Commands

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
| `/fork` | Branch the current safe context into a new session |
| `/skills` | List loaded skills |
| `/skill:name [args]` | Force-load and run a skill |
| `/mcp` | Toggle MCP servers on/off |
| `/plugin` | Install, enable, disable, and remove marketplace plugins |
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

## CLI Options

```
cast [options] [prompt]
  cast run [options] <message>   Non-interactive mode (stream to stdout, exit)
  cast run --interactive         Persistent JSONL session for programmatic clients
  cast upgrade [version] [--force]
                                Re-run installer to update

Options:
  -m, --model <model>        Model name
  -r, --reasoning <level>    off / low / medium / high / max
  -p, --persona <name>       Persona to use
  -c, --continue             Resume most recent session
  --resume                   Pick which session to resume (numbered list)
  --resume=<id>              Resume specific session by id
  -s, --session <id>         Resume specific session (alias for --resume=<id>)
  --bypass-permissions       Skip dangerous-command confirmation
  --skill <path>             Load extra skill (repeatable)
  --no-skills                Skip project/agents/global/plugin/builtin skill discovery
  --mcp <path>               Load extra MCP config (repeatable)
  --no-mcp                   Skip global/project MCP server discovery
  -v, --version              Show version
  -h, --help                 Show help

run subcommand:
  --format <default|json>    Output format
  --interactive              Persistent JSONL session protocol
  (also accepts: -m, -r, -p, -c, -s, --bypass-permissions, --skill, --mcp)
```

## Provider Setup

On first run, cast asks for your provider URL and API key, then saves both to `~/.cast/settings.json`. No `.env` file needed.

Other environment variables (provider credentials live in the settings file, not env):

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Bash executable for the `bash` tool (Windows: non-standard Git Bash / msys2) |
| `CAST_VERSION` | Pin install version (installer) |
| `CAST_SERVER_PORT` | `cast web` port (default `1337`) |
| `CAST_SERVER_HOST` | `cast web` bind address (default `127.0.0.1`; use `0.0.0.0` or `--public` for LAN) |

Works with anything that speaks the OpenAI API: OpenRouter, OpenAI, Ollama (`http://localhost:11434/v1`), vLLM, LiteLLM, Azure OpenAI, etc.

## Architecture

```
src/
  core/           Agent logic (no UI dependency)
    loop.ts         Agent loop — streaming, tool dispatch, compaction
    tools.ts        Tool definitions (OpenAI function calling format)
    tools/          Tool executors: bash, files, search, web, task
    llm.ts          LLM interaction, streaming, retry, prompt caching
    session.ts      Session persistence, token estimation, compaction
    mcp.ts          MCP server connection (stdio + streamable HTTP)
    personas.ts     Persona loading (project > global > builtin)
    rules.ts        Cursor-compatible rule system (always/auto/lazy/manual, nested rules, @mentions)
    skills.ts       Agent Skills spec implementation
    config.ts       AppConfig, model validation, onboarding
    project.ts      System prompt assembly, trust gating
    startup.ts      Unified startup orchestration
    runner.ts       Queue management (steering, follow-ups)
    run.ts          Non-interactive runner (cast run)
    vendors.ts      Reasoning metadata, think-block parsing
    upgrade.ts      Self-update via GitHub releases
    ...
  ui/             Ink TUI components
    App.tsx         Top-level layout
    Composer.tsx    Input with autocomplete, image paste
    ChatLog.tsx     Message rendering
    commands.ts     Slash command handlers
    ...
  pickers/        Onboarding pickers (model, persona, reasoning)
  index.ts        CLI entry point

prompts/          System prompts, persona files, compaction templates
test/             Vitest unit tests
scripts/          esbuild bundle step
dist/             Compiled single-file bundle
```

## Development

```bash
npm install --ignore-scripts
npm start               # Run from source (tsx)
npm run check           # Type check + lint (tsc + biome)
npm test                # Unit tests (vitest)
npm run build           # Bundle into dist/index.js (esbuild)
npm run format          # Auto-format (biome)
npm run e2e:plan        # Plan-mode e2e smoke via tmux (real provider, costs tokens)
```

## License

[MIT](LICENSE)
