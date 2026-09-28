# Settings, permissions and self-configuration

Global settings live in `~/.cast/settings.json` (resolve the real home directory; never write a literal `~` path). It is plain JSON that cast also writes itself, so always read the whole file, change only the keys you were asked about, keep every other key, and write valid JSON back. Most keys apply from the next tool call or message, without `/reload` or a restart.

## When the agent may change them

Change settings only when the user asks for it in this conversation. Before writing, show the exact keys and values you will set, and write only after the user agrees or has already asked for exactly that change.

Never edit settings to get past something that just stopped you: a denied or declined tool call, an `ask` prompt, a hook block, `permissionMode`. Those are the user's decisions. Report the block, and let the user change the rule themselves or tell you to.

## Permission mode

`permissionMode`: `"default"` asks before dangerous shell commands (`rm -rf`, `sudo`, `git push --force`, `curl | sh` and similar); `"bypass"` asks about nothing. The user switches it with `/permissions`, or for one run with `--bypass-permissions`.

## Permission rules

```json
{
  "permissions": {
    "allow": ["bash(npm test*)", "write(docs/**)"],
    "ask": ["bash(git push*)", "write(package.json)", "mcp_github_*"],
    "deny": ["bash(git push --force*)", "write(.env*)", "edit(/etc/**)"],
    "approved": ["bash(rm -rf build)"]
  }
}
```

- A rule is `tool` or `tool(pattern)`. The pattern is matched against the command (`bash`, `ssh`), the path (`read`, `write`, `edit`, `ls`, `glob`, `grep`; relative to the project inside it, absolute outside) or the URL (`web_fetch`).
- In a command pattern `*` matches anything. In a path pattern `*` stays inside one directory and `**` crosses them. Tool names take `*` too: `mcp_github_*` is every tool of that MCP server.
- Precedence: `deny` > `approved` > `ask` > `allow`, whatever the order.
  - `deny` always blocks, bypass mode included.
  - `ask` shows the confirmation prompt. In bypass mode nobody is asked, so an `ask` rule has no effect there; only `deny` still applies. If `permissionMode` is `"bypass"`, tell the user their `ask` rules won't prompt until they switch back with `/permissions default`.
  - `allow` also answers the dangerous-command prompt in advance.
  - `approved` holds the user's "Always allow" answers. It is written by the prompt; add to it only when the user asks.
- Paths outside the project: `read`/`write`/`edit`/`ls`/`glob`/`grep` there ask first. `external_directory(<glob>)` rules on the absolute path decide instead: `allow: ["external_directory(/data/**)"]` to work in another directory freely, `deny` to wall one off. The agent's own `~/.cast/settings.json` is outside every project, so editing it asks too.
- Rules are per tool: denying `write(.env*)` does not stop `bash` writing the same file. When the user wants a path protected, suggest the matching `bash` rule too.
- Subagents follow the same rules.

When the user says "always ask before X" or "never let it Y", translate that into the smallest rule that covers it. Show the rule, then add it to the right list.

This file is the complete contract: there is no need to read cast's source to apply a rule. The steps:

1. Read `<home>/.cast/settings.json`.
2. Add or extend the `permissions` object. Create it if it is missing, and append to existing lists instead of replacing them.
3. Write the whole file back with every other key unchanged: prefer `edit` on the `permissions` part, or `write` with the full merged JSON.
4. Read it back once to check it is valid JSON, then tell the user the rules now in effect. They apply from the next tool call.

"Ask before git push, and never touch .env files" becomes:

```json
"permissions": {
  "ask": ["bash(git push*)"],
  "deny": ["write(.env*)", "edit(.env*)", "write(**/.env*)", "edit(**/.env*)", "bash(*.env*)"]
}
```

A pattern as broad as `bash(*.env*)` also blocks harmless commands that merely mention `.env`. Say so, and let the user narrow it.

## Other settings the user may ask about

| Key | Effect |
|-----|--------|
| `autoFormat` | `false` stops running the project's formatter (biome, prettier, ruff, gofmt) after `write`/`edit`. Default on |
| `lsp`, `lspAutoInstall`, `lspServers` | Language servers: the `lsp` tool and errors added to `write`/`edit` results. `lsp: false` turns them off, `lspAutoInstall: false` stops installing npm servers into `~/.cast/lsp`, `lspServers` adds or overrides one (`command`, `extensions`, `env`, `initialization`, `disabled`). `/lsp` shows what runs |
| `notifications` | `false` stops the TUI's terminal notification and bell when a turn ends or waits for approval while the terminal is unfocused |
| `keybindings` | TUI key overrides by action id, e.g. `{"input.externalEditor": "ctrl+o"}`; `[]` unbinds. `/keys` shows the keys in effect. Read at TUI start |
| `maxToolOutputLines`, `maxToolOutputBytes` | Tool result caps. A cut result's full output is saved under `~/.cast/tool-output/` and the result names the file. `bash` shows at most 32000 characters (start and end) and `read` 50KB, unless `maxToolOutputBytes` is set |
| `webTools` | Web search/fetch tools; the user toggles them with `/web` |
| `disabledSkills`, `disabledMcpServers`, `disabledHooks` | Managed by `/skills`, `/mcp`, `/hooks`; prefer the commands |

Providers, API keys and the server password are also in this file. Never print them, and change them only through `/provider` or the web Settings.

Full reference: `docs/configuration.md`.
