MCP (Model Context Protocol) servers provide external tools.

**Locations** (on name collision, last-loaded wins — reverse of skills/personas):

1. `~/.cast/mcp.json` — global
2. `.cast/mcp.json` — project (trust-gated)
3. `--mcp <path>` — extra CLI paths (loaded last, highest priority)

Global servers load first, project and CLI override them on name collision.

**File format** — common `mcpServers` JSON shape:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "API_KEY": "..." },
      "cwd": "/optional/working/dir"
    },
    "remote-server": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

**Transports:** stdio (local process — `command`+`args`+`env`+`cwd`) and streamable HTTP (remote — `url`+`headers`, static-header auth only, no OAuth).

**Tool names** are namespaced as `mcp_<server>_<tool>` to avoid collisions.

**Resources:** a server that declares them gets `mcp_<server>_list_resources` (resources with URIs, and templates) and `mcp_<server>_read_resource` (by `uri`) beside its own tools; a server with only resources connects with no tools. `/mcp list` shows `+ resources`. Subscriptions and `@`-mentions are not supported.

**Prompts:** a server that declares them gets `/mcp:<server>:<prompt> [args]` commands (positional or `name=value`, quote values with spaces); the server renders the prompt and the result is sent as the user's next message. The model does not call them; not available over ACP or `cast run`.

Same command shape as skills: `/mcp` toggle, `list`, `enable`/`disable <name>`, `uninstall` (confirm), `help`. Disabled servers persist in `disabledMcpServers`. Only enabled servers appear in `<available_mcp>`.

`/mcp uninstall` removes a server from global or project `mcp.json`. CLI `--mcp` paths are not removable here.
