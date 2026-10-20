# Documentation

The guides for cast. They are written for the person who has a question about
the agent harness and wants the answer without reading the source first.

Start with the [README](../README.md) for what the project is and how to run it.
The [architecture](architecture.md) is for the person who wants to change it.

## Getting started

| Document | What it covers |
| --- | --- |
| [getting-started.md](getting-started.md) | Install, first run, provider setup. |
| [cli-reference.md](cli-reference.md) | Every flag and subcommand of `cast`. |
| [configuration.md](configuration.md) | `settings.json`, the environment variables, the permissions. |
| [api.md](api.md) | The daemon's HTTP and SSE contract and its OpenAPI document. |
| [acp.md](acp.md) | The JSON-RPC bridge for the Agent Communication Protocol. |

## The agent

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | The source layout and the decisions behind it. |
| [infrastructure.md](infrastructure.md) | The daemon, the clients, the lifecycle and the auth. |
| [tools.md](tools.md) | Every built-in tool, its parameters and its limits. |
| [sessions.md](sessions.md) | Storage, resume, the request log and the scratchpad. |
| [memory.md](memory.md) | The memory files, the search index and the commands. |
| [plan-mode.md](plan-mode.md) | The read-only gate and the plan files. |
| [worktrees.md](worktrees.md) | Session-scoped git worktrees. |
| [subagents.md](subagents.md) | Delegation and the sub-agent prompt. |
| [reasoning.md](reasoning.md) | Reasoning levels and what each provider supports. |

## The surfaces

| Document | What it covers |
| --- | --- |
| [terminal-ui.md](terminal-ui.md) | A tour of the terminal screen: reading, typing, scrolling, choosing. |
| [web-ux.md](web-ux.md) | The browser client: surfaces, flows and the responsive rules. |
| [interactive-commands.md](interactive-commands.md) | Every `/slash` command in the terminal front end. |
| [non-interactive-mode.md](non-interactive-mode.md) | `cast run` and its JSON output. |
| [themes.md](themes.md) | The colour themes and the one the browser reads. |
| [dashboard.md](dashboard.md) | The web analytics: token use, latency, reliability. |

## Extending the agent

| Document | What it covers |
| --- | --- |
| [personas.md](personas.md) | The seven built-in personas and how to write your own. |
| [persona-research.md](persona-research.md) | The research behind role-based agent behaviour. |
| [skills.md](skills.md) | The Agent Skills spec and where skills load from. |
| [rules.md](rules.md) | The four rule modes and the nested layout. |
| [mcp-servers.md](mcp-servers.md) | Configuring local and remote MCP servers. |
| [hooks.md](hooks.md) | The `PreToolUse`, `PostToolUse` and `Stop` shell hooks. |
| [context-files.md](context-files.md) | The `AGENTS.md` and `CLAUDE.md` hierarchy. |

## Evaluations

| Document | What it covers |
| --- | --- |
| [eval-behavior.md](eval-behavior.md) | The behavioural contracts a real model is measured against. |
| [eval-methodology.md](eval-methodology.md) | Scoreboard, repeats, traces and regressions. |
| [perf-baseline/baseline.md](perf-baseline/baseline.md) | The measured performance baseline. |

## Reference

| Document | What it covers |
| --- | --- |
| [changelog.md](changelog.md) | The version history. |
| [index.md](index.md) | The flat table of contents. |
| [../DESIGN.md](../DESIGN.md) | The colours, the type and the components of both surfaces. |
| [../PRODUCT.md](../PRODUCT.md) | The product truth the code is measured against. |
| [../AGENTS.md](../AGENTS.md) | The commands, the traps and the rails for a session that opens the repository. |

## Reading order

New here: [../README.md](../README.md), then [getting-started.md](getting-started.md),
then [architecture.md](architecture.md).

Changing the agent's behaviour: [personas.md](personas.md) and
[rules.md](rules.md) before you touch `src/core/`.

Changing the engine: [architecture.md](architecture.md), then
[../AGENTS.md](../AGENTS.md) for the traps, and the guides under
[The agent](#the-agent) for the subsystem you are in.
