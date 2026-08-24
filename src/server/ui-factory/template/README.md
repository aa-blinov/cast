# {{UI_NAME}} — factory UI (skeleton + fabric)

Reactive, no build (Preact + htm via `/vendor/*`), talks to same daemon (`/api/*`, `SSE /api/sessions/:id/events`).

## Skeleton (backbone — do NOT remove)

- `Sidebar` — threads (`GET /api/sessions`, select)
- `Composer` — send (`POST /api/sessions/:id/chat`)
- `SettingsModal` — real tabs **General** (Default UI, Updates, Server) + **Appearance** (themes) — not a stub
- State `sessions` / `settingsOpen` + SSE `streamBlocks` + `api()` 401→/login
- `GET /api/uis/events` live-reload

Checked by `factory.ts` — missing any → `createUi` throws.

## Fabric — generate on top of the skeleton

- `app.js` `LAYOUT` — `sidebar: left|right|off`, `density: compact|comfortable|spacious`, `header: minimal|full`, `composer: bar|floating`, `showReasoning`, `showSettings`
- `app.js` `THEME` — full palette `bg/panel/border/text/muted/accent/accentHover/success/warning/error` → `style.css :root`
- `style.css` — tokens + grid variants (`.layout-*`, `.density-*`, `.composer-*`, `.header-*`) + `.ui-modal`, `.theme-grid`

To make a new variant: change `LAYOUT`/`THEME` and `style.css` tokens only — keep the backbone.

## Edit

- `app.js` → `LAYOUT`/`THEME`, optional `Message`/`Sidebar` reskin
- `style.css` → `:root` vars, layout classes, modal/theme cards
- `index.html` → title/importmap

Refresh — no rebuild (served from `~/.cast/ui/{{UI_NAME}}/` at `http://host:1337/ui/{{UI_NAME}}/` and `http://host:1337/{{UI_NAME}}/`). Default stays at `http://host:1337/` and `http://host:1337/default`. Server watches `~/.cast/ui` → `GET /api/uis/events` SSE `ui_change` → `location.reload()`.

## API used

`POST /api/auth/login`, `GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/chat`, `GET /api/sessions/:id/events` (SSE), `GET /api/uis`, `GET /api/system/version`, `POST /api/system/upgrade`, `GET /api/settings/default-ui`, `POST /api/settings/default-ui`, `GET /api/server/status`, `GET /api/themes`, `POST /api/settings/command` (`/theme …`).

See `src/server/ui-registry.ts`, `prompts/skills/ui-factory/SKILL.md`.
