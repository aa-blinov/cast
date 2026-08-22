---
name: ui-factory
description: Build and modify Cast web UIs — create new reactive frontends, edit layouts, themes, and components. Use when the user wants a custom UI, to change the look of the web app, to add a new page/panel, or when you (the agent) want to adapt the UI to the task (e.g. a data dashboard, a kanban, a focused chat). Triggers on "make a UI", "change the UI", "new frontend", "custom theme", "reactive UI", "factory".
---

# UI Factory — reactive, no-build frontends for Cast

Cast's daemon is headless — any frontend that speaks `/api/*` can drive it. The built-in UI is at `src/server/public` (`dist/public` after build, served at `/` on `1337` **and stable aliases** `/app`, `/cast`, `/default`, `/base`, `/based` (typo alias), `/core`, `/main` — all same `default`, never moves). Factory UIs are just static dirs with `index.html` served at `http://host:1337/ui/<name>/` and `http://host:1337/<name>/` (e.g. `http://host:1337/claude-ui/`) via `src/server/ui-registry.ts` — same daemon, same `/api/*`, no neighbour port needed.

## Where UIs live (discovered every request, no restart)

- `~/.cast/ui/<name>/` — global, always trusted
- `~/.config/cast/ui/<name>/` — XDG global
- `<cwd>/.cast/ui/<name>/` and `<cwd>/.agents/ui/<name>/` — project-local, trust-gated (same as skills/mcp)

Each needs `index.html` (others optional). Listed at `GET /api/uis` → `[{name, builtin}]`. `GET http://host:1337/ui` lists factory UIs, `GET http://host:1337/` and `GET http://host:1337/app` (also `/cast`, `/default`, `/base`, `/based`) is still `default`. Factory UIs at `http://host:1337/ui/<name>/` and `http://host:1337/<name>/` (e.g. `http://host:1337/claude-ui/`).

## Factory template

`src/server/ui-factory/template/` is a minimal reactive UI (Preact + htm via `/vendor/*`, no build). It reuses the same API as the default UI:

- `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/chat`, `GET /api/sessions/:id/events` (SSE)
- `GET /api/uis`

Copy it:

```
POST /api/uis {"name":"my-ui"}  → 201 {url:"/ui/my-ui/", dir:"~/.cast/ui/my-ui"} (http://host:1337/ui/my-ui/ and http://host:1337/my-ui/ — both same)
# or
cp -r src/server/ui-factory/template ~/.cast/ui/my-ui
# then edit
# GET http://host:1337/ui lists factory UIs, GET http://host:1337/ and GET http://host:1337/app (also /cast, /default, /base) is still default — /app/settings and /settings both serve default's SPA (viewFromPath handles /app prefix)
```

Template files:

- `index.html` — shell + importmap (`preact`, `htm` → `/vendor/*`)
- `app.js` — `LAYOUT = {sidebar:"left|right|no", diff:"", showReasoning}` and `THEME`, components `Sidebar`, `Chat`, `Composer`, `Message`. Edit `LAYOUT` to rearrange, add panels, swap components.
- `style.css` — tokens at `:root` (`--bg`, `--accent`, `--border`).
- `README.md` — usage.

No rebuild: extra UIs are static, served directly; refresh after edit.

## Auth & Settings — must handle

- **Login**: daemon auth is `HttpOnly` cookie `cast_web_session` set by `POST /api/auth/login {username:"cast", password: serverToken from ~/.cast/settings.json serverToken}`. Every `GET /api/*` (except `/api/auth/*`, `/api/shared/*`, `/vendor/*`, `/fonts/*`, `/ui/*` assets) is gated — client must `if (res.status===401) location.assign("/login")` (see template `api()` helper). `GET /login` → `login.html`, `POST /api/auth/logout` clears.
- **Settings**: `~/.cast/settings.json` via `GET /api/settings/appearance|model|bash|memory…` and `POST` same. To build a settings UI, fetch current, render controls, `POST` back. See `src/server/server.ts` route table and `prompts/skills/cast/references/web.md` (settings/dashboard tabs).
- **No secrets in UI**: static assets are public, all data via `/api/*` is gated — don't embed tokens in JS.

## Safety — never break the built-in UI

- **Never** `write`/`edit` `src/server/public/*` or `dist/public/*` — that's the built-in `default` UI at `/` (`cast` web). It is rebuilt from sources and served `no-cache` for HTML but `immutable` for `?v=` assets; overwriting it requires a rebuild and breaks `1337` for everyone. The daemon will reject such writes with `PERMISSION_DENIED`.
- Only `~/.cast/ui/<name>/`, `~/.config/cast/ui/<name>/`, or (if trusted) `.cast/ui/<name>/` — those are served at `http://host:1337/ui/<name>/` and `http://host:1337/<name>/`. `default` at `http://host:1337/` and `http://host:1337/app` stays untouched.

## For the agent (you)

You can change the UI yourself — no user edit needed:

1. **Create**: `write` to `~/.cast/ui/<name>/index.html` (or `POST /api/uis`) — copy template then edit.
2. **Modify**: `read` then `edit`/`write` any file in `~/.cast/ui/<name>/` — e.g. change `LAYOUT.sidebar = "no-sidebar"` for a focused chat, or `THEME.accent = "#ff3366"`, or replace `Message` to render a custom card.
3. **Live**: server watches `~/.cast/ui/*` via `chokidar` and broadcasts `ui_change` on `GET /api/uis/events` (SSE). The factory template listens and `location.reload()`s — your change appears without manual refresh. If the UI doesn't listen, the next `GET /ui/<name>/` already serves the new file (HTML `no-cache`).

Example — make a minimal kanban UI:

```
write ~/.cast/ui/kanban/index.html  — copy template index.html, change title
write ~/.cast/ui/kanban/app.js      — replace Chat with Kanban component that fetches /api/sessions and renders cards
write ~/.cast/ui/kanban/style.css   — tweak --accent
```

Then tell the user: `http://host:1337/kanban/` and `http://host:1337/ui/kanban/` are live.

## References

| Topic | Read |
|-------|------|
| UI registry and serving | `references/ui-registry.md` |
| Factory template walkthrough | `references/factory.md` |
| Web API for UIs | `references/web-api.md` |
