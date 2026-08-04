# Web UI Performance Baseline (with cache disabled, fresh profile)

Captured: `2026-08-04T15:30Z`
Chrome: `150.0.7871.181` headless, `Network.setCacheDisabled=true`, fresh user data dir
Server: `cast web dev` on `127.0.0.1:18799`

## CDN round-trips (the real cost of `https://esm.sh/...`)

| Resource | First byte | Duration | Size |
|---|---:|---:|---:|
| `/htm@3.1.1` (initial) | 437ms | 461ms | 0 bytes (gzip) |
| `/preact@10.25.4` (initial) | 438ms | 463ms | 0 bytes |
| `/preact@10.25.4/hooks` (initial) | 438ms | 465ms | 0 bytes |
| `/htm@3.1.1/es2022/htm.mjs` (after redirect) | 464ms | 490ms | 0 bytes |
| `/preact@10.25.4/es2022/preact.mjs` (after redirect) | 464ms | 493ms | 0 bytes |
| `/preact@10.25.4/es2022/hooks.mjs` (after redirect) | 468ms | 491ms | 0 bytes |

`size = 0 bytes (gzip)` — actual transferred body. The fact that
`size` reports `0` is misleading: `performance.getEntriesByType('resource')`
returns `transferSize = 0` for cross-origin resources when the
Timing-Allow-Origin header is missing, which is the case for esm.sh.
The actual bytes are non-zero. I confirmed via `curl` that each
resource is ~1-15KB transferred compressed.

## Takeaway

- **Three sequential round-trips to esm.sh**, each 437-500ms,
  blocking main thread.
- These happen during the critical render path (`<script type="module">`
  in `<head>`); until the preact bundle loads, the app **cannot mount**.
- On the **localhost** dev server this still costs ~470ms each. On
  a real network with 50-100ms RTT to esm.sh, this would still
  dominate load time.

## What this means for production

- **Self-host preact + htm** in `public/vendor/` and update the
  importmap → 0 round-trips for the framework.
- **Bundle /app.js + 49 child modules** into one or two files →
  drops 50 round-trips to 1.
- **Add a build step** so we can tree-shake and minify.
- **Inline critical CSS** in `<head>` → saves 4 stylesheet round-trips.
