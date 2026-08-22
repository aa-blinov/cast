# Server lifecycle

`src/index.ts:460` `cast server [start] [--port <n>] [--host <addr>] [--public] [--foreground] | cast server stop | cast server status`

- `start` — acquires `daemon-state` lock, `runStartup` (persona/model, MCP defer), `startServer({port,host,bridge})`, writes `~/.cast/server.json` (`daemon-state.ts`).
- `status` — `readLiveServerState()` (self-heals stale PID).
- `stop` — `SIGTERM` + `clearServerState()`, 3s fallback `process.exit(0)`.
- `ui-port` — extra `chokidar` + `GET /api/uis/events` for factory reload (see `ui-factory` skill).

Check: `cast server status`, `ss -tlnp | grep 1337`, `curl -I http://127.0.0.1:1337/login` (200) vs `http://57.131.129.41:1337/login` (public).
