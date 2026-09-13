## Commands Reference

| Command | Description |
|---------|-------------|
| `/skills` | Toggle / list / enable\|disable / uninstall skills |
| `/skills-sh` | skills.sh — search / list-available / install / uninstall |
| `/mcp` | Toggle / list / enable\|disable / uninstall MCP servers |
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
| `/current` | All status bar data: model, context, tokens in/out with cache %, cost, sub-agent tokens |
| `/sessions` | List/switch sessions |
| `/continue` | Switch to the most recently updated other session |
| `/new` | Start a fresh session |
| `/fork` | Fork the current session into a new one |
| `/repo` | Show cwd's git status: branch, dirty flag, active worktree |
| `/plan` | User-initiated task initialization: establish scope and an execution plan before implementation |
| `/build` | Exit plan mode, approve the plan, and restore the implementation toolset |
| `/plan-note <text>` | Append a decision note to the active plan |
| `/goal [N] <description>` | Work autonomously toward a goal until done — bounded (default 25 model calls; a leading `N` or `--steps N` overrides), never-ask, at most one clarifying question |
| `/turn-cap [N\|reset]` | Show/set the per-turn iteration safety cap (default 500, applies next call) |
| `/review` | Ask the agent to verify its own work: git diff, run tests/lint, report honestly what was and wasn't verified |
| `/memory …` | Toggle memory read/write, tune checkpoint/dream/distill budgets and intervals, list or cancel background runs — see `references/memory.md` |
| `/dream` | Run memory dream maintenance now |
| `/distill` | Run memory distill maintenance now |
| `/undo [--force]` | Restore the last checkpoint (git-based); `--force` also discards files created since it |
| `/worktree <name>\|list\|remove <name>` | Create/reuse, list, or remove a git worktree for this session |
| `/evolve` | Let the agent propose/update its own skills based on session experience |
| `/hooks [enable\|disable <id>]` | List hooks for this project, or enable/disable one by id |
| `/steer <message>` (`/s`) | Inject a message while the agent is running |
| `/queue <message>` (`/q`) | Queue a message for after the agent stops |
| `/queue-reset` (`/qr`) | Clear the message queue |
| `/reasoning` | Change reasoning level |
| `/reasoning-format` | Change how reasoning is rendered |
| `/reasoning-display` (`/rd`) | Show/toggle reasoning display |
| `/model-selection` | Interactive model picker |
| `/quick-session-persona [name]` | Set a one-off persona for this session only (doesn't change the default) |
| `/web-search-provider [name]` | Show/change the web_search backend |
| `/web-fetch-provider [name]` | Show/change the web_fetch backend |
| `/usage` | Show cumulative token/cost usage for this session |
| `/keys` | Show keyboard shortcuts |
| `/older` | Load an older page of scrollback history |
| `/copy` | Copy the last assistant message to the clipboard |
| `/help` | Show help |
| `/clear` | Clear context |
| `/compact` | Compact context now |
| `/abort` (`/stop`) | Abort running agent |
| `/quit` (`/exit`) | Save and exit |

## Applying Changes

Never quit cast for these — the chat continues either way.

| Change | How to apply |
|--------|----------------|
| `/skills` / `/mcp` toggle, enable/disable, uninstall | automatic (hot-reload) |
| New/edited files under `.cast/` / `~/.cast/` / `.agents/` (skills, personas, rules, mcp.json) | `/reload` (same session) |
