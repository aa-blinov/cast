# cast TUI

The TUI is the `cast` terminal app (run `cast` in a terminal). It is a single
vertical column — **there are no side panels or panes**; everything auxiliary
opens as a modal overlay or prints a warning-role line into the transcript.

## Layout (top to bottom)

- **Banner** — gradient `cast` ASCII banner printed above the frame at startup.
- **Chat log** — scrollable transcript of the session.
- **Notice line** — transient status just above the composer (also queued `/steer`
  and `/queue` items, one truncated row each, which persist until drained).
- **Composer** — `> ` input between two horizontal rules; at most three rows
  shown, following the cursor.
- **Status bar** — one line at the very bottom.

## Transcript message formats

Every row carries a marker in one gutter column:

- `▌ you  …` — the user's message; `▌ agent  …` — the assistant's reply, rendered
  markdown (headings, emphasis, code blocks, lists, aligned tables).
- `┆` — reasoning rows (hidden unless `/reasoning-display` is on).
- `│ tool summary` — a finished tool call, dimmed: `│ bash git status`,
  `│ read src/a.ts – lines 1-40`, `│ write notes.md – 2 lines`. A running call uses
  a thicker `┃`; a failure is marked `✗`. A running `task` row shows the subagent's
  progress: `[explore ↳ read src/auth.ts · 3]`.
- `ⓘ` — a harness notice (command output such as `/help`, warnings).

## Composer

- **Enter** sends. A line break: Shift+Enter or Alt+Enter where the terminal
  reports them (kitty, WezTerm, Ghostty, iTerm2), or end the line with `\` and press
  Enter. Long pastes collapse into a `[Pasted N lines]` chip.
- **↑/↓** move between draft rows, then recall earlier prompts.
- **Esc** stops a running turn (twice within 2s); **Ctrl+C** exits (twice);
  **Ctrl+L** clears the input; **Ctrl+G** attaches a clipboard image;
  **Ctrl+X** edits the draft in `$VISUAL`/`$EDITOR` and brings the saved text back
  unsent; **PageUp** loads older history.
- **Tab** completes a slash command, or a path-shaped token (containing `/` or
  starting with `~`).
- **`/`** opens the command palette (↑↓, Tab/Enter, Esc); loaded skills appear as
  `/<skill-id>` rows. **`@`** at the start of a word opens a fuzzy picker of project
  files (`git ls-files`, so `.gitignore` holds); Tab/Enter insert `@path`.
- Keys are remappable with `keybindings` in settings (`references/settings.md`);
  `/keys` lists the keys in effect.
- While the terminal window is unfocused, the end of a turn and an approval
  request send a terminal notification and a bell (`notifications: false` turns it
  off).

## Status bar

Segments separated by ` │ `, configurable via `/statusbar`:

| Segment | Shows |
|---|---|
| Persona | active persona label |
| Mode | `PLAN` (warning) / `BUILD` (muted) |
| Model | active model (plan override when active) |
| Git Worktree | `wt:<name>` when inside a worktree |
| Session | session id (off by default) |
| Context | `ctx 8.7k/200k (4%)` |
| Usage | `12.5k in (34% cached) / 8.7k out` |
| Cost | running cost |
| Speed | tokens/sec |
| Elapsed | live turn timer |
| Subagent | subagent tokens |

`/current` prints every segment's data. The active provider is only visible via
`/provider` or `/current`.

## Slash commands

Core: `/abort`, `/build` (exit plan), `/clear`, `/compact`, `/context`,
`/continue`, `/copy`, `/current`, `/exit` (alias `/quit`), `/fork`, `/help`,
`/new`, `/older`, `/plan`, `/quit`, `/undo`, `/reload`, `/repo`, `/rules`,
`/rule:<name>`, `/sessions`, `/worktree`, `/theme`, `/keys`, `/goal`,
`/turn-cap`, `/review`, `/evolve`, `/agents` (subagents of this session).

Model/provider: `/model`, `/plan-model`, `/plan-model-provider`,
`/subagent-model`, `/subagent-model-provider`, `/provider`, `/reasoning`,
`/reasoning-format`, `/reasoning-display`, `/permissions`, `/persona`.

Run-time injection (allowed while a turn runs): `/queue` (+`/q`), `/queue-reset`
(+`/qr`), `/steer` (+`/s`).

Tools/skills/MCP: `/mcp`, `/skills`, `/hooks`, `/web`,
`/web-search-provider`, `/web-fetch-provider`, `/ssh`, `/statusbar`,
`/memory` (on/off, `write`, `budget`, `floor`, `reconcile`, `dream`/`distill`
+ interval, `runs`, `cancel`, `checkpoint`), `/dream`, `/distill`.

`/<skill-id>` invokes a skill by id.

## Plan mode

- `/plan` enters plan mode (writer tools disabled), `/build` exits. Mode is
  per-session, persisted.
- When the plan is ready: modal with **Continue planning** / **Approve and
  implement** / **Approve and implement in clean context**. Approval switches
  to build mode and auto-submits "The plan is approved. Implement it step by step."
- The model's `question` tool renders as sequential option modals, each with an
  `Other… (custom answer)` free-text option.

## Pickers / modals

- Single-select picker: `> ` cursor, ↑↓, Enter confirm, Esc cancel, type-to-filter.
- Multi-select picker: `[x]`/`[ ]` checkboxes, Space toggles.
- Text-input modal: label + `> ` line.
- Onboarding (first run) selects model/persona/reasoning before the app mounts.
- Confirmation prompt (dangerous command, or an `ask` permission rule): **Allow
  once** / **Always allow** (saves an exact rule to `permissions.approved`) / **Block**.
