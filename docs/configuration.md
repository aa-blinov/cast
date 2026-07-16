# Configuration

## Settings File

User settings are persisted to `~/.cast/settings.json`. This file is loaded on startup and saved after changes (model switch, reasoning change, persona change, etc.).

### Settings Schema

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Last used model |
| `subagentModel` | string | Model for sub-agents (falls back to `model`) |
| `planModel` | string | Model used while plan mode is active (falls back to `model`) |
| `reasoningLevel` | string | Last used reasoning level |
| `persona` | string | Last used persona name |
| `providerUrl` | string | Active provider endpoint URL |
| `apiKey` | string | Active provider API key |
| `providers` | Provider[] | Saved providers (name, url, apiKey) — use `/provider` to manage |
| `cwd` | string | Last working directory |
| `permissionMode` | `"default"` \| `"bypass"` | Bash confirmation mode |
| `projectTrust` | Record<string, boolean> | Per-project trust decisions |
| `theme` | string | Active color theme id |
| `webTools` | boolean | Whether web tools are enabled (default: `false` — use `/web` to enable) |
| `disabledMcpServers` | string[] | MCP server names disabled via `/mcp` toggle |
| `statusBar` | object | Status bar segment config (`visible`, `order`, `sides`) — use `/statusbar` to configure |
| `updatedAt` | string | Auto-updated timestamp |

Settings are written atomically (temp file + rename) to prevent corruption from crashes mid-write.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PROVIDER_BASE_URL` | OpenAI-compatible endpoint URL |
| `PROVIDER_API_KEY` | API key |
| `CAST_CWD` | Override working directory |
| `CAST_VERSION` | Pin install version (installer only) |

Environment variables are an alternative to the settings file for provider configuration.

## .cast/ Directory Structure

```
~/.cast/
  settings.json         # User settings
  AGENTS.md             # Global context file (optional)
  mcp.json              # Global MCP server config
  sessions/             # Saved sessions (per-project subdirs)
  plans/                # Plan files (per-session subdirs)
  skills/               # Global skills
  rules/                # Global rules
  personas/             # Global personas

<project>/.cast/
  skills/               # Project-local skills
  rules/                # Project-local rules
  personas/             # Project-local personas
  mcp.json              # Project-local MCP config
```

## Project Trust

A single trust decision gates all project-local resources: skills, MCP servers, context files, and personas in `.cast/`. cast asks once per project; the decision is saved in `settings.json` under `projectTrust`.

Global resources (`~/.cast/`) always load without a trust check — you put them there yourself.

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
