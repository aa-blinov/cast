# Upgrade

`src/core/upgrade.ts:41` `isReleaseInstall()` — true only for `dist/index.js` (release tarball), false for `src/index.ts` via `tsx`.

- `cast upgrade` → `fetchLatestVersion()` → `spawnSync("bash -c curl -fsSL https://aa-blinov.github.io/cast/install | bash")` with `CAST_VERSION` env.
- `cast upgrade <ver>` → pinned.
- Windows prints `irm ... | iex` instead.

After install: `restartDaemon()` — `SIGTERM` old pid, wait 10s, `cast server start --port <old> --host <old>`, verify `isCurrentDaemonInstance`.
