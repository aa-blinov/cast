# Infrastructure

How cast's processes and surfaces fit together: the single-writer daemon, the TUI and web clients, lifecycles, and auth.

For the agent engine itself (how `runAgentLoop` streams, parallel tools, compaction), see [Architecture](architecture.md).
For the stable daemon integration contract, see [API v1](api.md).

## Overview

cast has two interactive surfaces and one engine. The engine (`runAgentLoop`, in `src/core/loop.ts`) is owned by exactly one process — the **`cast server` daemon** — which is the single writer to the SQLite session store. Both surfaces are thin clients of it over HTTP + SSE:

```
┌─────────────┐   HTTP + SSE    ┌──────────────────────────┐   runAgentLoop   ┌──────────┐
│   TUI       │ ───────────────▶│                          │ ────────────────▶│  LLM /   │
│ (thin       │                 │   cast server daemon        │                  │  tools   │
│  client)    │                 │  ─ owns runAgentLoop     │                  │  (MCP,   │
└─────────────┘                 │  ─ only writer to SQLite │                  │  bash…)  │
┌─────────────┐   HTTP + SSE    │  ─ streams WebEvent via  │                  └──────────┘
│   Web UI    │ ───────────────▶│    SSE to every client   │
│ (browser)   │                 └──────────────────────────┘
└─────────────┘
```

Before this model (pre-0.12.29) the TUI ran `runAgentLoop` **locally** and the web daemon re-implemented it. Two writers racing on the same session store meant a session opened in both surfaces only shared a periodic DB snapshot — no live cross-surface streaming, no shared abort. The single-writer daemon removes that split.

## The daemon is the engine

`cast server` is not a second implementation of the loop — it *is* the loop. One long-lived daemon process:

- owns `runAgentLoop` for every session;
- is the **only** process that writes to `~/.cast/sessions/sessions.db` by default;
- turns each `AgentEvent` into a `WebEvent` and broadcasts it over SSE to every subscribed client (the stable per-session `GET /api/v1/sessions/:id/events` stream, plus the web UI's sidebar-wide `GET /api/sessions/events`).

## TUI as a thin client

The TUI (`cast`, no subcommand) no longer runs the loop locally. On launch, `src/index.ts` calls `ensureDaemon()`:

- if a live daemon already exists (`~/.cast/server.json` describes an alive PID) with a compatible daemon protocol, it reuses it and reads the port + token from that state file;
- otherwise it spawns the internal daemon on loopback, waits for the child to actually bind (the state file is written only once the server is listening), then reads the port + token.

The TUI then:

- `submit(text)` → `POST /api/v1/sessions/:id/chat`;
- renders tokens / tool calls / status from the `/api/v1/sessions/:id/events` SSE stream — the same daemon event stream the browser consumes through its legacy UI route;
- `abort` / `steer` / `followUp` → `POST /api/v1/sessions/:id/{abort,steer,followup}`.

With `CAST_NO_DAEMON=1`, the TUI uses its local `runAgentLoop` fallback. `cast run` and `cast run --interactive` instead require the daemon so their sessions share the same store and event stream.

## Web UI (browser)

The original client. Connects over HTTP + SSE, logs in with the auto-generated password (`cast` / printed on first `cast web` start, saved in `settings.json`), and renders the same `WebEvent` stream the TUI does. Because both surfaces read the *same* SSE stream from the *same* daemon, opening one session in both shows live tokens, tool calls, and status in both, and an `abort` from either stops the turn for both.

## Lifecycle

- **Start:** `cast` (TUI) auto-spawns the daemon if none is live; `cast web start` (or just `cast web`) starts the browser surface explicitly. A detached daemon keeps running after the TUI exits, so the browser can still connect.
- **Stop:** `cast web stop` sends SIGTERM (escalating to SIGKILL after 3s), drains active turns, and clears the state file. Stopping the daemon also disconnects the TUI's SSE stream — the TUI sees `[terminated]` and can reconnect on next submit.
- **Stale state:** every reader (`status`, the TUI's `ensureDaemon`, the server's auth check) treats a PID whose process is no longer alive as stale and self-heals by clearing `~/.cast/server.json`.
- **Protocol compatibility:** TUI and headless clients compare the daemon protocol recorded in `server.json` before connecting. A mismatch (including a legacy daemon without the field) leaves the daemon untouched and asks the user to run `cast server stop` before starting Cast again.
- **`CAST_NO_DAEMON=1`:** the TUI skips `ensureDaemon()` and runs `runAgentLoop` locally — the pre-0.12.29 fallback. `cast run` and `cast run --interactive` do not have this fallback and report that the daemon is required.

For development, `npm run dev:web` starts the browser surface in the foreground; append server options after `--`.

## Auth

- **Loopback bind** (`127.0.0.1` / `localhost`): the daemon writes a local-only `token` into `~/.cast/server.json`. The TUI reads it from there and skips the browser's interactive login (trust-localhost). The token is never sent over the network by the daemon.
- **Non-loopback bind** (`--host 0.0.0.0` / `--public`): the daemon still records the local token, and a TUI on the same machine connects through `127.0.0.1`. The server accepts that token only from a loopback socket; remote browsers always use password login. Plain HTTP over a non-loopback bind is unencrypted — use it only on a trusted LAN, or keep loopback and tunnel with `ssh -L`.

## Why single-writer

A single writer removes dual-writer races on the session store and makes one session observable from both surfaces at once. The cost is a daemon process that now also appears when you only wanted the TUI — that is the deliberate trade for live cross-surface streaming.
