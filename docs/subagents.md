# Sub-agents & Delegation

`cast` supports delegating complex, multi-turn, or parallel tasks to isolated sub-agents via the `task` tool.

## Overview

A sub-agent is a separate instance of the agent loop running in an isolated context:
- **Isolated Context**: The main conversation context avoids clutter from intermediate tool calls, raw logs, or exploratory search results. Only the final report returns, wrapped as `<task id="…" subagent="…" state="…">…</task>` and cut at 30,000 characters.
- **Parallel Execution**: Several `task` calls in one model response run at the same time, up to 4 per session; the rest wait for a free slot.
- **A session of its own**: Each sub-agent is saved as a child session of the conversation (hidden from the session list). Its task id is that session's id.
- **Follow-ups**: Calling `task` again with `task_id` continues the same sub-agent with its full history instead of starting over. For a sub-agent that is still running, the new assignment is steered into it.
- **Background**: `background: true` returns at once; the report arrives as a message when the sub-agent finishes, and starts a new turn if the session is idle. Offered where the host can deliver it (TUI and web).
- **Dedicated System Prompts**: Sub-agents load specialized prompts from `prompts/subagents/` (`worker`, `explore`, `review`).
- **Model Overrides**: Sub-agents can use a different model via `/subagent-model` or `/subagent-model-provider`.

## Enabling Delegation (`subagents` field)

The `task` tool is **persona-gated**. Among the built-ins, `senior` (the default) and `coder-with-subagents` have it; `qa`, `analyst`, `pm`, `assistant` and `researcher` do not.

To enable delegation, a persona's frontmatter must specify:

```yaml
subagents: true
```

`senior` delegates sparingly — wide exploration, independent areas in parallel, an independent review. `coder-with-subagents` leans on delegation much harder.

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
| `explore` | Read-only codebase exploration | `read`, `grep`, `glob`, `ls`, inspection-only `bash` | Structural research, finding symbols/files |
| `review` | Independent code validation | `read`, `grep`, `glob`, `ls`, `bash` | Verification of changes before reporting done |

Sub-agents cannot delegate further: the `task` tool is stripped from all sub-agents to prevent infinite recursive spawning.

## Custom Sub-agents

Beyond the built-ins in `prompts/subagents/`, cast loads `~/.cast/subagents/*.md` and, for a trusted project, `.cast/subagents/*.md`. A later source replaces a same-named earlier one (project over global over built-in). Frontmatter supports tool allowlists and context rules:

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
- **`readOnly`**: `true` takes `write`/`edit` away and makes `bash` inspection-only, enforced by the harness rather than asked for in the prompt. The built-in `explore` sets it.

## Watching Sub-agents

- **Web UI**: a `task` card shows the sub-agent, its title, the tool call it is on and how many it has made. **Open** shows its session (view only, with a way back to the thread); **Stop** ends a running one.
- **TUI**: a running `task` row leads with `[explore ↳ read src/auth.ts · 3]`. `/agents` lists the session's sub-agents: pick one to see its session as a digest (the assignment, each tool call, the report), or stop a running one.
- **API**: `GET /api/sessions/:id/agents` lists them; `POST /api/sessions/:id/agents/:taskId/cancel` stops one.

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
