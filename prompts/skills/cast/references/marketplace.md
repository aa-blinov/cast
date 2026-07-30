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
