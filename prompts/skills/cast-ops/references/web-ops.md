# Web ops — public vs local

- Local: `cast server start --port 1337` → `127.0.0.1:1337` — no firewall, `curl http://127.0.0.1:1337/login` 200, `http://57.131.129.41:1337/login` timeout.
- Public: `cast server start --public --port 1337` → `0.0.0.0:1337` — needs `ufw allow 1337/tcp` (now done by `install.sh:109`). Verify `ss -tlnp` shows `0.0.0.0:1337` and `curl -I http://57.131.129.41:1337/login` 200 from outside.
- Switch: `cast server stop` + `cast server start --public` vs `cast server start --port 1337`.
- Factory UIs: `GET http://host:1337/ui/<name>/` and `http://host:1337/<name>/` (e.g. `/claude-ui/`), list at `GET http://host:1337/ui`.

Password in `~/.cast/settings.json` `serverToken`, shown once at first `server start`.
