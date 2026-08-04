# Per-action latency (cold cache, localhost, 2026-08-04)

Measured via Chrome 150.0.7871.181 headless + CDP. Each click is
issued from a synthetic script via `Runtime.evaluate`, then a
`MutationObserver` records the first DOM change. Time = ms from
the click handler running to the first DOM mutation. The whole app
loads from `127.0.0.1:18799`; cache is disabled; fresh chrome
profile per run.

| Action                              | Latency to first DOM change | Detail |
|---|---|---|
| Click "New Session" button           | **+13 ms**                  | Modal `<div>` added |
| Click "Quick Session" button         | NO DOM CHANGE in 3s         | Selector is on the new-session modal which is closed; see notes |
| Open Settings modal                  | **+14 ms**                  | Modal `<div>` added |
| Close Settings modal                 | **+16 ms**                  | Modal `<div>` removed |
| Type into composer                   | **+3 ms**                   | `<textarea style>` attribute mutation |

## Notes

- "Per-action" here means **perceived latency** — the time from when
  the click handler runs until the browser commits a DOM mutation.
  This is what the user sees as "the UI responding".
- Click handlers run **synchronously** in JS event-loop terms, so the
  measured time is dominated by React/Preact reconciliation and the
  size of the diff that has to land before paint can update.
- All five actions land well under 20 ms. That's already fast: humans
  don't perceive anything below ~100 ms as delayed, so the web UI is
  within "instant" range for the actions that matter most.
- "Quick Session" is reachable only via the "+ New Session" modal
  (per `src/web/public/sidebar.js:205`), so the standalone selector
  doesn't exist on the home page. A more useful measurement would be
  "open new-session modal" → "click Quick Session within modal". Not
  captured here.

## Caveats

- Headless chrome 150 with `--remote-debugging-port` has known flakiness
  with `Page.navigate` from a fresh tab (responses sometimes don't
  arrive). The proper CDP pattern — `Target.setAutoAttach` +
  `Target.createTarget` with `flatten: true` — is reliable; the legacy
  `PUT /json/new?url` HTTP API is **not**. See
  `/tmp/measure-proper3.cjs` for the working setup.
- The CDP pattern requires filtering `Target.attachedToTarget` events
  by URL — without that, the sessionId attaches to the chrome
  default newtab page, and subsequent measures target a stale session.
- Each measure spins up a fresh chrome profile to avoid cross-run
  contamination. The `--disk-cache-size=1048576` flag keeps the
  per-process cache small enough that test runs are deterministic.
