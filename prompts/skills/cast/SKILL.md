---
name: cast
description: Configure cast itself — create and manage personas, skills, marketplace plugins, MCP servers, or rules. Use when the user wants to customize cast, create a persona through chat, or install plugins from Codex/Claude/Grok catalogs.
---

# cast configuration

cast stores user config under `~/.cast/` (global) and `<cwd>/.cast/` (project-local).

- Slash toggles/install/uninstall for `/skills`, `/mcp`, `/plugin`: hot-reload in the same session — no `/reload`, no restart.
- File drops/edits (skills, personas, rules, mcp.json, `npx skills add`): `/reload` in the same session (does not reset chat).

## Plan mode

Plan mode is a user-owned task-initialization phase, not an automatic agent workflow. The user enters it with `/plan` when they want to establish scope, resolve substantive choices, and save an execution plan before product changes. The agent never switches from Build to Plan on its own and continues a Build task directly unless the user explicitly enables Plan mode. `/build` exits planning and restores implementation tools.

The agent can use `question` in either mode when it needs a user decision. One call can contain up to five questions, each with two to four options; the interface collects the choices and resumes the same conversation.

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
| Providers and model slots — OpenAI-compatible endpoint, reasoning, validation | `references/providers.md` |
| Web access — local/public server, login, SSH tunnel, security boundary | `references/web.md` |
| Project configuration — `.cast/` layout, trust, git policy, reload | `references/project-config.md` |

When the user asks for a specific concern ("how do I add an MCP server?", "where do personas live?"), open the matching reference file. For multi-topic requests ("install a plugin from a non-default marketplace that exposes a custom hook"), follow the references in order.
