# Sub-agents & Delegation

`cast` supports delegating complex, multi-turn, or parallel tasks to isolated sub-agents via the `task` tool.

## Overview

A sub-agent is a background instance of the agent loop running in an isolated context:
- **Isolated Context**: The main conversation context avoids clutter from intermediate tool calls, raw logs, or exploratory search results. Only the final summary or answer returns.
- **Parallel Execution**: The main agent can spawn multiple sub-agents in a single turn (`Promise.all`) to explore different parts of a codebase simultaneously.
- **Dedicated System Prompts**: Sub-agents load specialized prompts from `prompts/subagents/` (`worker`, `explore`, `review`).
- **Model Overrides**: Sub-agents can use a different model via `/subagent-model` or `/subagent-model-provider`.

## Enabling Delegation (`subagents` field)

The `task` tool is **persona-gated**. By default, built-in personas like `senior` or `qa` do **not** have access to `task`.

To enable delegation, a persona's frontmatter must specify:

```yaml
subagents: true
```

The built-in `coder-with-subagents` persona has `subagents: true` set by default.

### Restricting Subagent Roles (`subagentTypes`)

You can restrict which specific sub-agent roles a persona is allowed to spawn:

```yaml
subagents: true
subagentTypes: [explore, review]   # Can spawn 'explore' and 'review', but not 'worker'
```

If `subagentTypes` is omitted, the persona can spawn any configured sub-agent role.

## Built-in Sub-agent Roles

`cast` includes three standard sub-agent roles:

| Role | Description | Allowed Built-in Tools | Usage |
|------|-------------|-----------------------|-------|
| `worker` | Default catch-all role | All built-in tools (except `task`) | Edits, refactoring, mixed tasks |
| `explore` | Read-only codebase exploration | `read`, `grep`, `glob`, `ls`, `bash` | Structural research, finding symbols/files |
| `review` | Independent code validation | `read`, `grep`, `glob`, `ls`, `bash` | Verification of changes before reporting done |

Sub-agents cannot delegate further: the `task` tool is stripped from all sub-agents to prevent infinite recursive spawning.

## Frontmatter Configuration

Custom sub-agent prompts live in `prompts/subagents/<name>.md` or can be loaded dynamically. Frontmatter supports tool allowlists and context rules:

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

- **`tools`**: Allowlist of built-in tools. (MCP tools are not restricted by this list).
- **`agentsMd`**: `true` (default) injects project `AGENTS.md` / `CLAUDE.md` context files into the sub-agent prompt.

## Inherited Restrictions & Security

Sub-agents inherit security and discovery constraints from the parent session:
- **Skills and MCP Inheritance**: Parent restrictions on `skills` and `mcp` automatically cascade down to sub-agents. A persona restricted from an MCP server cannot bypass the restriction by delegating to a sub-agent.
- **Trust Gating**: Sub-agents operate under the parent session's project trust decision.
- **CLI Overrides**: Flags like `--no-skills` or `--skill <path>` are honored by sub-agents.

## Model & Provider Selection

You can run sub-agents on a separate model to save costs or speed up parallel searches:

- **TUI Commands**:
  - `/subagent-model <model>` — set model for sub-agents (e.g. `/subagent-model gpt-4o-mini`)
  - `/subagent-model-provider <provider>` — set provider for sub-agents
- **Web UI**: Managed under Settings → Model tab (`Subagent Model` slot).
- **Configuration**: Persisted in `~/.cast/settings.json` under `subagentModel` and `subagentModelProvider`.
