# Web API for UIs

All UIs reuse same daemon. **Auth first** — `POST /api/auth/login {username:"cast", password}` → `Set-Cookie: cast_web_session` (`HttpOnly`). Every `GET /api/*` except `/api/auth/*`, `/api/shared/*`, `OPENAPI_V1_PATH` is gated; client must handle `401 → location.assign("/login")` (see template `api()`).

- `GET /api/sessions` — list
- `POST /api/sessions {persona, cwd}` — create
- `GET /api/sessions/:id` — get (includes `status`, `turnStartedAt`, `streaming`)
- `POST /api/sessions/:id/chat {text, images, clientMessageId}` — send (202)
- `GET /api/sessions/:id/events` — SSE (status, token, thinking, tool_start/end, assistant_message, end, session_update, fs_change)
- `GET /api/uis` / `POST /api/uis {name}` / `GET /api/uis/events` SSE `ui_change`
- `GET /api/auth/session` — check, `POST /api/auth/logout`
- `GET /api/settings/*` / `POST /api/settings/*` — appearance, model, bash, memory, web, etc. (see `src/server/server.ts` route table)
- `GET /api/personas`, `/api/themes`, `/api/config`

Static: `GET /ui/<name>/*` and `GET /<name>/*` where `<name>` is a factory UI (e.g. `/claude-ui/`, `/ui/claude-ui/`) — public, `GET /vendor/*`, `/fonts/*`, `/login.html` — public. `GET /ui` lists factory UIs, `GET /` and `GET /default` (also `/default/settings`) → default, stable base layer. `GET /settings`/`/dashboard` — gated `index.html` fallback for base SPA.

See `src/server/api-v1.ts` for versioned contract and `prompts/skills/cast/references/web.md`.
