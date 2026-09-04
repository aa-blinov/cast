# cast TUI

The TUI is the `cast` terminal app (run `cast` in a terminal). It is a single
vertical column — **there are no side panels or panes**; everything auxiliary
opens as a modal overlay or prints a warning-role line into the transcript.

## Layout (top to bottom)

- **Banner** — gradient `cast` ASCII banner printed above the frame at startup.
- **Chat log** — scrollable transcript of the session.
- **Notice line** — transient `[ ... ]` status messages just above the composer
  (also queued `/steer` and `/queue` items, which persist until drained).
- **Composer** — single-line input at the bottom, wrapped in a round border.
  Border color: green idle / yellow while a turn runs / muted while a modal is open.
- **Status bar** — one line at the very bottom.

## Transcript message formats

- `[user] ` — the user's message.
- `[agent] ` — the assistant's text reply.
- `[reasoning] ` — reasoning blocks (dimmed; hidden when `/reasoning-display` is off).
- `[toolname] [status] summary` — tool calls, status `[running]` / `[error]` / `[done]`.
  MCP tools render as `mcp_server · tool`. Summaries: `edit` → `path · +N -M`,
  `read` → `path · lines a-b`, `write` → `path · N lines`, `todo_write` → `N/M done — item`.
- `[{error}]` — a failed turn, in red.
- `[Retrying (attempt N): reason]` — a retry in yellow.
- Warning messages (e.g. `/help` output) — no prefix, warning color.

## Composer

- `> ` prompt. **Enter** submits (no Shift+Enter newline — multi-line pastes
  collapse into a single yellow `[Pasted N lines]` chip).
- **Esc** stops a running turn (double-press within 2s to confirm); **Ctrl+C**
  exits the app (double-press to confirm); **Ctrl+G** attaches an image from
  the clipboard; **Ctrl+L** clears the input.
- **PageUp** loads older session history; arrows move the cursor (no history recall).
- Typing `/` opens the command palette (`↑↓` + Tab/Enter to select, Esc to dismiss).
  Loaded skills appear as native `/<skill-id>` rows.

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

Core: `/abort`, `/build` (exit plan), `/clear`, `/compact`, `/continue`,
`/copy`, `/current`, `/exit` (alias `/quit`), `/fork`, `/help`, `/new`,
`/older`, `/plan`, `/quit`, `/undo`, `/reload`, `/repo`, `/rules`,
`/rule:<name>`, `/sessions`, `/worktree`, `/theme`, `/keys`.

Model/provider: `/model`, `/plan-model`, `/plan-model-provider`,
`/subagent-model`, `/subagent-model-provider`, `/provider`, `/reasoning`,
`/reasoning-format`, `/reasoning-display`, `/permissions`.

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
