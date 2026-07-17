# Plugins & Marketplaces

Install reusable skill packs from catalogs — same `name@marketplace` shape as Claude Code / Grok Build.

MVP scope: plugins contribute **skills** (loaded into the agent catalog). MCP/hooks/agents inside plugins are not wired yet.

## Quick start

On the first `/plugin` (or marketplace/install) cast seeds three default catalogs when missing:

| Label | Source |
|-------|--------|
| Codex | `openai/plugins` |
| Claude | `anthropics/claude-plugins-official` |
| Grok | `xai-org/plugin-marketplace` |

Then:

```
/plugin marketplace list
/plugin marketplace list xai-official
/plugin install superpowers@xai-official
/skills
```

Or a local catalog (for testing / private plugins):

```
/plugin marketplace add ./my-marketplace
/plugin install ponytail@ponytail
```

Seed runs once (`~/.cast/plugins/defaults-seeded.json`). Removed defaults are not re-added; failed clones (offline) retry until at least one succeeds.

## Hot-reload

`/plugin install`, `uninstall`, `enable` / `disable`, bare `/plugin` toggle, and `marketplace remove` reload the skill catalog **in the current session**. No `/reload` and no new session.

`/reload` is only for skills/rules/MCP/personas you added or edited as files outside these commands. See [Interactive commands](interactive-commands.md#hot-reload-vs-reload).

## Commands

Type `/plugin` in the composer — the palette lists every subcommand (install, marketplace list, …) with a short hint. Pick a row, then fill args if needed.

| Command | What it does |
|---------|----------------|
| `/plugin` | Toggle installed plugins on/off (same picker UX as `/mcp` / `/skills`) |
| `/plugin install <name>@<marketplace>` | Fetch plugin, enable it, reload skills |
| `/plugin uninstall` | Interactive: pick installed plugin, confirm, remove |
| `/plugin uninstall <name>@<marketplace>` | Remove by ref (no picker) |
| `/plugin enable` / `disable <name>@<marketplace>` | Toggle one plugin without the picker |
| `/plugin list` | Installed plugins (text list) |
| `/plugin marketplace add <owner/repo\|url\|path>` | Register a catalog |
| `/plugin marketplace list [name]` | Known catalogs, or plugins in one |
| `/plugin marketplace update <name>` | `git pull` / refresh checkout |
| `/plugin marketplace remove <name>` | Drop catalog, installs, `enabledPlugins` keys; reload skills |

## Layout on disk

```
~/.cast/plugins/
  known_marketplaces.json
  installed.json
  marketplaces/<name>/          # catalog checkout
  installs/<marketplace>/<plugin>/
```

Enabled state is stored in `~/.cast/settings.json` under `enabledPlugins` (`"name@marketplace": true|false`).

## Marketplace format

Cast reads any of:

- `.cast-plugin/marketplace.json`
- `.grok-plugin/marketplace.json`
- `.claude-plugin/marketplace.json`

Compatible with Grok/Claude entries: relative `./plugins/foo`, `{ "source": "url", "url", "sha", "path" }`, `{ "source": "git-subdir", … }`, `{ "type": "local", "path" }`.

## Skill discovery from a plugin

1. If `<pluginRoot>/skills/` exists → load that directory  
2. Else → load `<pluginRoot>` itself (skill-only repos)

Priority vs other skills: project > global > **plugin** > builtin > `--skill` paths.

A pack may contribute several skills; each is labeled with `plugin · name@marketplace` in `/skills`. Disabling a pack with `/plugin` keeps those skills visible but locked until the pack is re-enabled — they leave the agent catalog immediately.

On a name collision between two enabled plugins, the first id in sorted `name@marketplace` order wins.

`--no-skills` skips plugin skill dirs as well (same as project/global/builtin); `--skill` paths still load.
