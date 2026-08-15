Use `cast web` to start the browser UI. With no public bind it is for the local machine; `cast web --port 1337 --public` binds to the network and requires the configured login password. The web login uses an HttpOnly, SameSite cookie and its sessions survive a server restart, but plain HTTP does not encrypt the password or conversation.

For remote use without a domain and TLS, prefer an SSH tunnel instead of exposing the port:

```bash
ssh -L 1337:127.0.0.1:1337 user@server
```

Then open `http://localhost:1337` locally. Do not claim that a password makes public HTTP safe against a network observer. Use HTTPS through a trusted reverse proxy or tunnel before exposing Cast to an untrusted network.

Web settings configure the same global providers, models, skills, MCP servers, plugins, hooks, SSH hosts, theme, and fonts as the TUI. Editing files under `.cast/` or `~/.cast/` still requires `/reload` in an active session; toggles and installs made in Settings apply immediately.

## Web UI

### Routes and layout

- The UI is a single-page app. `/` is the chat; `/settings` and `/dashboard` are
  dedicated routes (each is a full-screen overlay over the chat view, navigable
  with browser back/forward; the chat and its live stream stay mounted). The
  `?session=<id>` query rides on every route, so a settings/dashboard link keeps
  its session context and returning to `/` reconnects the same session.
- Layout: **header** (top), **sidebar** (left, session list), **chat area**
  (center), **right panel** (tabs: Inputs / Files / Memory / Changes). The
  sidebar and right panel are draggable-resizable.

### Header

Sidebar toggle; status dot (green connected / yellow reconnecting / red offline);
Status popover; **Dashboard** (chart icon → `/dashboard?session=...`);
**Settings** (gear → `/settings?session=...`); **Shortcuts**; **Diff** toggle.
The status popover shows persona, provider, model, mode, status, messages,
tokens in/out, cache %, cost, last-turn tok/s, directory, git branch, worktree.

### Sidebar

`+ New session` opens the new-session modal; the bolt button starts a sandbox
"quick session" immediately. Persona list (click to start a session), then the
session list grouped Today / Yesterday / Previous 7 days / Previous 30 days /
Older, pinned sessions first, running sessions next. Search filters sessions.
Each session row: status dot, pin, title (double-click to rename), `⋮` menu with
Rename / Share / Fork / Delete. Footer: default model + logout.

### Chat transcript

Messages labelled `you`, `agent`, `system`, `notice`, `error`. Assistant
messages render as ordered blocks: optional `reasoning`, agent content
(markdown), tool cards (collapsible args/result, MCP badge), and a turn footer
`provider · model · Ns`. Pending user message shows `you · sending…`. While a
turn runs, live streaming blocks (reasoning/content/tool) render in real time.
Above the composer: persona + mode badge + live elapsed timer; "Steer:" and
"Queued:" chips while the turn is being steered/queued. Plan cards appear when
the agent asks a question or presents a plan (Continue planning / Approve and
implement / Approve and implement in clean context).

### Composer

Textarea (Enter sends, Shift+Enter newline, Esc aborts a running turn),
paperclip for attachments (images → thumbnails, docs upload to
`~/.cast/inputs/<session-id>/`, executable/binary files rejected), drag-drop and
image paste, send/stop button. Typing `/` opens the command palette; `/persona`
prefix opens the persona picker.

### Right panel tabs

- **Inputs** — uploaded attachment files for the session.
- **Files** — searchable lazy directory tree of the session cwd with download/rename/delete.
- **Memory** — "Search project memory", notes count, current checkpoint
  (Intent/Next), reusable workflows, memory cards with type and importance badge
  (CRITICAL/HIGH/MEDIUM/LOW).
- **Changes** — git diff grouped New files / Staged / Modified / Deleted /
  Renamed; shows "Not a git repository" / "No changes" when nothing to show.

### New session modal

Persona selection, working directory (`Select dir` browser or `Sandbox` toggle →
`~/.cast/sandbox/cast-<id>`), and "Run in an isolated git worktree" checkbox
(auto `tree-XXXX` name, `<name>.cast/worktrees/`, branch `cast-<name>`; hidden
when cwd is not a git repo).

### Settings tabs

Appearance, Bash, Hooks, Marketplace, Memory, MCP, Model, Personas, Plugins,
Provider, Skills.sh, Quick Mode, Server, Skills, SSH, Web. A "Reload resources"
button re-scans `.cast/` directories. Key panels: **Appearance** (theme swatch
grid, font scale, reasoning toggle), **Memory** (memory on/off, background
writing, checkpoint knobs, per-section token caps, automatic dream/distill +
intervals, prompt budget, search score floor), **Provider** (saved providers
with verify-before-save add form), **Server** (running status, URL, PID,
uptime), **MCP/Skills/Hooks** (grouped lists with enable/disable).

### Dashboard tabs

LLM, Memory, Performance, Reliability, System — with 24h / 7d / 30d ranges.
- **LLM**: requests, prompt/completion tokens, cost, cache rate, latency avg +
  p50/p95/p99, tokens/s, errors; requests/tokens charts; by provider & model;
  recent-requests table.
- **Memory**: memory-tool search calls/errors/latency, maintenance runs, entries
  stored, maintenance tokens.
- **Performance**: API requests, avg/worst latency + percentiles, 5xx; endpoint
  table.
- **Reliability**: requests, retries, retry rate, moderation blocks; error-type
  breakdown.
- **System**: compactions, context saved/used, sessions, file edits, per-turn
  metrics (turns, tool calls/turn, tokens/turn, time/turn); tool-calls chart and
  tool-usage table with avg latency.

### Login and shortcuts

- `/login` is a static page: username (prefilled `cast`) + password + Sign in.
- Shortcuts: Ctrl/Cmd+B toggle sidebar, Ctrl/Cmd+Shift+D toggle diff,
  Ctrl/Cmd+Shift+N new session, Ctrl/Cmd+Shift+L clear context,
  Ctrl/Cmd+/ shortcuts. Esc closes open modals.

