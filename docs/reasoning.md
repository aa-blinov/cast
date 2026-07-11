# Reasoning

Reasoning levels control how much "thinking" a model does before responding. Models that support reasoning (detected from OpenRouter `/v1/models` metadata) can be configured with different effort levels.

## Levels

| Level | Description |
|-------|-------------|
| `off` | No reasoning — standard completion |
| `low` | Minimal reasoning |
| `medium` | Balanced reasoning (often the default) |
| `high` | Deep reasoning |
| `max` | Maximum reasoning effort |

For models that report reasoning as a binary toggle (on/off without effort levels), the options are simply `off` and `on`.

## Setting the Level

### CLI

```bash
cast -r high "refactor this function"
cast --reasoning medium "explain the session module"
```

### Interactive

```
/reasoning
```

Opens a picker if the model supports reasoning controls. If the provider doesn't expose reasoning metadata, a message explains that the model uses its own default.

### Saved

The reasoning level is saved to `~/.cast/settings.json` per model. Switching models triggers a new reasoning selection if the new model supports different options.

## How Reasoning Metadata is Discovered

cast fetches the model list from your provider's `/v1/models` endpoint. OpenRouter-compatible providers include a `reasoning` field per model:

```json
{
  "id": "qwen/qwen3-235b-a22b",
  "reasoning": {
    "mandatory": false,
    "default_enabled": true,
    "supported_efforts": ["high", "medium", "low"],
    "default_effort": "medium"
  }
}
```

cast reads this metadata to determine:
- Whether the model supports reasoning at all
- Whether it's a binary toggle or supports effort levels
- Which efforts are available
- What the default is

No vendor detection, no overrides — the API tells cast everything.

## Think Block Parsing

Some models (Qwen, DeepSeek) output reasoning in `<think>` blocks rather than through a structured API field. cast parses these blocks automatically:

```
<think>
Let me analyze this step by step...
</think>

Here's my analysis...
```

The thinking content is displayed separately in the TUI and excluded from the main response.

## Provider Behavior

When reasoning is set to `off`, cast sends `reasoning: { enabled: false }` explicitly. Some models (like OpenRouter's `default_enabled: true` ones) reason by default when the key is omitted — an empty body doesn't turn reasoning off.

When the provider doesn't report reasoning capabilities (`unknown`), cast sends no reasoning params, letting the provider use its own default.
