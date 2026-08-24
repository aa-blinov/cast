# Reusable panels — compose beyond minimal chat

Template is `Sidebar(threads) + Chat + Composer + SettingsModal`. Keep skeleton, add panels per brief. Each talks to same `GET /api/*` (401→/login). Lazy-load panels, cache where noted.

## Chat/Threads (base — keep)
- `GET /api/sessions` → `ListItem {id,title,persona,status,messageCount}`; `POST /api/sessions {persona,model,cwd}` → `{id}`; `GET /api/sessions/:id` → `{messages, streaming, status, turnStartedAt}`; `POST /api/sessions/:id/chat {text}` (202) + `GET /api/sessions/:id/events` SSE `token/thinking/tool_start/end/assistant_message/end`.
- Patch: `LAYOUT.sidebar left|right|off`, `density` controls `gap/padding`.

## Kanban / Board
- Source: same `GET /api/sessions`. Group client-side by `status` (`running|idle`) / `persona` / `pinned` / `cwd` shortPath. `POST /api/sessions/:id/pin {pinned}` for columns. Drag is local — no daemon move. Keep `Composer` for "new card → new session".

## Dashboard / Telemetry
- `GET /api/telemetry/overview?since=24&resolution=60` + `series` + `recent?limit=&offset=` + `endpoints` + `endpoint-series` + `reliability` + `system` + `memory`. Fetch in `useEffect`, 30s `telemetryCache` (see `dashboard.js`). Use `content-visibility:auto` for rows. Hero thesis: the one metric the brief cares about (e.g. `p95` latency), not generic "big number + gradient".

## Files / Workspace
- `GET /api/sessions/:id/fs?path=` → `{entries:[{name,type, size}]}` (dirs first). Silent loading `?path=` with `treeRef` refs (not spinner) — see `file-explorer.js:45`.
- Preview: `GET /api/sessions/:id/fs/download?path=&inline=1` → `Content-Type` via `PREVIEW_MIME`, PDF needs `X-Frame-Options` removal + `frame-ancestors 'self'` (`server.ts` PDF branch) and header icons (not duplicate Download/Delete). `style.css:895` portrait modal `100dvh`.
- Diff: `GET /api/sessions/:id/diff` → `{files, groups:{untracked,added,modified}}` (`workspace.css:232` `diff-line`).
- Inputs/Attachments: `GET/POST /api/sessions/:id/inputs`, `POST .../inputs/upload {name,dataUrl}` 25MB cap, `DELETE .../inputs?path=`.
- Browser: `GET /api/browse?path=` + `POST /api/browse/mkdir` + `DELETE /api/browse`.

## Settings-heavy page
- Fork `SettingsModal` into a page: `Appearance` (`GET /api/themes` → `POST /api/settings/command /theme`), `Default UI` (`GET/POST /api/settings/default-ui`), `Updates` (`GET /api/system/version` + `POST /api/system/upgrade`), `Server` (`GET /api/server/status`). Full 18-tab parity lives at `/default/settings` (`settings-modal.js:10`) — don't duplicate unless brief demands; link to it.

## Patterns
- Skeleton first: don't remove `Sidebar/Composer/SettingsModal`. Add panel as `if (LAYOUT.showFiles) <FilePanel .../>`.
- Tokens: extend `:root` (`--bg --panel --border --text --muted --accent`) and map `LAYOUT.density` → spacing scale; load distinctive fonts via Google Fonts in `index.html`.
- Motion: one signature (e.g. `rise` `opacity`-only `chat.css:64`, 80ms `StreamingMarkdown` throttle, or `tree` expand 150ms) — respect `prefers-reduced-motion`.
- Empty/error: give direction ("Create first thread" + CTA), not apology.

See `src/server/server.ts` route table for all endpoints and `src/server/public/{dashboard,file-explorer,workspace,file-preview}.js` for reference implementations.
