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
6. **Builtin** — `prompts/skills/` (ships with cast)
7. **Extra paths** — `--skill <directory>` flags (loaded even with `--no-skills`)

Use `--no-skills` to skip auto-discovery (including `.agents/skills`). Extra paths (`--skill`) still load.

### skills.sh / `npx skills add`

Install from inside cast — same command in the TUI and the web UI (**Settings
→ Skills.sh**):

```
/skills-sh search grill                       Find skills by keyword
/skills-sh list-available mattpocock/skills   What a repo offers
/skills-sh install mattpocock/skills --skill grill-me
/skills-sh uninstall grill-me
```

`install` also accepts a whole `npx skills add …` line pasted from the
skills.sh copy button, and a `https://github.com/owner/repo` URL. Cast always
installs into the **universal** scope, and drops an `-a <agent>` flag if you
pass one: that form installs only into that one agent's directory (e.g.
`.claude/skills`), which cast never scans, so the skill would silently never
appear. The catalog refreshes in the same session — no `/reload`.

Or run the CLI yourself:

```bash
npx -y skills add mattpocock/skills --skill grill-me
```

Either way the skill lands in `.agents/skills/` (project, trust-gated) or
`~/.agents/skills/` (global); cast also recognizes the compatible
`~/.config/agents/skills/` location. Installing by hand needs `/reload` (or a
restart) for cast to pick it up. Invoke with `/skill:grill-me` (not
`/grill-me`).

Settings → Skills.sh lists the skills whose provenance `npx skills`' own
lockfile (`~/.agents/.skill-lock.json`) records, with their source repo. A
skill you dropped into `.agents/skills/` yourself has no lockfile entry, so it
appears under Skills rather than Skills.sh — those directories are shared with
other tools, and the lockfile is the only thing that establishes where a skill
came from.

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
| `name` | No | Display name. Defaults to the containing directory's name, and need not match it |
| `description` | Recommended | What the skill does and when to use it. When omitted, the body's first paragraph is used |
| `license` | No | License name or a reference to a bundled license file |
| `compatibility` | No | Environment requirements; 1–500 characters |
| `metadata` | No | Mapping of string keys to string values for client-specific data |
| `allowed-tools` | No | Pre-approved tools, as a space- or comma-separated string **or** a YAML list. Cast retains and exposes the field with the skill but does not act on it: a third-party skill should not be able to waive cast's own bash/write confirmations. `disallowed-tools`, which only ever *removes* tools, is enforced |
| `disable-model-invocation` | No | Hide from the agent (manual `/skill:<name>` only). Accepts `true`/`yes`/`on`/`1` in any case, as the spec allows |
| `when_to_use` | No | Extra matching guidance shown to the model as `description — whenToUse` in the skill listing |
| `user-invocable` | No | `false` keeps the skill out of the slash menu — the model may load it, a person may not. Accepts the same boolean spellings |
| `argument-hint` | No | Autocomplete hint for the arguments the skill expects, e.g. `[issue-number]` |
| `hooks` | No | Hooks registered when the skill is invoked, in `hooks.json`'s shape expressed as YAML. They stay active for the rest of the run; a hook with `once: true` is dropped after it fires without blocking |
| `paths` | No | Globs limiting when the skill is offered — it is listed only while a file matching one of them is in context. Comma-separated string or a YAML list |
| `disallowed-tools` | No | Tools removed from the model's pool for the rest of the turn the skill is invoked in; cleared by your next message. Space- or comma-separated string, or a YAML list |
| `arguments` | No | Named positional arguments, as a space-separated string or a YAML list. `arguments: [issue, branch]` makes `$issue` the first argument and `$branch` the second |

### Name Rules

Per the Agent Skills spec:

- Lowercase letters, digits, and hyphens only (`[a-z0-9-]+`)
- Must not start or end with a hyphen
- Must not contain consecutive hyphens (`--`)
- Maximum 64 characters

A malformed `name`, an over-long `description` or `compatibility`, and invalid YAML prevent the skill from loading. A name that differs from its directory does not — the spec treats `name` as a display name. Cast warns when the body exceeds the spec's recommended 500 lines but still loads it. In the skill listing, `description` and `when_to_use` are combined and truncated at 1,536 characters, as the spec specifies.

### Hooks in a Skill

A skill can register hooks when it is invoked, using the same shape as
`hooks.json`:

```yaml
---
name: formatter
description: Keeps the tree formatted
hooks:
  PostToolUse:
    - matcher: "write|edit"
      hooks:
        - type: command
          command: npm run format
          once: true
---
```

They join the session's own hooks for the rest of the run and cover every
event cast supports. `once: true` removes the hook after it fires without
blocking — a blocked or failed run leaves it in place, so a gate keeps
gating.

### Inline Commands

A skill body may embed a shell command with `` !`command` ``; its output is
spliced in when the skill is invoked, so a body can report the environment it
is about to work in:

```markdown
Node: !`node --version 2>/dev/null || echo "not installed"`
```

These run for every skill, whatever its source — most of them only probe the
environment, and a skill can already tell the model to run anything in prose.
What a skill body must not be is a way *around* the checks a plain `bash` call
faces, so each command goes through the same two gates:

- In **plan mode** (and in a subagent of a plan-mode parent) only read-only
  commands run; anything that could write is reported in place, unrun.
- A command matching a **dangerous pattern** (`rm -rf`, `sudo`, force-push, …)
  needs the same confirmation the `bash` tool asks for. Without a confirmation
  callback it is refused rather than silently allowed.

Bounds: at most 10 commands per skill, 10s each, 2,000 characters of output
each. A failing or refused command is reported in place rather than left as
literal text.

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

`/skills uninstall` deletes a **global**, **project**, or **agents** (`.agents/skills`) skill from disk. Builtin and `--skill` paths are omitted.

### Hot-reload

`/skills` toggle / `enable` / `disable` / `uninstall` update the skill catalog **in the current session** — no `/reload`, no restart.

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
| `$<name>` | A named argument declared in `arguments` frontmatter |
| `$ARGUMENTS[0]`, `$ARGUMENTS[1]`, ... / `$0`, `$1`, ... | An individual argument (shell-quote-style parsing — quoted strings stay intact) |
| `${CLAUDE_SKILL_DIR}` | Absolute path to the skill's own directory, for resolving relative paths |
| `${CLAUDE_PROJECT_DIR}` (`${CAST_PROJECT_DIR}`) | The project root |
| `${CLAUDE_SESSION_ID}` (`${CAST_SESSION_ID}`) | The current session id |

If arguments are supplied but the skill body contains no `$ARGUMENTS` placeholder, they're appended as a trailing `User: <args>` line instead of being silently dropped. If the skill is invoked *without* arguments, every placeholder is replaced with an empty string — an unsubstituted `$ARGUMENTS` reaching the model reads as an instruction rather than as "there were none".

### The `skill` Tool

The agent invokes skills through a dedicated `skill` tool (`name`, optional `args`) rather than reading `SKILL.md` via the generic `read` tool. It validates the name, enforces `disable-model-invocation`, performs the substitution above, and returns the formatted skill content in one call.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--skill <directory>` | Load an extra skill package directory (repeatable) |
| `--no-skills` | Skip project/agents/global/builtin skill discovery |

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
