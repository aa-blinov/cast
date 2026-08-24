---
name: ui-factory
description: Builds and modifies Cast web UIs — creates new reactive frontends, edits layouts, themes, and components via lib/ puzzle library. Use when user asks to make a UI, change the UI, create new frontend, custom theme, reactive UI, or factory, or when adapting UI to a task (dashboard, kanban, focused chat).
---

# UI Factory — библиотека пазлов

Сборка из готовых кубиков, не фристайл. Любой `index.html` в `~/.cast/ui/<name>/` → `http://host:1337/<name>/` (канонично, без `/ui`; `/ui/<name>/` →302→ `/<name>/`). Встроенный `default` — `src/server/public` (`/`, `/default`).

## Быстрый старт

```
POST /api/uis {"name":"my-ui"} → 201 {url:"/my-ui/"}   # или cp -r src/server/ui-factory/template ~/.cast/ui/my-ui
# правь только LAYOUT/THEME + lib/tokens.css — кубики не трогай
```

## Библиотека `lib/` (все пазлы — не изобретай)

- `lib/tokens.css` — 10 токенов `:root` (`--bg --panel --border --text --muted --accent --accent-hover --success --warning --error`) + `--radius/--sidebar-w/--header-h`
- `lib/components.js` — база `Header, Sidebar, Bubble, Composer` (`@` mention пазл `api` → `GET /api/agents` + chips `→ ответят N агента`), `SettingsModal` — **правильный**: `General` (глобально) + `Appearance` — **пазл темы** `GET /api/themes` → `localStorage cast:ui:<name>:theme` (изолировано).
- `lib/puzzles.js` — пазлы `FileTree` (`/fs`), `DiffView` (`/diff`), `TelemetryKpis` (`/telemetry/overview`), `Kanban` (колонки `GET /api/sessions`), `AgentsPanel` (`GET/POST /api/agents` — библиотека агентов), `BuzzThreads` (тред где на 1 сообщение отвечают N агентов `POST /api/sessions {agentId}` фан-аут) — каждый <100 строк.

Скелет (валидация `factory.ts:50` — не удалять): `Sidebar + Composer + SettingsModal + sessions/settingsOpen` + `api("GET","/api/system/version")` + `tab==="appearance"`.

Сборка `app.js` — только:
- `LAYOUT = {sidebar:"left"|"right"|"off", density:"compact"|"comfortable"|"spacious", header:"minimal"|"full", composer:"bar"|"floating"}`
- `THEME = {bg,panel,border,text,muted,accent,accentHover,success,warning,error}` → `applyThemeVars` → `lib/tokens.css`
- `App: <Header/> + {sidebar!="off" && <Sidebar/>} + <Bubble/>* + <Composer/> + <SettingsModal api={api}/>` — добавь пазлы импортом `import { FileTree } from "./lib/puzzles.js"`.

## Дизайн — `frontend-design` коротко

Один тезис-герой, пара шрифтов (`display+mono ≠ Inter`), структура = информация, один motion (`prefers-reduced-motion`), Chanel — сними один аксессуар. Перед правкой план 4 строки: `Subject/Audience/Job + Palette 4-6 hex + Type + Signature` → выведи `LAYOUT/THEME`.

**Анти-паттерны (не делай, если бриф не просит):** `Inter` везде, `big number + small label + gradient`, `warm cream #F4F1EA + terracotta`, `near-black + acid-green`, `broadsheet hairlines`.

## Для агента

1. **Create:** `read lib/components.js` → план 4 строки → `POST /api/uis` → правь `LAYOUT/THEME`.
2. **Modify:** `edit lib/tokens.css` / `LAYOUT` — не трогай кубики.
3. **Verify:** см. `references/verify.md` — `playwright` `GET /<name>/` (без `/ui`, `/ui/<name>/` →302) скрин `1280×800`+`390×844` + `node --import tsx` валидация `factory.ts`. Без скрина `done` нельзя.

Где живут: `~/.cast/ui/*` (global), `~/.config/cast/ui/*`, `.cast/ui` (trust-gated). Список `GET /api/uis` + `GET /ui` листинг. Auth `POST /api/auth/login` → `HttpOnly cast_web_session`.

## References

| Topic | Read |
|-------|------|
| Верификация | `references/verify.md` |
| Библиотека | `lib/components.js`, `lib/tokens.css`, `lib/puzzles.js` |
| Дизайн | `references/frontend-design.md` |
| Реестр + API | `references/ui-registry.md`, `references/web-api.md` |
