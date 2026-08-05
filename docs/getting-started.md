# Getting Started

## Requirements

- **Node.js 22+**
- An OpenAI-compatible API endpoint (OpenRouter, OpenAI, Ollama, vLLM, LiteLLM, or your own)

## Install

macOS / Linux:

```bash
curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

Windows (PowerShell):

```powershell
irm https://aa-blinov.github.io/cast/install.ps1 | iex
```

Self-contained bundle with no npm packages needed at runtime.

Pin a version:

```bash
CAST_VERSION=0.1.0 curl -fsSL https://aa-blinov.github.io/cast/install | bash
```

Upgrade later:

```bash
cast upgrade
```

## Quick Start

```bash
# Launch (prompts for provider URL and API key on first run)
cast

# One-shot prompt
cast "explain what this project does"

# Specific model and reasoning
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"

# Resume last session
cast -c
```

## Provider Setup

On first run, cast asks for your provider URL and API key, then saves both to `~/.cast/settings.json`. No `.env` file needed.

Supported environment variables (provider credentials are read from `settings.json` or `/provider`, not env):

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Path to the bash executable for the `bash` tool (Windows: non-standard Git Bash / msys2) |
| `CAST_VERSION` | Pin install version (installer only) |
| `CAST_WEB_PORT` | Override Web UI port (default: `1337`) |
| `CAST_WEB_HOST` | Override Web UI host bind address (default: `127.0.0.1`) |
| `CAST_SESSIONS_DB` | Override SQLite session database path |

Works with anything that speaks the OpenAI API:

- **OpenRouter**: `https://openrouter.ai/api/v1`
- **OpenAI**: `https://api.openai.com/v1`
- **Ollama**: `http://localhost:11434/v1`
- **vLLM / LiteLLM**: your local endpoint
- **Azure OpenAI**: your deployment URL

## What Happens on First Run

When launched without a saved configuration, an interactive setup flow configures the harness:

1. **Persona selection**: Select the agent role (defaults to `senior`).
2. **Provider connection**: Enter API endpoint URL and key, validated via `/v1/models`.
3. **Model selection**: Select a model fetched from the provider list.
4. **Reasoning level**: Configure reasoning effort or request shape (`/reasoning-format`).
5. **Session**: A new session starts automatically.

Subsequent launches remember choices and enter the TUI directly.

## Default Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Context window | 128,000 tokens | Updated from provider metadata when available |
| Max response tokens | 8,192 | Maximum tokens per assistant response |
| Compaction threshold | 75% | Triggers context compaction when usage exceeds this |
| Bash timeout | 180 seconds | Default timeout for shell commands |
| Reasoning level | `off` | Unless model metadata suggests otherwise |
| Web tools | Disabled | Enable with `/web` (persists to settings) |

## Next Steps

- [CLI Reference](cli-reference.md) for flags and subcommands
- [Interactive Commands](interactive-commands.md) for TUI commands
- [Configuration](configuration.md) for settings and layout options
