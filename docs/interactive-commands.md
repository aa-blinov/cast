# Interactive Commands

All commands are typed at the TUI prompt, prefixed with `/`. Unknown slash commands are submitted to the agent as regular text (useful for paths starting with `/`).

## Session Management

| Command | Description |
|---------|-------------|
| `/new` | Start a new session (autosaves current if non-empty) |
| `/continue` | Resume the most recent session (like `cast -c`, but mid-session) |
| `/fork` | Branch into a new session: the whole current context, the conversation before one of your messages, or (web UI, `/fork after <seq>`) through one of the agent's answers |
| `/worktree <name>` | Switch current session into an isolated git worktree (`list`, `remove <name>`) |
| `/sessions` | Session picker: the sessions of the directory you are in, with **Show all sessions** one row down (and **Only this directory** to come back). Type-to-filter search (message text, project path, id) stays inside the scope you are in; switch or delete. A session with no messages is not listed |
| `/clear` | Clear conversation context (and save the cleared state) |
| `/compact` | Force context compaction now (auto-triggers near the limit) |
| `/dream` | Verify the recent project trajectory and consolidate durable project memory |
| `/distill` | Verify repeated work and package high-confidence workflows as a skill or persona |
| `/rewind` | Rewind to before a chosen message: the files, the conversation, or both (any turn, not only the last) |
| `/undo [--force]` | Undo the last turn: put the files back as they were before it and remove your last message and everything after it, from the conversation and from the saved history |
| `/copy` | Copy last assistant response to clipboard |
| `/current` | Show all status bar data (even disabled segments) |
| `/quit`, `/exit` | Save and exit |

`/undo` takes back the last turn: the files and the conversation together. Cast takes a checkpoint of the working directory when each turn starts, and `/undo` restores the newest one, then removes your message that started the turn and everything after it. It stays gone after a page reload or a restart. Run it again to step back another turn. It is refused while the agent is running (use `/abort` first) and does nothing if there is no checkpoint.

What is restored depends on the folder:

| Folder | What comes back |
|--------|-----------------|
| A Git repository | Every tracked and untracked file, as of the start of the turn, without touching your Git index. Files git ignores (`.env`, build output) that the agent changed with `edit` or `write`, and files it wrote outside the session's folder, are restored too. Each checkpoint is pinned by a ref under `refs/cast/checkpoints/`, so `git gc` cannot collect it, and the ref is released when the checkpoint is restored or the session is deleted. |
| Not a repository, and small (up to 3000 files and 50MB; dependency and build folders like `node_modules` and `dist` are not counted) | Everything, including what shell commands changed, created or deleted. Cast commits the folder each turn to a hidden repository under `~/.cast/shadow/`, which is deleted with the session. `node_modules`, `dist` and similar folders are left alone. Sandbox sessions are this case. |
| Not a repository, and bigger, the home directory, or `/` | Only the files the agent changed with `edit` and `write`. `/undo` says that changes made by shell commands are not undone. |

Removing files created during the turn also removes any *you* created in that window: the restore cannot tell them apart, and they cannot be brought back. When there are such files, `/undo` names them and asks before proceeding. In the web UI a dialog lists them; over the API `/undo` refuses and asks you to re-run as `/undo --force`, which skips the question.

In the web UI a typed `/undo` opens a dialog that says which message goes, how the files are restored, and what will be deleted, then asks before doing anything. `GET /api/v1/sessions/{id}/undo` returns the same preview for your own client. To go back further than the last turn, use `/rewind`.

### Rewind

`/rewind` takes any turn back, not only the last. Every turn records a snapshot of the folder when it starts and the message it started with, so you pick a message and what goes back:

| Choice | What happens |
|--------|--------------|
| **Files and conversation** | The files go back as they were before that message, and the message and everything after it (every later turn) is removed from the conversation and the saved history. Later turns' snapshots are dropped with them. |
| **Files only** | The files go back; the conversation and every snapshot stay, so you can rewind the files forward to a later turn again. |
| **Conversation only** | The message and everything after it is removed; the files stay as they are. |

The files part restores the same way `/undo` does (see the table above), including its warning about files created since: they are named and you are asked first (`--force` skips the question). A message that compaction has taken out of the conversation the model sees can only be rewound for the files. Sessions from before this feature recorded no snapshots per message; they have `/undo` only.

In the TUI, `/rewind` shows a picker of your messages (newest first) and then of what goes back. In the web UI every such message has a **Rewind** button under its label (hover it; always visible on touch screens) that opens the same choice in a dialog. The command takes `/rewind <message seq> [both|conversation|code] [--force]`, and over the API `GET /api/v1/sessions/{id}/rewind-points` lists the messages, `GET .../rewind?userSeq=` previews, and `POST .../rewind` does it.

`/fork` leaves the original session unchanged and starts an independent new session. It asks where from: the whole session (the context currently sent to the model), or before any message you sent (the original conversation up to there, including what compaction had summarized). In the web UI you can also fork through an answer that ends a turn (**Fork from here** under it), which keeps that answer; the TUI picker has a row for it too. Forking from an earlier point asks whether the fork gets its own copy of the files as they were then (a worktree or a snapshot copy); see [Sessions](sessions.md). It does not copy checkpoints or pending pickers, or create a Git worktree: both sessions use the same working directory unless you switch one with `/worktree`.

The `/` palette lists the actions. The commands that only change a setting are left out of it because `/settings` opens each one; typed in full they work as before, for example `/model gpt-x` or `/turn-cap 800`.

## Model and Provider

| Command | Description |
|---------|-------------|
| `/model` | Open model picker (shows current model) |
| `/model <name>` | Switch to a specific model (validated) |
| `/agents` | This session's sub-agents (also while a turn runs): watch one live, or stop a running one |
| `/subagent-model` | Open model picker for sub-agents |
| `/subagent-model <name>` | Switch sub-agent model |
| `/subagent-model-provider [name\|off]` | Show/change the saved provider used for the sub-agent model |
| `/plan-model [name\|off]` | Show/change the model used in plan mode |
| `/plan-model-provider [name\|off]` | Show/change the saved provider used for the plan model |
| `/reasoning` | Change reasoning level (opens picker if model supports it) |
| `/reasoning-display` (`/rd`) | Toggle reasoning blocks in the transcript. Off by default since reasoning models stream a lot of auxiliary thinking that clutters the chat |
| `/reasoning-format` | Select the reasoning request protocol for the active provider |
| `/provider` | Open provider picker (switch, add, or delete providers) |
| `/provider add` | Add a new provider (name → URL → key wizard) |
| `/provider delete` | Delete a provider |
| `/provider <name>` | Switch to a named provider |

## Persona

| Command | Description |
|---------|-------------|
| `/persona` | Open persona picker |
| `/persona <name>` | Switch to a specific persona |

See [Personas](personas.md) for the full list.

## Skills and MCP

| Command | Description |
|---------|-------------|
| `/skills` | Toggle skills on/off (multi-select). Also: `list`, `enable`/`disable`, `uninstall`, `sources` (turn whole sources on/off), `help` |
| `/skills-sh` | skills.sh: search / list-available / install / uninstall universal skills |
| `/skill:<name> [args]` | Force-load and run a skill by name |
| `/mcp` | Toggle MCP servers on/off. Also: `list`, `enable`/`disable`, `uninstall`, `help` |
| `/hooks` | List lifecycle hooks; also `enable`/`disable <id>` and `help` |
| `/reload` | Re-scan skills, rules, MCP servers, personas, and context files for cwd |

Bare `/skills` / `/mcp` = multi-select toggle. `list` is read-only. `uninstall` always confirms (picker or typed). See [Skills](skills.md) and [MCP](mcp-servers.md).

### Hot-reload vs `/reload`

You never need to quit cast or start a new session for these changes. The current chat continues.

| Change | Apply how |
|--------|-----------|
| `/skills` / `/mcp` toggle, `enable` / `disable` | Automatic (hot-reload) |
| `/skills uninstall`, `/mcp uninstall` | Automatic |
| New/edited files on disk: skills, `mcp.json`, rules, personas, context files (including `npx skills add`) | `/reload` refreshes the current resource catalog; persona overrides created in chat are picked up automatically on the next user message |

`/reload` only re-scans cwd resources. It does **not** reset the conversation.

## Rules

| Command | Description |
|---------|-------------|
| `/rules` | List loaded rules with their apply mode, globs, and scope |
| `/rule:<name>` | Invoke a rule by name (loads its full content into context) |

See [Rules](rules.md) for rule types and creation.

## Plan Mode

| Command | Description |
|---------|-------------|
| `/plan` | Enter plan mode (explore and plan only, no code changes) |
| `/build` | Exit plan mode, restore full toolset |
| `/plan-model [name\|off]` | Show/change the model used while plan mode is active |

See [Plan Mode](plan-mode.md) for the full workflow.

## Autonomous and Self-Verification

| Command | Description |
|---------|-------------|
| `/goal <description>` | Work autonomously toward a goal until it's done (bounded, never-ask) |
| `/review` | Ask the agent to review and verify its own work |
| `/code-review [range] [-- path…]` | Review a diff: scope, groups and language rules computed before the model sees it |

**`/goal [N] <description>`** sets a goal for the session and starts working on it without stopping to ask. The goal is saved and stays in the agent's prompt until it's closed, so it survives compaction and later turns.

- **Closing it.** The agent closes the goal with its `goal_update` tool once every requirement is checked. The first "complete" is always sent back for one more check against the objective. The second goes to an independent reader, which sees the objective, the agent's evidence and the latest tool results, and can turn it down once, naming the gap. "Blocked" only sticks after three reports in one stretch of work (your reply starts the count over), or at once for a safety or policy line.
- **Keeping going.** Where a turn would normally end, an open goal continues it, up to 5 continuations. A pass that changed nothing gets a nudge to change approach; a second one in a row stops the drive and leaves the goal open for your reply. When the continuations run out, the agent sums up what's done and what's left.
- **Budget.** A leading number (`/goal 10 …`, or `--steps N`) sets the iteration budget of the turn it starts, 25 model calls by default. Hitting it ends that turn and leaves the goal open: your next message carries on with it. Each model call can carry several tool calls, so the budget counts LLM turns, not tools.
- **Interruptions.** Esc or a provider failure pauses the goal; the next turn picks it up and first re-checks what's on disk. In plan mode the goal doesn't push the turn on: the plan waits for your approval, and the goal drives again once you build.
- **Managing it.** `/goal status` shows it, `/goal edit <text>` changes the objective, `/goal clear` drops it. Both take effect on the agent's next step, even mid-turn. Deleting the session deletes its goal. Over the API, `goal: true` or a step count on a chat message does the same as `/goal`.

Use it for start-to-finish tasks: "fix the tests", "set up the project and make the first commit", "implement X and verify it runs". Works in the TUI and the web composer.

**`/code-review [range] [-- path…]`** reviews a change rather than the session. What must not go wrong is computed first, in code: which files are in scope (staged, unstaged and untracked against `HEAD`, or any git range you pass), which are filtered as generated, vendored or binary (each named with its reason so nothing looks silently missed), how they group into review units (a large file alone; a test with its implementation; otherwise by directory, capped), and which language rules apply. Only the judging is left to the model.

Findings go through a `review_report` tool that checks each one against the file: a line that doesn't hold is moved to where the quoted code actually is, and a finding whose code is nowhere in the file, or whose file is outside the scope, is dropped before you ever read it. A finding on a line the change didn't touch is kept and flagged as context.

```
/code-review                          # working tree vs HEAD
/code-review main..feature            # a branch's changes
/code-review HEAD~3..HEAD -- src/     # narrow a large change to one subtree
```

Rules live in `prompts/review-rules/`: one document per language, loaded only for the languages actually in the diff, plus a shared default whose two standing orders are *precision over recall* (a false positive costs the trust you need for the next finding) and *don't duplicate the toolchain* (whatever the linter, formatter, compiler or test run already says is not a review comment). Add your own by dropping a file in that directory.

**`/review`** asks the agent to verify its own most recent work: identify what changed (git diff / touched files), find and run the project's test and lint commands, and report honestly what was verified and what remains open. It never claims a check it didn't actually run.

## Steering

**Just type.** A plain message sent while the agent is running is steered into the running turn. No command needed, in the TUI and the web UI alike. `/steer` stays for when you want to be explicit (and for scripts).

These commands work while the agent is running:

| Command | Short | Description |
|---------|-------|-------------|
| `/steer <message>` | `/s` | Inject a message into the running turn |
| `/queue <message>` | `/q` | Queue a message for after the current turn |
| `/queue-reset` | `/qr` | Clear the message queue |
| `/abort`, `/stop` | | Stop current agent run |

**`/steer`** interrupts the current turn with new context: the message is injected immediately into the conversation, and the agent sees it on the next tool-call iteration. Useful for correcting course mid-execution.

**`/queue`** saves a message to run after the agent finishes its current turn. The message becomes a new turn automatically.

If nothing is running, both `/steer` and `/queue` submit the message as a normal prompt.

**`/abort`** stops the current run and clears both the steering and follow-up queues: anything queued before the abort is discarded.

Both steering and follow-up messages reset the doom loop counter: repeating a failing command after user guidance is treated as a new attempt, not a loop.

## Context and Usage

Token usage and context size are shown automatically in the TUI status bar (prompt tokens in, completion tokens out, prompt-cache hit %, cost, context percentage, tokens/second, and sub-agent tokens).

Use `/statusbar` to toggle individual segments on/off and reorder them (useful on narrow terminals where the full bar overflows). Segments can be moved between the left and right sides of the bar with ←/→, and reordered within each side with j/k. Default: persona, mode, model (left) and elapsed (right); enable others via `/statusbar`.

| Command | Description |
|---------|-------------|
| `/current` | All status bar data: model, context, tokens in/out with cache %, cost, sub-agent tokens, repo, session |
| `/context` | The AGENTS.md / CLAUDE.md files loaded for this directory, with their size, plus any file that could not be read |

## Configuration

| Command | Description |
|---------|-------------|
| `/settings` | One menu over the settings: model, provider, persona, permissions, reasoning, theme, status bar, web tools, skills, MCP, memory, turn cap, keys. Each row shows what it is set to on the right; Enter opens that setting's own picker. Works while a turn is running |
| `/permissions` | Open permission mode picker |
| `/permissions default` | Switch to gated mode (confirm dangerous commands) |
| `/permissions bypass` | Switch to bypass mode (no confirmation) |
| `/web` | Toggle web tools (web_search, web_fetch) on/off |
| `/web-search-provider` | Switch the `web_search` backend between DuckDuckGo (free, rate-limited), Tavily (API key, 1000 free/month), and Brave Search (API key) |
| `/web-fetch-provider` | Switch `web_fetch` between Jina Reader and direct local fetch |
| `/statusbar` | Toggle and reorder status bar segments (multi-select picker) |
| `/theme` | Open theme picker |
| `/theme <id>` | Switch to a specific theme |
| `/turn-cap [N\|reset]` | Show/set the per-turn iteration safety cap (default 500, 10–10000); applies on the next agent call. Also configurable via `maxTurnIterations` in `settings.json` and Settings → Bash |

## Utility

| Command | Description |
|---------|-------------|
| `/repo` | Show cwd, git branch, dirty state, remote, and HEAD |
| `/keys` | List all keybindings |
| `/lsp` | Show the language servers cast is running, and why others aren't |
| `/help` | Show the command list |
| `/ssh` | Manage SSH hosts: list, add, remove (persists to `~/.cast/ssh.json`) |

## Keybindings

| Action | Keys |
|--------|------|
| Previous / next prompt | ↑ / ↓ (moves within a multi-line draft first; moves the selection while the command palette is open) |
| Cursor left/right | ← / → (or Ctrl+B / Ctrl+F) |
| Word left/right | Alt+← / Alt+→ (or Ctrl+← / Ctrl+→) |
| Line start/end | Home / End (or Ctrl+A / Ctrl+E) |
| Delete char | Backspace / Delete |
| Delete word | Ctrl+W / Alt+Backspace |
| Delete to line start | Ctrl+U |
| Delete to line end | Ctrl+K |
| Submit | Enter |
| Line break | Shift+Enter or Alt+Enter, or end the line with `\` and press Enter, which works on any terminal |
| Stop turn (2×) | Esc |
| Clear the input | Ctrl+L |
| Exit (2× to confirm) | Ctrl+C |
| Attach image | Ctrl+G |
| Edit the prompt in `$VISUAL` / `$EDITOR` | Ctrl+X |
| Complete a command, or a file path | Tab |

**Esc** stops the current turn while generating (twice within 2s); `Ctrl+L` clears the input in any state.

**`@`** at the start of a word opens a fuzzy picker of project files (from `git ls-files` in a repository, so `.gitignore` holds; `rg --files` or a directory walk elsewhere). ↑/↓ choose, Tab or Enter insert `@path`, Esc closes it for that word. The model reads the file itself when it needs it. The web composer has the same picker.

**Tab** completes a slash command in the palette, and a path-shaped token anywhere else (one containing `/`, or starting with `~`). Ambiguous ones list what is left to choose from. Tab in ordinary prose does nothing.

**Line breaks:** Shift+Enter and Alt+Enter need a terminal that reports modified Enter (the Kitty keyboard protocol or `modifyOtherKeys`); everywhere else, end the line with a backslash and press Enter.

**A long draft wraps** at the terminal's edge, on word boundaries. The composer draws at most three rows and follows the cursor, with `↑`/`↓` in the prompt column where the draft continues past them. ↑/↓ move between rows, wrapped ones included.

**Ctrl+C**: press twice within 2s to exit. Does not stop a turn. Use Esc for that.

**Ctrl+X** opens the draft in `$VISUAL`, or `$EDITOR` when that is unset, like `git commit` does. The TUI steps aside while the editor runs; save and quit to bring the text back into the composer, still unsent. A GUI editor needs its wait flag (`code --wait`). A non-zero exit, such as `:cq` in vim, leaves the draft as it was.

**Scrolling.** The screen keeps its own place in the conversation, so nothing that arrives while you read moves you. The wheel or trackpad, PageUp / PageDown, Home / End (top and bottom of the conversation) and Ctrl+↑ / Ctrl+↓ (previous / next prompt) scroll it; a `↓ newest` label appears while you are away from the end, and clicking it jumps back. PageUp at the very top loads older turns of a resumed session. Ctrl+Shift+F searches the conversation. Dragging with the mouse selects text and copies it on release; where that gets in the way of the terminal's own selection (Shift+drag usually gives it back), start with `CAST_NO_MOUSE=1` and scroll by keyboard. `CAST_TUI=ink` starts the older Ink front end instead.

**Rebinding keys:** `keybindings` in `~/.cast/settings.json` maps an action id to one key or a list, replacing that action's defaults; `[]` unbinds it. `/keys` shows the keys in effect.

```json
{ "keybindings": { "input.externalEditor": "ctrl+o", "editor.clearBuffer": ["ctrl+l", "alt+l"] } }
```

Action ids are the ones in [`keybindings.ts`](https://github.com/aa-blinov/cast/blob/master/src/ui/input/keybindings.ts), for example `input.submit`, `input.attachImage`, `editor.deleteWordBackward`.

## During a Running Agent

Typing a plain message steers the running turn. No command needed. Besides that, these commands are accepted while the agent is executing:

- `/steer` / `/s`: inject context
- `/queue` / `/q`: queue follow-up
- `/queue-reset` / `/qr`: clear queue
- `/abort` / `/stop`: stop the run

All other input is rejected with a notice. Use Esc to stop the current turn (clears input when idle).
