# Personas

A coding agent optimized for implementation isn't the best reviewer. A QA mindset doesn't write good specs. Personas let you swap the judgment — the lens through which the agent approaches your code — and optionally constrain which built-in tools that role may use. Different priorities, different questions, different output.

## Built-in Personas

| Persona | Label | Description |
|---------|-------|-------------|
| `coding` | Coding agent | Default persona — reads files, runs commands, edits code with precision |
| `analyst` | Business Analyst | Requirements out of vague asks — contradictions, gaps, scenarios, acceptance criteria, API contracts |
| `architect` | Architect | System design — trade-off analysis, ADRs, module boundaries; the deliverable is a decision, not a diff |
| `coder-with-subagents` | Coder with subagents | Delegates parallel and isolated work to sub-agents via the task tool |
| `coder-with-subagents-force-review` | Coder · forced review | Same delegation, plus a mandatory review gate: every code change goes through an independent `review` sub-agent (fresh context, diff-based, one round) before being reported done |
| `senior` | Senior Developer | Lazy senior dev — the ladder, root-cause fixes, deletion over addition |
| `tech-writer` | Technical Writer | Documentation — READMEs, guides, API references, changelogs, diagrams |
| `qa` | QA Engineer | Functional testing — verifies features, builds test plans, catches regressions |
| `qa-nfr` | QA Non-Functional | Non-functional testing — performance, security, reliability, scalability |
| `pm` | Project Manager | Task and spec writing — breaks work into clear, actionable tickets |
| `marketer` | Marketer | Positioning, messaging, and go-to-market |
| `fiction-writer` | Fiction Writer | Creative fiction and literary prose |
| `product` | Product Manager | Product thinking — hypotheses, success metrics, prioritization, user stories from raw feedback |
| `sre` | SRE / Incident Responder | Incident-mode thinking — logs first, hypothesis→check loops, blameless postmortems, SLOs |
| `sysadmin` | System Administrator | Operations and infrastructure — diagnoses systems, manages services |
| `devops` | DevOps Engineer | CI/CD, IaC, containers, Kubernetes, deployments, observability |
| `dba` | Database Engineer | Schema design, migrations, query optimization, indexing |
| `appsec` | Security Engineer | Application security — threat modeling, secure code review, vulnerability analysis |

The `coding` persona is the default. `coder-with-subagents` and `coder-with-subagents-force-review` are the personas that enable the `task` tool for delegating work to sub-agents.

Why `coder-with-subagents-force-review` reviews in a sub-agent rather than in place: self-review in the same context is unreliable (the model is biased toward the reasoning that produced the code, and a contaminated context contaminates the check). The gate hands the reviewer only the task summary and the diff — never the implementation reasoning — requires findings to be confirmed by execution, and runs exactly one round to avoid review ping-pong.

## Switching Personas

- **At startup**: `cast -p senior` or `cast --persona qa`
- **Interactively**: `/persona` (opens picker) or `/persona <name>`
- **First run**: persona is selected during onboarding

The persona travels with the thread: each session remembers the persona that drove it, and resuming (`-c`, `--resume`, `/sessions`) restores that persona — same rule as plan/build mode. The global choice in `~/.cast/settings.json` is the default for *new* sessions only. If a session's persona was deleted, resume keeps the current one with a notice.

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
tools: [read, grep, ls, plan_*, web_*]
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
| `tools` | No | Allowlist of **built-in** tools. Omit = all builtins. Exact names or `*`-globs (`plan_*`, `web_*`). MCP tools are never filtered by this list |
| `agentsMd` | No | Inject `AGENTS.md` / `CLAUDE.md` into the system prompt (default: `true`) |

The body (after frontmatter) becomes the system prompt. A shared error-handling section is appended automatically from `prompts/error-handling.md` — you don't need to include tool-failure mechanics in your persona.

### Tool allowlist (`tools`)

When set, only matching **built-in** tools are advertised to the model and executable (a fabricated call to a filtered tool returns "not available"). Connected MCP servers are unaffected — their tools stay available whenever the session has them connected.

```yaml
tools: [read, grep, ls]           # readonly builtins
tools: [read, grep, plan_*, web_*] # globs expand to plan_write, web_search, …
tools: []                          # no builtins (MCP still available)
# omit the field entirely         # all builtins
```

Session policy still applies on top of the allowlist: plan/build mode, the web-tools toggle, and headless `cast run` can disable tools via their own denylist even if the persona listed them. The `task` tool additionally requires `subagents: true`.

### AGENTS.md (`agentsMd`)

By default (`agentsMd: true`, or the field omitted), project context files (`AGENTS.md` / `CLAUDE.md`) are injected into the system prompt. Set `agentsMd: false` to skip them for that persona.

### Priority

On a name collision, the first-loaded persona wins:

1. **Project** (`.cast/personas/`) — highest priority
2. **Global** (`~/.cast/personas/`)
3. **Builtin** (`prompts/personas/`) — lowest priority

This lets you override a built-in persona by creating one with the same `name`.
