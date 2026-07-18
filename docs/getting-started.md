# Getting Started

## Requirements

- **Node.js 18+**
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

Self-contained bundle — no npm packages needed at runtime.

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
# Launch — prompts for provider URL + API key on first run, remembers after
cast

# One-shot prompt
cast "explain what this project does"

# Specific model + reasoning
cast -m qwen/qwen3-235b-a22b -r high "refactor this function"

# Resume last session
cast -c
```

## Provider Setup

On first run, cast asks for your provider URL and API key, then saves both to `~/.cast/settings.json`. No `.env` file needed.

Supported environment variables (provider credentials are **not** read from env — use the settings file or `/provider`):

| Variable | Description |
|----------|-------------|
| `CAST_CWD` | Override working directory |
| `CAST_BASH` | Path to the bash executable for the `bash` tool (Windows: non-standard Git Bash / msys2) |
| `CAST_VERSION` | Pin install version (installer only) |

Works with anything that speaks the OpenAI API:

- **OpenRouter**: `https://openrouter.ai/api/v1`
- **OpenAI**: `https://api.openai.com/v1`
- **Ollama**: `http://localhost:11434/v1`
- **vLLM / LiteLLM**: your local endpoint
- **Azure OpenAI**: your deployment URL

## What Happens on First Run

When you launch `cast` without a saved configuration, an interactive onboarding flow walks you through setup:

1. **Persona selection** — choose the agent's role (coding, senior dev, QA, etc.). This sets the system prompt but not the tools. Defaults to `coding`.

2. **Provider connection** — enter your API endpoint URL and API key. cast validates both by hitting `/v1/models`. Saved to `~/.cast/settings.json`.

3. **Model selection** — cast fetches the model list from your provider and lets you pick one. The selection is validated with a test prompt.

4. **Reasoning level** — if the model supports reasoning (detected from OpenRouter metadata), choose a level: `off`, `low`, `medium`, `high`, or `max`. Binary-toggle models offer `on`/`off` instead.

5. **Session** — a new session starts automatically. Every conversation auto-saves.

After the first run, all choices are remembered. Subsequent launches go straight to the TUI.

## Default Configuration

These defaults apply unless overridden:

| Setting | Default | Description |
|---------|---------|-------------|
| Context window | 128,000 tokens | Updated from provider metadata when available |
| Max response tokens | 8,192 | Maximum tokens per assistant response |
| Compaction threshold | 75% | Triggers context compaction when usage exceeds this |
| Bash timeout | 180 seconds | Default timeout for shell commands |
| Reasoning level | `off` | Unless the model's metadata suggests otherwise |
| Web tools | Disabled | Enable with `/web` (persists to settings) |

## Next Steps

- [CLI Reference](cli-reference.md) — all flags and subcommands
- [Interactive Commands](interactive-commands.md) — what you can type in the TUI
- [Configuration](configuration.md) — settings.json, env vars, .cast/ layout
