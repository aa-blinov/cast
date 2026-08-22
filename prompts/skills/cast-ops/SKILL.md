---
name: cast-ops
description: Self-update Cast and control its web server — upgrade to latest, start/stop/status, public vs local. Use when the user says "обнови cast", "update", "подними вебсервер", "сделай публичным", "локальный сервер", "перезапусти daemon", "cast server". Triggers on "обнов", "upgrade", "server", "daemon", "публичный", "локальный", "перезапусти".
---

# Cast self-ops — update and web server

You (the agent) can manage Cast itself via `bash` — no human shell needed.

## Self-update

```bash
cast upgrade              # to latest
cast upgrade 0.22.7       # to pinned version
cast upgrade --force      # reinstall even if same
```

- Runs `install.sh` from `https://aa-blinov.github.io/cast` (see `src/core/upgrade.ts:102`). Works only from a release install (`dist/index.js`); from `git checkout` it prints `git pull` hint.
- After reinstall it auto-restarts the daemon if one was running (`src/core/upgrade.ts:159` `restartDaemon()` — `SIGTERM` old pid, `cast server start --port <old> --host <old>`). Check with `cast server status`.

Example:
```bash
bash: cast upgrade
bash: cast server status
```

## Web server — public vs local

```bash
cast server status                          # is it running? pid/host/port
cast server start --port 1337               # local only (127.0.0.1:1337, default)
cast server start --public --port 1337      # public (0.0.0.0:1337, needs firewall)
cast server start --host 0.0.0.0 --port 1337 # same as --public
cast server start --port 1337 --ui-port 1338 # also factory UIs on :1338 (rare)
cast server stop
```

- **Local** `127.0.0.1:1337` — only this machine, no firewall needed. Use when user says "локальный", "без сети", "только у меня".
- **Public** `0.0.0.0:1337` — reachable from other machines on this network, protected only by `cast`/`serverToken` password (`~/.cast/settings.json`). `install.sh` now `ufw allow 1337/tcp` (and `firewall-cmd`/`iptables` fallback). Use when user says "публичный", "открой для всех", "по сети", "внешний".
- **Check**: `bash: ss -tlnp | grep 1337`, `curl -I http://127.0.0.1:1337/login`, `curl http://57.131.129.41:1337/ui/` (factory listing).

## How to react in chat

- User: "обнови cast" → `bash: cast upgrade` → `bash: cast server status` → tell new version + `http://host:1337/app` (stable base) and `http://host:1337/ui/` (factory).
- User: "подними публичный вебсервер" → `bash: cast server status` → if not running `cast server start --public --port 1337` else `cast server stop` + `start --public`. Then `bash: ss -tlnp | grep 1337` and `curl -I http://127.0.0.1:1337/login` to verify, tell URL `http://<host>:1337/app` + password.
- User: "сделай локальный" → `cast server start --port 1337` (no `--public`), verify `127.0.0.1`.

## Safety

- Never `kill -9` the daemon manually — use `cast server stop`.
- After `upgrade`, the daemon auto-restarts on the same `host:port`; foreground daemons are left running (see `upgrade.ts:167`).

## References

| Topic | Read |
|-------|------|
| Upgrade impl | `references/upgrade.md` |
| Server lifecycle | `references/server.md` |
| Web UI ops | `references/web-ops.md` |
