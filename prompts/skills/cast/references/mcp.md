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

Same command shape as skills: `/mcp` toggle, `list`, `enable`/`disable <name>`, `uninstall` (confirm), `help`. Disabled servers persist in `disabledMcpServers`. Only enabled servers appear in `<available_mcp>`.

`/mcp uninstall` removes a server from global or project `mcp.json`. CLI `--mcp` paths are not removable here.
