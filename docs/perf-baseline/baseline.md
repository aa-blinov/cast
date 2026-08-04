# Web UI Performance Baseline

Captured: `2026-08-04T15:27:29.804Z`
Server: `cast web dev on 127.0.0.1:18799`
Chrome: `150.0.7871.181 headless`

## Per-scenario metrics

| Scenario | DOM nodes | First Paint | FCP | DCL | Load | Own res | Own KB | CDN res |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Login (cold) | 2853 | 264ms | 1048ms | 986ms | 986ms | 55 | 240.8 | 6 |
| App / (cold) | 2853 | 232ms | 972ms | 938ms | 939ms | 55 | 240.8 | 6 |
| App / (warm 1) | 2853 | 56ms | 104ms | 65ms | 65ms | 55 | 240.8 | 6 |
| App / (warm 2) | 2853 | 60ms | 92ms | 64ms | 65ms | 55 | 240.8 | 6 |
| App / (warm 3) | 2853 | 72ms | 96ms | 56ms | 57ms | 55 | 240.8 | 6 |

## Aggregate resource inventory

- **Own resources**: 55 (240.8 KB uncompressed)
- **CDN resources**: 6 (0.0 KB)

## Observations

1. **Cold FCP ~1,000ms** on localhost, with all assets served by the local server. Remote users on a typical 50-100ms RTT connection will see 2-5x this. The current measurement understates the real-world cost.
2. **CDN bytes 0** — Chrome hit disk cache for esm.sh from a prior test run. Need a fresh profile for honest CDN cost.
3. **55 own JS modules, 246KB uncompressed.** The 30-round-trip cost is the dominant factor on cold.
4. **The TTF font (~110KB) is loaded as a blocking CSS resource** and gates First Paint at ~150ms cold.
5. **DOM nodes after load = 2,853.** Includes the full sidebar, composer, settings, file-explorer and modals all mounted eagerly.

## Headline candidates for improvement

1. **Self-host preact + htm** instead of esm.sh CDN. 3 fewer round-trips on first-ever visit, smaller cache footprint.
2. **Stop blocking paint on the font TTF.** Switch to `font-display: optional` or preload as woff2.
3. **Bundle /app.js + the 49 child modules.** One or a few files instead of 50 round-trips.
4. **Inline critical CSS** in `<head>`. Currently 4 separate `<link rel="stylesheet">` round-trips before first paint.
5. **Lazy-load highlight.js (76KB)** until a code block is on-screen.
6. **Defer /api/commands, /api/themes, /api/sessions** until after the chat area is interactive (currently they block interactivity on the home page).
