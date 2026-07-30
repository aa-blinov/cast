# Personas

A coding agent optimized for implementation isn't the best reviewer. A QA mindset doesn't write good specs. Personas let you swap the judgment — the lens through which the agent approaches your code — and optionally constrain which built-in tools that role may use. Different priorities, different questions, different output.

See [Persona Research](persona-research.md) for the science behind why role framing changes agent behavior — and where it doesn't.

## Built-in Personas

| Persona | Label | Description |
|---------|-------|-------------|
| `analyst` | Business Analyst | Requirements out of vague asks — contradictions, gaps, scenarios, acceptance criteria, API contracts |
| `appsec` | Security Engineer | Application security — threat modeling, secure code review, vulnerability analysis |
| `architect` | Architect | System design — trade-off analysis, ADRs, module boundaries; the deliverable is a decision, not a diff |
| `assistant` | Assistant | General-purpose everyday help — questions, planning, writing, quick lookups; uses tools only when a task needs them |
| `coder-with-subagents` | Coder with subagents | Delegates parallel and isolated work to sub-agents via the task tool |
| `dba` | Database Engineer | Schema design, migrations, query optimization, indexing |
| `devops` | DevOps Engineer | CI/CD, IaC, containers, Kubernetes, deployments, observability |
| `fiction-writer` | Fiction Writer | Creative fiction and literary prose |
| `marketer` | Marketer | Positioning, messaging, and go-to-market |
| `pm` | Project Manager | Task and spec writing — breaks work into clear, actionable tickets |
| `product` | Product Manager | Product thinking — hypotheses, success metrics, prioritization, user stories from raw feedback |
| `qa` | QA Engineer | Functional testing — verifies features, builds test plans, catches regressions |
| `qa-nfr` | QA Non-Functional | Non-functional testing — performance, security, reliability, scalability |
| `researcher` | Researcher | Open-ended questions and investigations — searches, reads sources, cross-checks claims, answers with citations |
| `senior` (default) | Senior Developer | Lazy senior dev — the ladder, root-cause fixes, deletion over addition |
| `sre` | SRE / Incident Responder | Incident-mode thinking — logs first, hypothesis→check loops, blameless postmortems, SLOs |
| `sysadmin` | System Administrator | Operations and infrastructure — diagnoses systems, manages services |
| `tech-writer` | Technical Writer | Documentation — READMEs, guides, API references, changelogs, diagrams |

The `senior` persona is the default. `coder-with-subagents` is the persona that enables the `task` tool for delegating work to sub-agents.

## Switching Personas

- **At startup**: `cast -p senior` or `cast --persona qa`
- **Interactively**: `/persona` (opens picker) or `/persona <name>`
- **First run**: persona is selected during onboarding

The persona travels with the thread: each session remembers the persona that drove it, and resuming (`-c`, `--resume`, `/sessions`, `/continue`) restores that persona — same rule as plan/build mode. The global choice in `~/.cast/settings.json` is the default for *new* sessions only. If a session's persona was deleted, resume keeps the current one with a notice.

Switching mid-conversation leaves the previous persona's reasoning in the context, so after switching to a *different* persona in a non-empty thread, cast offers to start a new session (the `/new` flow) — pick "Continue here" (or press Esc) to keep the current thread; the thread is then re-stamped with the new persona.

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
subagents: false
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

The body (after frontmatter) becomes the system prompt. A shared error-handling section is appended automatically from `prompts/error-handling.md` — you don't need to include tool-failure mechanics in your persona.

### Isolating a persona's zone of responsibility

`tools`, `skills`, `mcp`, and `subagentTypes` all follow the same allowlist shape and the same enforcement guarantee: a disallowed call is **rejected at runtime** (not just left out of the system prompt text), so these actually isolate what a persona can reach rather than just asking it nicely.

```yaml
tools: [read, grep, ls]            # readonly builtins
tools: [read, grep, plan_*, web_*]  # globs expand to plan_check, web_search, …
tools: []                           # no builtins at all
# omit the field entirely          # all builtins

skills: [research, deep-research]   # only these skill names are invokable
mcp: [postgres]                     # only this MCP server's tools are callable
mcp: [staging-*]                    # glob over server names
subagentTypes: [explore]            # `task` can only spawn the "explore" role
```

`skills`/`mcp` restrictions also apply to anything the persona delegates to via `task` — a restriction can't be routed around by spawning a subagent to do the disallowed thing instead.

Session policy still applies on top of every allowlist: plan/build mode, the web-tools toggle, and headless `cast run` can disable tools via their own denylist even if the persona listed them. `subagentTypes` has no effect unless `subagents: true`.

### AGENTS.md (`agentsMd`)

By default (`agentsMd: true`, or the field omitted), project context files (`AGENTS.md` / `CLAUDE.md`) are injected into the system prompt. Set `agentsMd: false` to skip them for that persona.

### Priority

On a name collision, the first-loaded persona wins:

1. **Project** (`.cast/personas/`) — highest priority
2. **Global** (`~/.cast/personas/`)
3. **Builtin** (`prompts/personas/`) — lowest priority

This lets you override a built-in persona by creating one with the same `name`.
