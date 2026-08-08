# Configuration

## Settings File

User settings are persisted to `~/.cast/settings.json`. This file is loaded on startup and saved after changes (model switch, reasoning change, persona change, etc.).

### Settings Schema

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Last used model |
| `modelProvider` | string | Saved-provider name for `model` (falls back to the active provider) |
| `subagentModel` | string | Model for sub-agents (falls back to `model`) |
| `subagentModelProvider` | string | Saved-provider name for `subagentModel` |
| `planModel` | string | Model used while plan mode is active (falls back to `model`) |
| `planModelProvider` | string | Saved-provider name for `planModel` |
| `reasoningLevel` | string | Last used reasoning level |
| `persona` | string | Last used persona name |
| `providerUrl` | string | Active provider endpoint URL |
| `apiKey` | string | Active provider API key |
| `providers` | Provider[] | Saved providers (`name`, `url`, `apiKey`, optional `reasoningFormat`) — use `/provider` to manage |
| `cwd` | string | Last working directory |
| `permissionMode` | `"default"` \| `"bypass"` | Bash confirmation mode |
| `projectTrust` | Record<string, boolean> | Per-project trust decisions |
| `theme` | string | Active color theme id |
| `webTools` | boolean | Whether web tools are enabled (default: `false` — use `/web` to enable) |
| `searchProvider` | `"ddg"` \| `"tavily"` \| `"brave"` | `web_search` backend (default: `"ddg"`) — use `/web-search-provider` to change |
| `tavilyApiKey` | string | API key for the Tavily backend, from https://app.tavily.com |
| `braveApiKey` | string | API key for the Brave Search backend, from https://api-dashboard.search.brave.com |
| `webFetchProvider` | `"jina"` \| `"local"` | `web_fetch` backend (default: `"jina"`) — use `/web-fetch-provider` to change |
| `disabledMcpServers` | string[] | MCP server names disabled via `/mcp` toggle |
| `disabledSkills` | string[] | Skill names disabled via `/skills` toggle |
| `disabledHooks` | string[] | Content-derived hook group ids disabled via `/hooks` |
| `enabledPlugins` | Record<string, boolean> | Marketplace plugins keyed by `name@marketplace` |
| `statusBar` | object | Status bar segment config (`visible`, `order`, `sides`) — use `/statusbar` to configure |
| `webPassword` | string | Password generated for `cast server` on first start |
| `quickSessionPersona` | string | Persona selected by the web UI's Quick session action |
| `updatedAt` | string | Auto-updated timestamp |

Settings are written atomically (temp file + rename) to prevent corruption from crashes mid-write.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Path to the bash executable the `bash` tool spawns (overrides auto-detection; useful for msys2 or non-standard Git Bash installs on Windows) |
| `CAST_VERSION` | Pin install version (installer only) |

Provider URL and API key are configured **only** via `~/.cast/settings.json` (first-run prompt, or `/provider` in-session). cast does not read `PROVIDER_BASE_URL` / `PROVIDER_API_KEY` environment variables or a project `.env` — editing those changes nothing.

## .cast/ Directory Structure

```
~/.cast/
  settings.json         # User settings
  AGENTS.md             # Global context file (optional)
  mcp.json              # Global MCP server config
  sessions/sessions.db  # SQLite session database (legacy JSON files are imported once)
  skills/               # Global skills
  plugins/              # Marketplace catalogs + installed plugins (see plugins.md)
  rules/                # Global rules
  personas/             # Global personas

~/.agents/skills/          # skills.sh universal global
~/.config/agents/skills/   # Compatible universal-global location

<project>/.cast/
  plans/<session-id>/   # Session plan files
  skills/               # Project-local skills
  rules/                # Project-local rules
  personas/             # Project-local personas
  mcp.json              # Project-local MCP config
  hooks.json            # Project-local hooks
  ssh.json              # Project-local SSH hosts

<project>/.agents/skills/  # skills.sh universal project (npx skills add -a universal)
```

## Project Trust

A single trust decision gates all project-local resources: skills (`.cast/skills/` and `.agents/skills/`), MCP servers, context files, personas, rules, hooks, and `.cast/ssh.json`. cast asks once per project; the decision is saved in `settings.json` under `projectTrust`.

Global resources (`~/.cast/`, `~/.agents/skills/`, `~/.config/agents/skills/`) always load without a trust check — you put them there yourself.

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Dangerous bash commands require confirmation |
| `bypass` | All bash commands run without confirmation |

Change with:
- `--bypass-permissions` flag (this run only)
- `/permissions` command (persists to settings)
- `/permissions default` or `/permissions bypass` (direct set)

See [Tools](tools.md#dangerous-command-gating) for the list of dangerous patterns.

## Provider Configuration

On first run, cast asks for your provider URL and API key. Both are saved to `~/.cast/settings.json`.

You can save multiple providers and switch between them:

| Command | Action |
|---------|--------|
| `/provider` | Open picker — switch between saved providers |
| `/provider add` | Add a new provider (name → URL → key wizard) |
| `/provider delete` | Remove a saved provider |
| `/provider <name>` | Switch to a named provider directly |

Providers are stored in the `providers` array in settings.json. The active provider's URL and key are also saved in the top-level `providerUrl` / `apiKey` fields for startup.

Supported providers: anything that speaks the OpenAI API. Common URLs:

| Provider | URL |
|----------|-----|
| OpenRouter | `https://openrouter.ai/api/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Ollama | `http://localhost:11434/v1` |
