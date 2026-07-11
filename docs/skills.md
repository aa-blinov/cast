# Skills

Skills are self-contained instruction packages the agent loads on demand. They follow the [Agent Skills spec](https://agentskills.io) — a standard for packaging reusable agent capabilities.

## How Skills Work

The agent sees a list of available skills (name + description) in its system prompt. When a task matches a skill's description, the agent reads the skill file using the `read` tool to get full instructions. Skills with `disable-model-invocation: true` are hidden from the agent and can only be invoked manually via `/skill:<name>`.

## Built-in Skills

Skills ship with cast in `prompts/skills/`. Use `/skills` to see what's loaded.

## Loading Priority

Skills are discovered from multiple locations. On a name collision, the first-loaded skill wins:

1. **Project** — `.cast/skills/` (trust-gated)
2. **Global** — `~/.cast/skills/` (always loaded)
3. **Builtin** — `prompts/skills/` (ships with cast)
4. **Extra paths** — `--skill <path>` flags (loaded even with `--no-skills`)

Use `--no-skills` to skip discovery of project, global, and builtin skills. Extra paths still load.

## Creating a Skill

### Directory Structure

A skill is a directory containing a `SKILL.md` file:

```
~/.cast/skills/
  my-skill/
    SKILL.md          # Skill definition
    templates/        # Any supporting files
      example.md
```

Or a standalone `.md` file at the top level:

```
~/.cast/skills/
  my-skill.md
```

### SKILL.md Format

```markdown
---
name: my-skill
description: Does something useful for a specific task type
---

When invoked, follow these steps:

1. Read the relevant files
2. Analyze the situation
3. Apply the template from `templates/example.md`
4. Produce the output

Always check `templates/` for reference material.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Identifier (defaults to parent directory name) |
| `description` | **Yes** | What the skill does — skills without a description are dropped |
| `disable-model-invocation` | No | `true` to hide from the agent (manual `/skill:<name>` only) |

### Name Rules

Per the Agent Skills spec:

- Lowercase letters, digits, and hyphens only (`[a-z0-9-]+`)
- Must not start or end with a hyphen
- Must not contain consecutive hyphens (`--`)
- Maximum 64 characters

Names that violate these rules generate a warning but still load.

### Relative Paths

When a skill file references relative paths (templates, examples, configs), resolve them against the skill's directory. The system prompt tells the agent: *"When a skill file references a relative path, resolve it against the skill directory."*

## Invoking Skills

### Automatic

The agent reads a skill when the user's task matches its description. No special syntax needed.

### Manual

Force-load a skill by name:

```
/skill:arxiv search for papers about transformers
/skill:cast add a new persona
```

The `/skill:<name>` command reads the skill's full content and submits it to the agent as context, followed by any additional arguments.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--skill <path>` | Load an extra skill file or directory (repeatable) |
| `--no-skills` | Skip global/project/builtin skill discovery |

```bash
cast --skill ./my-project-skill.md
cast --no-skills --skill ~/.cast/skills/arxiv/SKILL.md
```

Extra paths (`--skill`) work even with `--no-skills` — they're explicit additions, not auto-discovery.

## Discovery Rules

The discovery algorithm for each directory:

1. If the directory contains `SKILL.md`, load it as a single skill and stop recursing.
2. Otherwise, load direct `.md` children as standalone skills, and recurse into subdirectories looking for `SKILL.md`.

Directories starting with `.` or named `node_modules` are always skipped.
