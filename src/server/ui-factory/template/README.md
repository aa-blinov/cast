# {{UI_NAME}} — factory UI

Reactive, no build step (Preact + htm via `/vendor/*`), talks to same `cast` daemon (`/api/*`, `SSE /api/sessions/:id/events`).

## Auth

Daemon uses `HttpOnly` cookie `cast_web_session` from `POST /api/auth/login {username:"cast", password}`. `api()` helper does `if (401) location.assign("/login")` — keep it.

## Edit

- `app.js` → `LAYOUT` (sidebar left/right/no), `THEME.accent`, `Sidebar`/`Composer`/`Message` components.
- `style.css` → tokens at `:root`.
- `index.html` → title.

Refresh after edit — no rebuild needed (extra UIs are static, served from `~/.cast/ui/{{UI_NAME}}/` at `http://host:1337/ui/{{UI_NAME}}/` and `http://host:1337/{{UI_NAME}}/`). Default UI is stable at `http://host:1337/` and `http://host:1337/app` (also `/cast`, `/default`, `/base`, `/based`). Server watches `~/.cast/ui` and broadcasts `ui_change` on `GET /api/uis/events` → template auto-reloads.

## API used

`POST /api/auth/login`, `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/chat`, `GET /api/sessions/:id/events` (SSE), `GET /api/uis`, `GET /api/settings/*`.

See `src/server/ui-registry.ts` for discovery (`~/.cast/ui/*`, `.cast/ui/*` trust-gated) and `prompts/skills/cast/references/web.md` for settings.
