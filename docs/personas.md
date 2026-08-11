# Personas

A coding agent optimized for implementation is not the best reviewer. A QA mindset does not write good specs. Personas let you swap the agent's judgment without changing your codebase, and optionally narrow its tool access.

See [Persona Research](persona-research.md) for empirical studies on role framing and agent behavior.

## Built-in Personas

| Persona | Label | Description |
|---------|-------|-------------|
| `analyst` | Product & Project Analyst | Product, analytical, and project work — turns vague goals into hypotheses, decisions, requirements, priorities, and actionable plans |
| `assistant` | Assistant | General-purpose everyday help — questions, planning, writing, quick lookups; uses tools when a task actually needs them |
| `coder-with-subagents` | Coder with subagents | Delegates parallel and isolated work to sub-agents via the task tool |
| `pm` | Planner | Turns settled decisions into clear project plans, milestones, dependencies, and actionable tasks |
| `qa` | Reviewer | Functional review — checks behavior against requirements, finds regressions, and produces actionable findings |
| `researcher` | Researcher | Open-ended questions and investigations — searches, reads sources, cross-checks claims, answers with citations instead of recall |
| `senior` (default) | Senior Developer | Lazy senior dev — the ladder, root-cause fixes, deletion over addition, verify-then-commit |

The `senior` persona is the default. Built-in personas deliberately share the normal built-in, skill, and MCP tool surface, so changing role does not unexpectedly break a workflow. `coder-with-subagents` is the exception: it additionally enables the `task` tool for delegating work to sub-agents. Use a custom persona's allowlists when a role needs least privilege or a smaller tool prompt.

## Switching Personas

- **At startup**: `cast -p senior` or `cast --persona qa`
- **Interactively**: `/persona` (opens picker) or `/persona <name>`
- **First run**: persona is selected during onboarding

The persona travels with the thread: each session remembers its driving persona, and resuming (`-c`, `--resume`, `/sessions`, `/continue`) restores it. The global choice in `~/.cast/settings.json` serves as the default for new sessions only. If a session's persona was deleted, resume keeps the current active persona with a notice.

Switching mid-conversation leaves previous reasoning in context. When changing personas in a non-empty thread, cast prompts to start a new session (`/new`). Select "Continue here" (or press Esc) to keep the current thread re-stamped under the new persona.

## Create or Customize from Chat

You can ask the agent to create a persona or customize the currently effective one directly in chat. The constructor can change six areas:

- behavior and system-prompt instructions;
- built-in tools;
- skills;
- MCP servers;
- sub-agent delegation and allowed sub-agent roles;
- project instructions from `AGENTS.md` / `CLAUDE.md` via `agentsMd`.

For a new persona, cast normally defaults to the global scope (`~/.cast/personas/`). Use the project scope (`.cast/personas/`) only when the persona is explicitly intended for one project. A built-in persona is never edited in place: a same-name global or project persona overrides it according to the priority rules below.

Before writing, cast shows the proposed name, scope, description, and behavior summary. If the active persona is customized, the current turn keeps its original prompt and tool set; the override is loaded automatically for the next user message. `/reload` is not required for that chat flow.

## Custom Personas

Create a `.md` file in one of these locations:

| Location | Scope | Trust |
|----------|-------|-------|
| `~/.cast/personas/` | Global (all projects) | Always loaded |
| `.cast/personas/` | Project-local | Trust-gated |

### File Format

```markdown
---
name: my-persona
label: My Custom Persona
description: What this persona does
subagents: true
subagentTypes: [explore, review]
tools: [read, grep, ls, plan_*, web_*]
skills: [research, deep-research]
mcp: [postgres, playwright*]
agentsMd: true
---

You are a specialized assistant focused on [role].

Your approach:
- [guideline 1]
- [guideline 2]

When analyzing code, always consider:
- [consideration 1]
- [consideration 2]
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Identifier (lowercase, used in `-p` flag and `/persona` command) |
| `label` | No | Display name (defaults to `name`) |
| `description` | No | Shown in persona listings |
| `subagents` | No | `true` to enable the `task` tool (default: `false`) |
| `subagentTypes` | No | Allowlist of subagent role names this persona may spawn via `task` (narrows `subagents: true` further). Omit = every configured role. Exact names or `*`-globs |
| `tools` | No | Allowlist of **built-in** tools. Omit = all builtins. Exact names or `*`-globs (`plan_*`, `web_*`) |
| `skills` | No | Allowlist of skill names this persona may invoke via the `skill` tool. Omit = every discovered skill. Exact names or `*`-globs |
| `mcp` | No | Allowlist of MCP **server** names (not individual tool names) whose tools stay available. Omit = every connected server. Exact names or `*`-globs |
| `agentsMd` | No | Inject `AGENTS.md` / `CLAUDE.md` into the system prompt (default: `true`) |

The body after frontmatter becomes the system prompt. A shared error-handling section is appended automatically from `prompts/error-handling.md` without needing tool-failure mechanics in persona files.

### Isolating a persona's zone of responsibility

`tools`, `skills`, `mcp`, and `subagentTypes` follow the same allowlist shape and enforcement guarantee: disallowed calls are rejected at runtime rather than relying solely on prompt instructions.

```yaml
tools: [read, grep, ls]            # readonly builtins
tools: [read, grep, plan_*, web_*]  # globs expand to plan_done, web_search, …
tools: []                           # no builtins at all
# omit the field entirely          # all builtins

skills: [research, deep-research]   # only these skill names are invokable
mcp: [postgres]                     # only this MCP server's tools are callable
mcp: [staging-*]                    # glob over server names
subagentTypes: [explore]            # `task` can only spawn the "explore" role
```

`skills`/`mcp` restrictions also apply to anything the persona delegates to via `task` — a restriction can't be routed around by spawning a subagent to do the disallowed thing instead. These restrictions are optional: they are not inferred from a persona's label or description, and a persona without an allowlist keeps the normal available surface.

Session policy still applies on top of every allowlist: plan/build mode, the web-tools toggle, and headless `cast run` can disable tools via their own denylist even if the persona listed them. `subagentTypes` has no effect unless `subagents: true`.

### AGENTS.md (`agentsMd`)

By default (`agentsMd: true`, or the field omitted), project context files (`AGENTS.md` / `CLAUDE.md`) are injected into the system prompt. Set `agentsMd: false` to skip them for that persona.

### Priority

On a name collision, the first-loaded persona wins:

1. **Project** (`.cast/personas/`) — highest priority
2. **Global** (`~/.cast/personas/`)
3. **Builtin** (`prompts/personas/`) — lowest priority

This lets you override a built-in persona by creating one with the same `name`.
