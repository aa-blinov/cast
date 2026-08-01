# Reasoning

Reasoning levels control how much internal reasoning a model does before responding. Cast combines `/v1/models` metadata when an endpoint provides it with a configured provider dialect for the request shape.

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

### Provider protocol

`/reasoning-format` selects how Cast sends reasoning controls for the active saved provider. `auto` is the default and detects known endpoint hosts. Choose an explicit format when a compatible proxy uses a nonstandard host or needs a forced protocol.

Supported formats include OpenAI (`reasoning_effort`), OpenRouter (`reasoning.effort`), DeepSeek, Kimi, Qianfan, Qwen/DashScope, Together, xAI, Z.ai, Huawei ModelArts, and MiniMax. Generic OpenAI-compatible endpoints receive a conservative `reasoning_effort` request when reasoning is enabled and no control when it is off.

### Saved

The reasoning level is saved to `~/.cast/settings.json` per model. Switching models triggers a new reasoning selection if the new model supports different options.

## How Reasoning Metadata is Discovered

Cast fetches the model list from the configured provider's `/v1/models` endpoint. OpenRouter exposes a rich `reasoning` field per model:

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

When present, Cast reads this metadata to determine:
- Whether the model supports reasoning at all
- Whether it's a binary toggle or supports effort levels
- Which efforts are available
- What the default is

Many OpenAI-compatible providers omit this metadata. Their request dialect is still selected from the provider configuration, so their native reasoning controls and streaming reasoning fields can be normalized for the TUI and web UI.

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

The exact off request depends on the selected dialect. For example, OpenRouter receives `reasoning: { enabled: false }`, OpenAI receives `reasoning_effort: "none"`, and providers that use a `thinking` flag receive their native disabled value. MiniMax reasoning is always enabled; Cast requests its split-reasoning stream format so reasoning and answer text remain separate.

When the provider doesn't report reasoning capabilities (`unknown`), cast sends no reasoning params, letting the provider use its own default.
