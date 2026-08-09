# Skills

Skills are self-contained instruction packages the agent loads on demand. They follow the [Agent Skills spec](https://agentskills.io) — a standard for packaging reusable agent capabilities.

## How Skills Work

The agent sees a list of available skills (name + description, and `description — whenToUse` when `when_to_use` is set) in its system prompt. When a task matches a skill's description, the agent calls the dedicated `skill` tool with the skill's name to get full instructions — it no longer reads the skill file via the generic `read` tool. Skills with `disable-model-invocation: true` are hidden from the agent and can only be invoked manually via `/skill:<name>`.

## Built-in Skills

Skills ship with cast in `prompts/skills/`. Use `/skills list` to see what's loaded; bare `/skills` toggles them on/off.

## Loading Priority

Skills are discovered from multiple locations. On a name collision, the first-loaded skill wins:

1. **Project (cast)** — `.cast/skills/` (trust-gated)
2. **Project (agents)** — `.agents/skills/` (trust-gated; skills.sh / `npx skills add` universal path)
3. **Global (cast)** — `~/.cast/skills/` (always loaded)
4. **Global (agents)** — `~/.agents/skills/` then the compatible `~/.config/agents/skills/` (skills.sh universal global)
5. **Plugin** — skills from enabled `/plugin install name@marketplace` packages
6. **Builtin** — `prompts/skills/` (ships with cast)
7. **Extra paths** — `--skill <path>` flags (loaded even with `--no-skills`)

Use `--no-skills` to skip auto-discovery (including `.agents/skills`). Extra paths (`--skill`) still load.

### skills.sh / `npx skills add`

```bash
npx -y skills add mattpocock/skills --skill grill-me -a universal
```

Installs into `.agents/skills/` (project) or `~/.agents/skills/` (global). Cast also recognizes the compatible `~/.config/agents/skills/` location. It loads these automatically after `/reload` (or on next start). Invoke with `/skill:grill-me` (not `/grill-me`).

## Creating a Skill

### Directory Structure

A skill is a directory containing a `SKILL.md` file:

```
~/.cast/skills/
  my-skill/
    SKILL.md          # Skill definition
    scripts/          # Executable code, run only when the skill instructs it
    references/       # Documentation, read only when needed
    assets/           # Templates, images, data and other static resources
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
| `name` | **Yes** | Identifier; for `SKILL.md`, it must match the containing directory |
| `description` | **Yes** | What the skill does — invalid skills are not loaded |
| `license` | No | License name or a reference to a bundled license file |
| `compatibility` | No | Environment requirements; 1–500 characters |
| `metadata` | No | Mapping of string keys to string values for client-specific data |
| `allowed-tools` | No | Experimental space-separated list of pre-approved tools; retained and exposed with the skill, with execution semantics depending on the client |
| `disable-model-invocation` | No | `true` to hide from the agent (manual `/skill:<name>` only) |
| `when_to_use` | No | Extra matching guidance shown to the model as `description — whenToUse` in the skill listing |

### Name Rules

Per the Agent Skills spec:

- Lowercase letters, digits, and hyphens only (`[a-z0-9-]+`)
- Must not start or end with a hyphen
- Must not contain consecutive hyphens (`--`)
- Maximum 64 characters

Malformed required fields, invalid YAML, and a directory/name mismatch prevent the skill from loading. Cast warns when the body exceeds the spec's recommended 500 lines but still loads it.

### Relative Paths

When a skill file references relative paths (scripts, references, assets, templates, configs), resolve them against the skill's directory. The system prompt tells the agent: *"When a skill file references a relative path, resolve it against the skill directory."* Resources are never automatically read or executed: the agent loads or runs the referenced file only when the activated instructions require it.

## Enabling / disabling

| Command | Description |
|---------|-------------|
| `/skills` | Toggle on/off (multi-select picker, like `/mcp`) |
| `/skills list` | Read-only catalog (source + on/off) |
| `/skills enable` / `disable <name>` | Toggle one skill without the picker |
| `/skills uninstall` | Remove a global/project skill (picker + confirm, or typed name) |
| `/skills help` | Cheat sheet |

Disabled names are stored in `~/.cast/settings.json` as `disabledSkills`. `/skill:<name>` only works for enabled skills.

Plugin skills show their pack id in the picker/list (`plugin · name@marketplace`). If the pack is disabled via `/plugin`, the skill stays visible but locked (muted, Space ignored) until you re-enable the pack — it is not added to `disabledSkills`.

`/skills uninstall` deletes a **global**, **project**, or **agents** (`.agents/skills`) skill from disk. Plugin skills appear in the picker muted/locked (Enter ignored) — remove the pack with `/plugin uninstall`. Builtin and `--skill` paths are omitted.

Whole marketplace packs can be toggled with bare `/plugin` (see [Plugins](plugins.md)).

### Hot-reload

`/skills` toggle / `enable` / `disable` / `uninstall` and `/plugin install` / enable / uninstall update the skill catalog **in the current session** — no `/reload`, no restart.

Use `/reload` only after dropping or editing skill files on disk yourself (e.g. `npx skills add`, copy into `.cast/skills/`). See [Interactive commands](interactive-commands.md#hot-reload-vs-reload).

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

### Argument Substitution

Skill bodies can reference invocation arguments and their own directory:

| Placeholder | Substituted with |
|-------------|-------------------|
| `$ARGUMENTS` | The full argument string |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, ... / `$0`, `$1`, ... | An individual argument (shell-quote-style parsing — quoted strings stay intact) |
| `${CLAUDE_SKILL_DIR}` | Absolute path to the skill's own directory, for resolving relative paths |

If arguments are supplied but the skill body contains no `$ARGUMENTS` placeholder, they're appended as a trailing `User: <args>` line instead of being silently dropped.

### The `skill` Tool

The agent invokes skills through a dedicated `skill` tool (`name`, optional `args`) rather than reading `SKILL.md` via the generic `read` tool. It validates the name, enforces `disable-model-invocation`, performs the substitution above, and returns the formatted skill content in one call.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--skill <directory>` | Load an extra skill package directory (repeatable) |
| `--no-skills` | Skip project/agents/global/plugin/builtin skill discovery |

```bash
cast --skill ./my-project-skill
cast --no-skills --skill ~/.cast/skills/arxiv
```

Extra paths (`--skill`) work even with `--no-skills` — they're explicit additions, not auto-discovery.

## Discovery Rules

The discovery algorithm for each directory:

1. If the directory contains `SKILL.md`, load it as a single skill and stop recursing.
2. Otherwise recurse into subdirectories looking for skill directories. Arbitrary `.md` files are not skills.

Directories starting with `.` or named `node_modules` are always skipped.
