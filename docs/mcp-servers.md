# MCP Servers

cast supports [Model Context Protocol](https://modelcontextprotocol.io) servers, local (stdio) or remote (streamable HTTP). Their tools appear alongside the built-in ones, no special syntax needed to call them.

## Configuration

MCP servers are configured in JSON files using the common `mcpServers` shape:

| Location | Scope | Trust |
|----------|-------|-------|
| `~/.cast/mcp.json` | Global (all projects) | Always loaded |
| `.cast/mcp.json` | Project-local | Trust-gated |

### Local Server (stdio)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "@my-org/mcp-server"],
      "env": {
        "API_KEY": "optional-env-var"
      }
    }
  }
}
```

### Remote Server (streamable HTTP)

```json
{
  "mcpServers": {
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "headers": {
        "X-API-KEY": "your-api-key"
      }
    }
  }
}
```

### Config Fields

**stdio (local):**

| Field | Description |
|-------|-------------|
| `command` | Executable to run |
| `args` | Command arguments |
| `env` | Environment variables (optional) |
| `cwd` | Working directory (optional) |

Stdio servers inherit cast's **full environment**, with the config's `env` winning on conflicts: an API key exported in your shell reaches the server without duplicating it in the config. (The MCP SDK's default is a minimal whitelist; cast overrides it because a server that works when launched by hand should work identically under cast.)

**remote (`url`):**

| Field | Description |
|-------|-------------|
| `url` | Server endpoint URL |

Remote servers are connected over **Streamable HTTP** first; if the server rejects it (legacy servers answer the initialize POST with an HTTP error), cast retries once over the deprecated **HTTP+SSE** transport, so old `/sse` endpoints (e.g. Cloudflare's docs server) work with the same one-line config. Timeouts are not retried: a hung endpoint is hung on either transport.
| `headers` | HTTP headers for auth (a static token); for OAuth see [Signing in](#signing-in-oauth) |

Each server needs either `command` (local) or `url` (remote), not both.

## Tool Naming

MCP tools are namespaced as `mcp_<server>_<tool>`:

- Server `context7`, tool `resolve-library-id` → `mcp_context7_resolve-library-id`
- Server `my-server`, tool `search` → `mcp_my-server_search`

Non-alphanumeric characters in names are replaced with `_`.

## Resources

A server can offer more than tools: **resources**, the documents, files or records it can show (a docs or wiki server is often only that). A server that declares the `resources` capability gets two tools beside its own:

| Tool | What it does |
|------|--------------|
| `mcp_<server>_list_resources` | The server's resources with their URIs, names, types and sizes, and its resource templates (`docs://faq/{topic}`) |
| `mcp_<server>_read_resource` | Reads one resource by its `uri`: text as it is, an image as an image, any other binary content only described (type and size) |

The model lists, then reads; a URI built from a template reads like any other. A long listing is followed across pages and cut at 200 entries; what is read is cut at the same limits as any tool output (`maxToolOutputBytes`, `maxToolOutputLines`). They are namespaced like the server's other tools, so a persona's `mcp:` allowlist, `/mcp disable` and a reconnect treat them the same way, a subagent has them under the same rules, and `<available_mcp>` marks the server `resources="true"`. `/mcp list` shows `+ resources` beside the tool count. A tool the server already has under one of those names (servers that predate resources often do) keeps its name and wins.

A server with only resources, or only prompts, has no `tools/list`: it connects with no tools of its own and not as a failed server.

**`@`-mentions.** Write `@<server>:<uri>` in a message (`@docs:file:///docs/readme.md`) and cast reads that resource before the model's first request and hands it over with the message, so the model has it without a call. The server name is the one the tools use (cleaned the way tool names are). A mention counts at the start of a word, so `ann@host:8080` is left alone; at most five per message; a server the persona may not use is skipped; a resource that cannot be read is reported to the model as such.

**Changes.** From a server that offers subscriptions, cast subscribes to each resource the model reads. When the server says one changed, the model is told once, on your next message, which ones, and decides whether to read them again.

## Prompts

A server that declares prompts (ready-made, parameterised requests) gets one slash command per prompt: `/mcp:<server>:<prompt> [arguments]`. They show in the `/` palette with the argument names as a hint, and `/mcp list` shows `+ N prompts`. Running one asks the server to render it (`prompts/get`), and the messages it returns are sent as your next message, so the model answers them like anything you typed.

Arguments are positional or named, in the order the prompt declares them: `/mcp:everything:args-prompt Tokyo state=Japan`. Quote a value with spaces (`code="x = 1"`). A missing required argument is reported with the server's own wording and nothing is sent. A prompt does not run while a turn is running.

Offered in the web UI, in the terminal (attached to the daemon, it uses its own connection to the server), over ACP (the editor's command list, sent again when a server's prompts change) and in `cast run` as a `command` action (`{"type":"command","name":"mcp:docs:review","args":" code"}`).

## What a server sends and asks

- **Changes to its lists.** A server that says its tools or prompts changed (`list_changed`) has them read again and swapped in place: the next turn has the new tools, `/` the new prompts, and no connection is restarted. Over Streamable HTTP this needs the server's listening stream, which cast opens only for a server that declares it sends such things (list changes, resource updates, logging); a server that does not declare them keeps the plain behaviour that avoids hangs with some servers.
- **Progress.** A long call that reports progress shows `[3/10 message]` on its row in the terminal and a progress bar on its card in the web UI, and does not hit the request timeout while it keeps reporting.
- **Logs.** A server's own log is kept (the last 200 lines at level `info` and above); `/mcp logs <name>` shows the last 50.
- **Roots.** Servers are told the working folder (`roots/list`): the session's folder for a project's servers, the folder cast was started in for the shared set.
- **Structured output.** A tool that returns only `structuredContent` is shown as that JSON.
- **Sampling.** A server may ask for a model answer while one of its tools runs. It is asked of you first, as the same confirmation a dangerous command gets (it names the server and the start of the request), and runs on your current model and provider; in a mode that never asks (`bypass`) it runs, and where nobody can be asked (`cast run`, ACP without a client answer) it is refused. A request outside a running tool call is refused too.
- **Questions for you (elicitation).** A server may ask for input while a tool runs: a form of text, number, yes/no and choice fields. The web UI shows it as a card (required fields marked, checked before it is sent), the terminal asks field by field; Submit, Decline and Cancel are all answers the server can handle. Left unanswered for five minutes, or when the call ends, it is cancelled. `cast run` and ACP decline it. A server asking you to open a URL is declined.

## Signing in (OAuth)

A remote server that wants OAuth answers `401`; the connect error then says `run /mcp auth <name>` (not when an `Authorization` header is configured: that `401` is a bad token). `/mcp auth <name>` prints an address; open it, sign in, and the browser comes back to `http://127.0.0.1:33418/callback` on the machine running cast, which finishes the login and reconnects the server. If the browser is on another machine (cast on a server), copy the address it ends at (it will not load) and run `/mcp auth <name> <that address>`. Port 33418 is fixed because the client registers it with the server once; free it if it is busy.

The login (token, refresh token, registered client) is kept in `~/.cast/mcp-auth.json` (mode 600), per server and address, and is refreshed on its own. `/mcp logout <name>` forgets it. A login is never started by a connect: only by `/mcp auth`.

## Connection

Servers connect in parallel during startup. Each gets a 30-second timeout, enough for `npx -y` cold cache resolution (~12s) without leaving a hung server unnoticed.

Failed connections produce a diagnostic message but don't block other servers or prevent cast from starting.

A server that drops after connecting is retried automatically: five attempts
over roughly half a minute, backing off 1s/2s/4s/8s/16s, which rides out a
server restarting itself. A refusal is not retried: when the endpoint answers
`401`/`403` or "invalid authorization", no amount of retrying changes the
answer, so cast says once what to fix and waits for
`/mcp reconnect <server>`.

## CLI Flags

| Flag | Description |
|------|-------------|
| `--mcp <path>` | Load an extra MCP config file (repeatable) |
| `--no-mcp` | Skip global/project MCP server discovery |

```bash
cast --mcp ./custom-mcp.json
cast --no-mcp --mcp ~/.cast/mcp.json
```

Extra paths (`--mcp`) work even with `--no-mcp`.

## Commands

| Command | Description |
|---------|-------------|
| `/mcp` | Toggle MCP servers on/off (multi-select picker) |
| `/mcp list` | Read-only list (origin + tools/status) |
| `/mcp enable` / `disable <name>` | Toggle one server without the picker |
| `/mcp uninstall` | Remove a server from global/project `mcp.json` (picker + confirm, or typed name) |
| `/mcp logs <name>` | The last lines the server logged |
| `/mcp auth <name> [address]` | Sign in to a remote server with OAuth (see above) |
| `/mcp logout <name>` | Forget that sign in |
| `/mcp help` | Cheat sheet |
| `/reload` | Reconnect MCP servers (re-reads config files) |

`/mcp uninstall` edits the owning config file (project wins over global for the same name). CLI `--mcp` paths are not removable here.

### Hot-reload

`/mcp` toggle / `enable` / `disable` / `uninstall` reconnect servers **in the current session** (no `/reload`, no restart). They touch only the servers that differ: switching one off or on, or reloading, leaves every other server running (a browser server keeps its page, a stateful one its state). A server that is up on an unchanged config is not restarted; one whose command, arguments, environment or address were edited, one that is down, and one named in `/mcp reconnect <name>` are connected afresh from the file as it is now, so fixing a broken entry and running `/mcp reconnect` is enough. `/reload` does the same for the whole set.

A daemon (the web UI, `cast server`) keeps one shared set, from `~/.cast/mcp.json` and the project it was started in under that project's trust decision. A session in another folder adds that folder's own `.cast/mcp.json` servers (only if you trusted the folder), for that folder's sessions alone; an untrusted project's servers are never started, however `/mcp` is used from its sessions.

When the agent itself writes or edits `~/.cast/mcp.json` or `.cast/mcp.json` (the `write` and `edit` tools), cast connects the new servers at once: they appear in `/mcp` and the agent has their tools on the next turn, no `/reload` and no restart. Use `/reload` after editing those files by hand or by any other program. Attached to the daemon, `/reload` reloads the daemon too, so the list and the agent's tools agree. See [Interactive commands](interactive-commands.md#hot-reload-vs-reload).

### Toggling Servers

`/mcp` opens an interactive multi-select picker showing all configured servers (global + project). Use **up/down** to navigate, **Space** to toggle a server on/off, and **Enter** to confirm.

Disabled servers:

- Are disconnected immediately (hot-swap, no restart needed)
- Are hidden from the model: their tools disappear from the system prompt
- Are persisted in `~/.cast/settings.json` (they stay disabled across sessions and `/reload`)
- Can be re-enabled at any time by running `/mcp` again

The picker shows all servers from all config sources, regardless of connection status:

- `serverName (N tools)`: connected and enabled
- `serverName (disconnected)`: enabled but failed to connect
- `serverName (disabled)`: toggled off by the user

## Limitations

- **Transports**: stdio and Streamable HTTP are primary. Cast also retries a failed Streamable HTTP initialization once through legacy HTTP+SSE for older servers; new server deployments should use Streamable HTTP.
- **Auth**: a static header/token, or OAuth through `/mcp auth` (authorization code with PKCE and dynamic client registration; no client credentials or enterprise flows).
- **Tool output**: Text, images, resource links, embedded resources and structured output are handled. Audio content is noted but omitted.
- **Prompts** are run by you as `/mcp:<server>:<prompt>`, never called by the model; their arguments are not auto-completed (`completion/complete`).
- **Not supported**: tasks (the experimental long-running call protocol), a server asking you to open a URL (URL-mode elicitation), roots following a session that moves into a worktree.
