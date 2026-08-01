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
| `/plan` | User-initiated task initialization: establish scope and an execution plan before implementation |
| `/build` | Exit plan mode, approve the plan, and restore the implementation toolset |
| `/clear` | Clear context |
| `/compact` | Compact context now |
| `/abort` | Abort running agent |

## Applying Changes

Never quit cast for these — the chat continues either way.

| Change | How to apply |
|--------|----------------|
| `/skills` / `/mcp` / `/plugin` toggle, enable/disable, uninstall | automatic (hot-reload) |
| `/plugin install` / marketplace remove | automatic (skills reload) |
| New/edited files under `.cast/` / `~/.cast/` / `.agents/` (skills, personas, rules, mcp.json) | `/reload` (same session) |
