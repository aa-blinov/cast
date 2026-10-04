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
| `/permissions` | Change permission mode (`default` asks about dangerous commands, `bypass` asks about nothing); per-tool rules live in settings, see `references/settings.md` |
| `/web` | Toggle web tools (web_search, web_fetch) |
| `/ssh` | Manage SSH hosts (list, add, remove) |
| `/theme` | Change color theme |
| `/statusbar` | Toggle and reorder status bar segments |
| `/current` | All status bar data: model, context, tokens in/out with cache %, cost, sub-agent tokens |
| `/sessions` | List/switch sessions |
| `/continue` | Switch to the most recently updated other session |
| `/new` | Start a fresh session |
| `/fork [seq \| after <seq>]` | Fork the session into a new one: whole, from before one of the user's messages, or through one of the agent's final answers (`after`) |
| `/repo` | Show cwd's git status: branch, dirty flag, active worktree |
| `/plan` | User-initiated task initialization: establish scope and an execution plan before implementation |
| `/build` | Exit plan mode, approve the plan, and restore the implementation toolset |
| `/plan-note <text>` | Web: append a decision note to the active plan |
| `/goal [N] <description>` | Work autonomously toward a goal until done — bounded (default 25 model calls; a leading `N` or `--steps N` overrides), never-ask, at most one clarifying question |
| `/turn-cap [N\|reset]` | Show/set the per-turn iteration safety cap (default 500, applies next call) |
| `/review` | Ask the agent to verify its own work: git diff, run tests/lint, report honestly what was and wasn't verified |
| `/memory …` | Toggle memory read/write, tune checkpoint/dream/distill budgets and intervals, list or cancel background runs — see `references/memory.md` |
| `/dream` | Run memory dream maintenance now |
| `/distill` | Run memory distill maintenance now |
| `/rewind [<seq> [both\|conversation\|code] [--force]]` | Rewind to before a chosen message: files and conversation, files only, or conversation only; the TUI asks with pickers, the web with a dialog on a message's Rewind button |
| `/undo [--force]` | Undo the last turn: restore the folder to how it was before it (git checkpoint, or a hidden snapshot outside git; shell changes are not undone in a folder over 3000 files or 50MB) and remove that turn from the conversation. Asks first when it would delete files created since; `--force` skips the question |
| `/worktree <name>\|list\|remove <name>` | Create/reuse, list, or remove a git worktree for this session (the agent can also enter one itself with its `worktree` tool) |
| `/evolve` | Let the agent propose/update its own skills based on session experience |
| `/hooks [enable\|disable <id>]` | List hooks for this project, or enable/disable one by id |
| `/agents` | This session's subagents: open one's session, or stop a running one |
| `/init [focus]` | Write or refresh AGENTS.md from the tracked files of the repository (a turn) |
| `/commit [hint]` | Commit the current changes: explicit paths, secrets left out, no push (a turn) |
| `/cost` | What the session has spent, by kind of request |
| `/export` | Save the conversation as Markdown in `~/.cast/exports/` |
| `/doctor` | Check the provider, the model, git, ripgrep, the database and MCP servers |
| `/context` | List the loaded AGENTS.md / CLAUDE.md context files |
| `/steer <message>` (`/s`) | Inject a message while the agent is running |
| `/btw <question>` | Ask a side question: answered from the conversation with no tools, kept out of it (not saved, no steering); works while a turn runs |
| `/running-input [steer\|queue]` | What a plain message typed during a turn does: steer it (default) or queue it for after; `/steer` and `/queue` always work |
| `/queue <message>` (`/q`) | Queue a message for after the agent stops |
| `/queue-remove <n>` | Remove one queued message by its number in the Queued list |
| `/queue-reset` (`/qr`) | Clear the message queue |
| `/reasoning` | Change reasoning level |
| `/reasoning-format` | Change how reasoning is rendered |
| `/reasoning-display` (`/rd`) | Show/toggle reasoning display |
| `/model-selection` | Web: interactive model picker |
| `/quick-session-persona [name]` | Web: show or change the persona the sidebar's Quick session button uses |
| `/web-search-provider [name]` | Show/change the web_search backend |
| `/web-fetch-provider [name]` | Show/change the web_fetch backend |
| `/usage` | Web: cumulative token/cost usage for this session (TUI: `/current`) |
| `/keys` | Show keyboard shortcuts in effect, including `keybindings` overrides |
| `/lsp` | Show running language servers and why others are off |
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
| `mcp.json` written by your `write`/`edit` tools; skills from `skill_install` | automatic |
| Other new/edited files under `.cast/` / `~/.cast/` / `.agents/` (skills, personas, rules, mcp.json by hand) | `/reload` (same session) |
