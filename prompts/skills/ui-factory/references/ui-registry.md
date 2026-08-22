# UI registry

Discovered via `src/server/ui-registry.ts:discoverUis(cwd, trusted)` every request (no restart).
- `~/.cast/ui/*` + `~/.config/cast/ui/*` + trust-gated `./.cast/ui/*`
- Served at `GET /ui/<name>/*` and `GET /<name>/*` where `<name>` is a factory UI (e.g. `/claude-ui/` and `/ui/claude-ui/` same) with `Cache-Control: no-cache` for `html`, `public, max-age=3600` for assets.
- `GET /ui` lists factory UIs, `GET /` and `GET /app` (also `/cast`, `/default`, `/base`, `/based`, `/core`, `/main` + `.../settings`) → `default` (`dist/public`, stable base layer).
- List at `GET /api/uis` (`[{name, builtin}]`).

See `src/server/server.ts:2203`.
