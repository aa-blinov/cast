# Personas

A coding agent optimized for implementation isn't the best reviewer. A QA mindset doesn't write good specs. Personas let you swap the judgment — the lens through which the agent approaches your code — and optionally constrain which built-in tools that role may use. Different priorities, different questions, different output.

## Built-in Personas

| Persona | Label | Description |
|---------|-------|-------------|
| `coding` | Coding agent | Default persona — reads files, runs commands, edits code with precision |
| `coder-with-subagents` | Coder with subagents | Delegates parallel and isolated work to sub-agents via the task tool |
| `senior` | Senior Developer | Lazy senior dev — the ladder, root-cause fixes, deletion over addition |
| `tech-writer` | Technical Writer | Documentation — READMEs, guides, API references, changelogs, diagrams |
| `qa` | QA Engineer | Functional testing — verifies features, builds test plans, catches regressions |
| `qa-nfr` | QA Non-Functional | Non-functional testing — performance, security, reliability, scalability |
| `pm` | Project Manager | Task and spec writing — breaks work into clear, actionable tickets |
| `marketer` | Marketer | Positioning, messaging, and go-to-market |
| `fiction-writer` | Fiction Writer | Creative fiction and literary prose |
| `sysadmin` | System Administrator | Operations and infrastructure — diagnoses systems, manages services |
| `devops` | DevOps Engineer | CI/CD, IaC, containers, Kubernetes, deployments, observability |
| `dba` | Database Engineer | Schema design, migrations, query optimization, indexing |
| `appsec` | Security Engineer | Application security — threat modeling, secure code review, vulnerability analysis |

The `coding` persona is the default. The `coder-with-subagents` persona is the only one that enables the `task` tool for delegating work to sub-agents.

## Switching Personas

- **At startup**: `cast -p senior` or `cast --persona qa`
- **Interactively**: `/persona` (opens picker) or `/persona <name>`
- **First run**: persona is selected during onboarding

The persona choice is saved to `~/.cast/settings.json` and remembered across sessions.

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
