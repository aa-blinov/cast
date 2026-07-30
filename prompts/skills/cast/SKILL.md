---
name: cast
label: cast
description: Configure cast itself — personas, skills, marketplace plugins, MCP servers, or rules. Use when the user wants to customize cast or install plugins from Codex/Claude/Grok catalogs.
---

# cast configuration

cast stores user config under `~/.cast/` (global) and `<cwd>/.cast/` (project-local).

- Slash toggles/install/uninstall for `/skills`, `/mcp`, `/plugin`: hot-reload in the same session — no `/reload`, no restart.
- File drops/edits (skills, personas, rules, mcp.json, `npx skills add`): `/reload` in the same session (does not reset chat).

This skill ships as an **index + reference files**. Read only what the task needs — the table below tells you which file covers which topic.

## Topic map

| Topic | Read |
|-------|------|
| Personas — locations, frontmatter, isolation knobs, example | `references/personas.md` |
| Skills — locations, format, discovery order, example | `references/skills.md` |
| Marketplace plugins — catalogs, `/plugin` flow, state | `references/marketplace.md` |
| MCP servers — `mcp.json` shape, transports, commands | `references/mcp.md` |
| Rules — apply modes, globs, `@rule-name` vs `/rule:` | `references/rules.md` |
| Hooks — `hooks.json` shape, events, matchers, env vars | `references/hooks.md` |
| Slash commands — full table, hot-reload vs `/reload` | `references/commands.md` |

When the user asks for a specific concern ("how do I add an MCP server?", "where do personas live?"), open the matching reference file. For multi-topic requests ("install a plugin from a non-default marketplace that exposes a custom hook"), follow the references in order.
