# Personas

Personas are swappable system prompts that give the agent a different role without changing its tools. The tools (bash, read, write, edit, find, grep, ls) are generic file/shell primitives — the persona shapes how they're used.

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

The body (after frontmatter) becomes the system prompt. A shared error-handling section is appended automatically from `prompts/error-handling.md` — you don't need to include tool-failure mechanics in your persona.

### Priority

On a name collision, the first-loaded persona wins:

1. **Project** (`.cast/personas/`) — highest priority
2. **Global** (`~/.cast/personas/`)
3. **Builtin** (`prompts/personas/`) — lowest priority

This lets you override a built-in persona by creating one with the same `name`.
