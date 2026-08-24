# Factory — библиотека `lib/` + сборка

`template/lib/components.js` — `Header, Sidebar, Bubble, Composer, SettingsModal` (Preact+htm, строгие props, `data-variant`), `lib/tokens.css` — 10 токенов `:root`. `app.js` только `LAYOUT/THEME` + `applyThemeVars` + компоновка кубиков. Скелет `Sidebar/Composer/SettingsModal/sessions/settingsOpen/api("GET","/api/system/version")/tab==="appearance"` валидируется `factory.ts:50`. `cp -r template` → правь `LAYOUT/THEME` + `tokens.css`, не пиши новые компоненты. `chokidar → /api/uis/events → reload`.
