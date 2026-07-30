---
name: cast
label: cast
description: Configure cast itself — personas, skills, marketplace plugins, MCP servers, or rules. Use when the user wants to customize cast or install plugins from Codex/Claude/Grok catalogs.
---

# cast configuration

cast stores user config under `~/.cast/` (global) and `<cwd>/.cast/` (project-local).

- Slash toggles/install/uninstall for `/skills`, `/mcp`, `/plugin`: hot-reload in the same session — no `/reload`, no restart.
- File drops/edits (skills, personas, rules, mcp.json, `npx skills add`): `/reload` in the same session (does not reset chat).

## Personas

Personas are system prompts that give the agent a different role. Active persona's full body becomes the system prompt.

**Locations** (highest priority first):

1. `.cast/personas/*.md` — project (trust-gated)
2. `~/.cast/personas/*.md` — global
3. Shipped with cast — builtin

**File format** — frontmatter + markdown body:

```markdown
---
name: my-persona
label: My Persona
description: Short description shown in the picker.
subagents: false
subagentTypes: [explore, review]
tools: [read, grep, ls, plan_*, web_*]
skills: [research, deep-research]
mcp: [postgres, playwright*]
agentsMd: true
---

You are a specialized assistant that...

(Your full system prompt instructions here.)
```

**Rules:**

- `name` must be non-empty (used to select persona via `--persona <name>`)
- `label` is shown in `/persona` picker and `/personas` list; defaults to `name` if omitted
- `description` is shown in the picker
- `subagents: true` enables the `task` tool (default `false`)
- `agentsMd` — inject `AGENTS.md` / `CLAUDE.md` (default `true`; set `false` to skip)
- The body (after frontmatter) becomes the system prompt — `## Error Handling` section is appended automatically
- On name collision, project > global > builtin

**Isolation knobs** — everything below is optional and follows the same allowlist shape: omit the field = no restriction (everything available); set it = only listed names (exact, or `*`-globs like `plan_*` / `postgres*`) are usable; `[]` = explicitly nothing. Enforced at runtime (a disallowed call is rejected, not just hidden from the prompt text), so these actually isolate a persona's zone of responsibility rather than just suggesting one:

- `tools` — allowlist of **built-in** tool names. `tools: [read, grep, ls, plan_*, web_*]` → this persona can't `bash`/`edit`/`write` at all.
- `skills` — allowlist of skill names this persona may invoke via the `skill` tool. Also applies to anything it delegates to via `task`, so the restriction can't be routed around by spawning a subagent.
- `mcp` — allowlist of MCP **server** names (not individual tool names — `mcp: [postgres]` covers every tool that server exposes). Omit = every connected server stays available.
- `subagentTypes` — narrows `subagents: true` further: which subagent roles (by name — `explore`/`review`/`worker`, or any custom ones from `~/.cast/subagents/`) this persona may spawn via `task`. Has no effect if `subagents` isn't `true`.

Example — a research-only persona that can look things up and hand off exploration, but can't touch the database or edit code itself:

```yaml
subagents: true
subagentTypes: [explore]
tools: [read, grep, glob, ls, web_search, web_fetch, skill]
skills: [research, deep-research]
mcp: [playwright]
```

**Example — create a persona:**

```bash
mkdir -p ~/.cast/personas
cat > ~/.cast/personas/analyst.md << 'EOF'
---
name: analyst
label: Data Analyst
description: Specialized in data analysis, SQL, and visualization.
---

You are an experienced data analyst operating inside a coding agent harness. You help the user explore data, write queries, and build visualizations — turning raw numbers into clear, actionable insights.

## Tools

You have the same tools as a coding agent, repurposed for data work:

- **read**: Inspect data files, SQL scripts, CSVs, and notebooks before drawing conclusions — never assume what the data looks like.
- **bash**: Run queries (sqlite3, psql, mysql), execute Python/R scripts, generate charts with matplotlib or ggplot.
- **grep**: Search logs, SQL files, and existing analyses for patterns, column names, or prior queries.
- **glob**: Locate data files, existing reports, or dashboards by name.
- **write**: Draft new SQL scripts, analysis notebooks, or report summaries.
- **edit**: Refine existing queries, fix broken joins, update WHERE clauses.
- **ls**: Survey what data files and existing analyses are available.

## Working style

- Always inspect the data (schema, sample rows, row counts) before writing queries — never guess column names or types.
- Explain your reasoning step by step: what you're querying, why that filter or join makes sense, what the result means.
- Suggest optimizations when queries are slow (indexes, EXPLAIN plans, denormalization).
- Present results in a clear format: tables for data, bullet points for takeaways, charts when trends matter.
- If the data is ambiguous or incomplete, say so — don't fill gaps with assumptions.
EOF
```

## Skills

Skills are reusable instruction files the model can read on demand.

**Locations** (highest priority first — on name collision, first-loaded wins):

1. `.cast/skills/` — project (trust-gated)
2. `.agents/skills/` — skills.sh universal project path (trust-gated)
3. `~/.cast/skills/` — global
4. `~/.config/agents/skills/` / `~/.agents/skills/` — skills.sh universal global
5. Enabled marketplace plugins (`/plugin install`) — `source: plugin`
6. Shipped with cast — builtin
7. `--skill <path>` — extra CLI paths (still load with `--no-skills`)

`--no-skills` skips project, agents, global, plugin, and builtin discovery.

`npx skills add owner/repo --skill name -a universal` → `.agents/skills/`; invoke with `/skill:name`.

**File format** — a directory with `SKILL.md`:

```
.cast/skills/my-skill/SKILL.md
```

```markdown
---
name: my-skill
description: What this skill does. Shown to the model in the available skills list.
disable-model-invocation: true
---

# My Skill

Instructions the model reads when this skill is invoked...

(Relative paths inside the skill directory resolve against it.)
```

**Rules:**

- `name` must be lowercase, alphanumeric + hyphens
- `description` is required (shown to the model)
- `disable-model-invocation: true` — skill is hidden from model, only usable via `/skill:name`
- `/skills` — multi-select toggle; also `list`, `enable`/`disable <name>`, `uninstall`, `help`
- `/skills uninstall` — delete cast/agents skill from disk (picker or name + confirm); plugin skills show locked → `/plugin uninstall`
- Plugin skills are labeled `plugin · name@marketplace`; if the pack is off, they stay visible but locked until `/plugin` re-enables the pack
- On name collision: `.cast` project > `.agents` project > `.cast` global > `.agents` global > plugin > builtin

**Example — create a skill:**

```bash
mkdir -p ~/.cast/skills/git-workflow
cat > ~/.cast/skills/git-workflow/SKILL.md << 'EOF'
---
name: git-workflow
description: Branch naming, commit messages, and PR conventions for this repo.
---

# Git Workflow

- Branch naming: `feat/<ticket>-<short-desc>`, `fix/<ticket>-<short-desc>`
- Commit format: `<type>(<scope>): <summary>`
- Always squash-merge PRs
EOF
```

## Marketplace plugins

Plugins are installable packs (usually skills) from catalogs — same `name@marketplace` shape as Claude Code / Grok Build. MVP loads **skills** from plugins only (not MCP/hooks inside the pack).

**Defaults** (seeded once on first `/plugin` / marketplace / install):

| Label | Source repo | Typical marketplace name |
|-------|-------------|--------------------------|
| Codex | `openai/plugins` | `openai-curated` |
| Claude | `anthropics/claude-plugins-official` | `claude-plugins-official` |
| Grok | `xai-org/plugin-marketplace` | `xai-official` |

**Commands** — type `/plugin` in the composer; the palette lists every subcommand:

```
/plugin                              # toggle installed plugins
/plugin list
/plugin marketplace list             # catalogs
/plugin marketplace list xai-official
/plugin install superpowers@xai-official
/plugin uninstall                    # picker + confirm
/plugin enable|disable NAME@SHOP
/skills list                         # catalog after install
/skills                              # toggle
```

Install hot-reloads the skill catalog. Prefer plugins that ship a `skills/` directory (packs with only `commands/` / `agents/` contribute nothing in cast yet). Disabling a pack via `/plugin` locks its skills in `/skills` (muted) until the pack is on again.

Layout: `~/.cast/plugins/` (marketplaces, installs, `known_marketplaces.json`). State: `enabledPlugins` in `settings.json`.

## MCP Servers

MCP (Model Context Protocol) servers provide external tools.

**Locations** (on name collision, last-loaded wins — reverse of skills/personas):

1. `~/.cast/mcp.json` — global
2. `.cast/mcp.json` — project (trust-gated)
3. `--mcp <path>` — extra CLI paths (loaded last, highest priority)

Global servers load first, project and CLI override them on name collision.

**File format** — common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "..." },
      "cwd": "/optional/working/dir"
    },
    "remote-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

**Transports:** stdio (local process — `command`+`args`+`env`+`cwd`) and streamable HTTP (remote — `url`+`headers`, static-header auth only, no OAuth).

**Tool names** are namespaced as `mcp_<server>_<tool>` to avoid collisions.

Same command shape as skills: `/mcp` toggle, `list`, `enable`/`disable <name>`, `uninstall` (confirm), `help`. Disabled servers persist in `disabledMcpServers`. Only enabled servers appear in `<available_mcp>`.

`/mcp uninstall` removes a server from global or project `mcp.json`. CLI `--mcp` paths are not removable here.

## Rules

Cursor-compatible rule files (not a single `rules.md`):

1. `~/.cast/rules/*.md` — global
2. `.cast/rules/*.md` — project (trust-gated)
3. Nested `.cast/rules/*.md` in subdirectories (up to 8 levels) — scoped to subtree

**Four apply modes** (from frontmatter):

| Mode | Frontmatter | Behavior |
|------|-------------|----------|
| always | `always-apply: true` | Injected every turn (globs ignored) |
| auto | `always-apply: false` + `globs` | Auto-attach when matching files enter context; sticky |
| lazy | `always-apply: false` + `description` | Model decides relevance, reads via read tool |
| manual | `always-apply: false` (no globs, no description) | Only via `@rule-name` or `/rule:<name>` |

**Commands:** `/rules` (list), `/rule:<name>` (force-load), `@rule-name` (mention in message).

**Example:**

```bash
mkdir -p .cast/rules
cat > .cast/rules/typescript.md << 'EOF'
---
always-apply: false
globs: ["*.ts", "*.tsx"]
---

Use strict TypeScript; prefer unknown over any.
EOF
```

Then `/reload`.

## Commands Reference

| Command | Description |
|---------|-------------|
| `/skills` | Toggle / list / enable\|disable / uninstall skills |
| `/mcp` | Toggle / list / enable\|disable / uninstall MCP servers |
| `/plugin` | Plugins palette (install / marketplace / toggle) |
| `/rule:<name>` | Invoke a rule by name |
| `/rules` | List loaded rules |
| `/skill:<name>` | Invoke a skill |
| `/reload` | Re-scan skills, MCP, rules, personas |
| `/model [name]` | Show/change model |
| `/subagent-model [name]` | Show/change subagent model |
| `/subagent-model-provider [name]` | Set provider for subagent model |
| `/plan-model [name\|off]` | Show/change plan-mode model |
| `/plan-model-provider [name]` | Set provider for plan-mode model |
| `/persona [name]` | Show/change persona |
| `/provider [name]` | Switch / add / delete providers |
| `/permissions` | Change bash confirmation mode |
| `/web` | Toggle web tools (web_search, web_fetch) |
| `/ssh` | Manage SSH hosts (list, add, remove) |
| `/theme` | Change color theme |
| `/statusbar` | Toggle and reorder status bar segments |
| `/usage` | Show session token/cost usage |
| `/sessions` | List/switch sessions |
| `/plan` | Enter plan mode |
| `/build` | Exit plan mode, restore full toolset |
| `/clear` | Clear context |
| `/compact` | Compact context now |
| `/abort` | Abort running agent |

## Hooks

Hooks are shell commands, HTTP callbacks, MCP tool calls, or model prompts that fire at agent lifecycle events. Config shape matches Claude Code's protocol — real `hooks.json` files from Claude Code plugins load unmodified.

**Locations** (merged, all apply):

1. `~/.cast/hooks.json` — global, always applies
2. `.cast/hooks.json` — project (trust-gated, same as mcp.json)
3. `<plugin root>/hooks/hooks.json` — plugin-contributed (auto-merged on install)

**File format:**

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "command": "scripts/check.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Write|Edit", "hooks": [{ "command": "scripts/lint.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "scripts/verify.sh", "timeout": 300 }] }
    ]
  }
}
```

A bare `{ "PreToolUse": [...] }` (no wrapping `"hooks"` key) works too. Unrecognized event names are skipped, so a hooks file shared with another tool still loads.

**Key events:**

| Event | Fires | Can block? |
|-------|-------|-----------|
| `SessionStart` | Session starts | No |
| `UserPromptSubmit` | User submits a prompt | Yes |
| `PreToolUse` | Before tool runs | Yes — can deny or rewrite args |
| `PostToolUse` | After tool succeeds | No (can rewrite result) |
| `PermissionRequest` | Bash confirmation dialog | Yes — can approve/deny |
| `Stop` | Agent would end turn | Yes — can keep it going |
| `SubagentStart`/`SubagentStop` | Subagent lifecycle | No |
| `PreCompact`/`PostCompact` | Context compaction | No |

**Hook types:** `command` (shell, default), `http` (POST), `mcp_tool` (call MCP tool), `prompt` (one-shot model completion with `{"ok":true/false}` output).

**Response contract:** exit 2 or `{"decision":"block"}` blocks. `{"hookSpecificOutput":{"updatedInput":{...}}}` rewrites tool args. `{"hookSpecificOutput":{"additionalContext":"..."}}` appends context without blocking. `{"continue":false}` force-stops the turn.

**Matcher:** regex tested against tool name (for tool events), subagent name (for SubagentStart/Stop), or ignored for events with no natural target. Case-insensitive. Supports pipe-separated exact matches (`Write|Edit`).

**Env vars** (command hooks): `CAST_HOOK_EVENT`, `CAST_SESSION_ID`, `CAST_WORKSPACE_ROOT`, `CAST_PLUGIN_ROOT`/`CAST_PLUGIN_DATA` (plugin hooks only). Reserved keys in hook's own `env` field are stripped.

**Commands:**

```
/hooks                           # list all hooks with stable ids
/hooks enable <id>               # enable a hook
/hooks disable <id>              # disable a hook
/hooks help                      # cheat sheet
```

State persists in `~/.cast/settings.json` (`disabledHooks`). Takes effect on the next message, no restart.

**Example — create a hook:**

```bash
mkdir -p ~/.cast
cat > ~/.cast/hooks.json << 'EOF'
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "bash", "hooks": [{ "command": "echo 'Checking: $CAST_HOOK_EVENT' 1>&2" }] }
    ],
    "Stop": [
      { "hooks": [{ "command": "echo 'Turn ending'" }] }
    ]
  }
}
EOF
```

Full documentation: `docs/hooks.md`.

## Applying Changes

Never quit cast for these — the chat continues either way.

| Change | How to apply |
|--------|----------------|
| `/skills` / `/mcp` / `/plugin` toggle, enable/disable, uninstall | automatic (hot-reload) |
| `/plugin install` / marketplace remove | automatic (skills reload) |
| New/edited files under `.cast/` / `~/.cast/` / `.agents/` (skills, personas, rules, mcp.json) | `/reload` (same session) |
