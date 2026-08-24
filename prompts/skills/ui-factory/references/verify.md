# Verify — обязательно после каждого create/modify

**Factory:** `node --import tsx -e "import { createUi } from './src/server/ui-factory/factory.ts'; createUi('test')"` — проверка `Sidebar/Composer/SettingsModal/sessions/settingsOpen/api("GET","/api/system/version")/tab==="appearance"` (см. `factory.ts:50`). Падает если техдеталь `Меняй THEME` в `Appearance`.

**Визуально + функционально (Playwright `chromium`, см. `scripts/e2e-web-*.mjs:84` `playwrightExecutable()`):**
```js
// 1. auth
await page.goto('/login'); await page.fill('[name="username"]','cast'); await page.fill('[type=password]', serverToken); await page.click('button[type=submit]');
// 2. open — без /ui, /ui/<name>/ →302→ /<name>/
await page.goto('/<name>/'); await page.waitForSelector('.lib-header, .tg-header');
// 3. send
await page.fill('textarea','test'); await page.keyboard.press('Enter'); await page.waitForSelector('.lib-bubble-user, .bubble-user');
// 4. stream
await page.waitForSelector('.lib-bubble-assistant, .bubble-assistant', {timeout:8000});
// 5. settings — правильный General + Appearance (сетка тем, без "Меняй THEME")
await page.evaluate(()=> document.querySelector('button[aria-label="Settings"]')?.click());
await page.waitForSelector('.lib-modal, .ui-modal');
await page.evaluate(()=> Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Appearance')?.click());
await page.waitForTimeout(300);
await page.waitForSelector('text=Тема'); // сетка тем GET /api/themes → POST /api/settings/command /theme, нет "Меняй THEME"
await page.waitForSelector('.lib-card'); // хотя бы одна карточка темы
// 6. screenshots
await page.screenshot({path:`/tmp/playwright-${name}-1280.png`, fullPage:true}); // 1280×800
await page.setViewportSize({width:390, height:844}); await page.screenshot({path:`/tmp/playwright-${name}-390.png`});
```
Отдать: `http://host:1337/<name>/` (канонично, без `/ui`) + пути скринов. Без этого `done` нельзя.
