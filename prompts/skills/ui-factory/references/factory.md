# Factory template

`src/server/ui-factory/template/` — `Preact + htm` via `/vendor/*`, no build, `LAYOUT = {sidebar:"left|right|no", showReasoning}` and `THEME = {accent, bg}` at top of `app.js`, `style.css :root` (`--bg`, `--accent`), `index.html` importmap.

- Copy: `POST /api/uis {"name":"my-ui"}` → `201 {url:"/ui/my-ui/", dir:"~/.cast/ui/my-ui"}` (`http://host:1337/ui/my-ui/` and `http://host:1337/my-ui/`) or `cp -r src/server/ui-factory/template ~/.cast/ui/my-ui` (+ `{{UI_NAME}}` replace)
- Edit: `read` then `edit`/`write` `~/.cast/ui/<name>/app.js` (`LAYOUT`/`THEME`/`Message`/`Sidebar`), `style.css`, `index.html`
- No rebuild: `chokidar` watches `~/.cast/ui` → `GET /api/uis/events` SSE `ui_change` → `template/app.js:140` `location.reload()` — change appears while page open (`http://host:1337/ui/<name>/` or `http://host:1337/<name>/`).

Default stays at `http://host:1337/` and `http://host:1337/app` (stable aliases `/app`, `/cast`, `/default`, `/base`, `/based`, `/core`, `/main` + `.../settings`) — never overwritten (`files.ts:265` `Blocked`).
